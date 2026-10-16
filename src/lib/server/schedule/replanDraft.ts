import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { dayLabel } from '$lib/schedule/draftProblems';
import { proposeIntoDraft, MAX_PROPOSAL_DAYS } from './proposeAndPersistSchedule';
import { describeChanges, problemsForTool } from './draftEdit';
import { loadDraftProblems } from './draftProblemsServer';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Re-runs the deterministic engine INSIDE an existing draft (2026-10-16) — for "Maria is
 * out Tuesday, fix this draft" or "redo the plan now that 100157 is confirmed", without
 * making a new draft (the client's rule: edit the draft, only make a new one when asked).
 * The draft's proposed jobs are replaced by a fresh plan over the draft's own window
 * (from today if it started earlier), taking the current roster, days out, pins and
 * committed work into account. Approved jobs in it stay, unless replanFrom/replanTo
 * releases them (same rule as propose_schedule). Hand moves made in the draft are lost —
 * Claude should say so before calling this.
 */

export class ReplanDraftError extends McpUserError {}

export const replanDraftSchema = z.object({
	draftId: z.string().min(1),
	replanFrom: z.iso.date().optional(),
	replanTo: z.iso.date().optional(),
	reason: z.string().max(200).optional()
});

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function replanDraft(input: z.infer<typeof replanDraftSchema>, actor: string) {
	if ((input.replanFrom === undefined) !== (input.replanTo === undefined)) throw new ReplanDraftError('Give both replanFrom and replanTo, or neither.');
	const draft = await prisma.scheduleDraft.findUnique({ where: { id: input.draftId } });
	if (!draft) throw new ReplanDraftError('No such draft. Try list_drafts.');

	const today = new Date();
	const todayIso = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
	const end = new Date(draft.startDate);
	end.setUTCDate(end.getUTCDate() + Math.min(draft.weeks * 7, MAX_PROPOSAL_DAYS) - 1);
	const from = iso(draft.startDate) > todayIso ? iso(draft.startDate) : todayIso;
	const to = iso(end);
	if (to < from) throw new ReplanDraftError(`This draft's window (${iso(draft.startDate)} to ${to}) is already over — propose a new plan instead.`);

	const before = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draft.id, status: ScheduleAssignmentStatus.PROPOSED },
		select: { id: true, lineItemId: true, stationId: true, date: true, startMinuteOfDay: true }
	});

	const plan = await proposeIntoDraft({
		range: { from, to },
		release: input.replanFrom && input.replanTo ? { from: input.replanFrom, to: input.replanTo } : null,
		name: draft.name,
		actor,
		intoDraftId: draft.id
	});

	const after = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draft.id, status: ScheduleAssignmentStatus.PROPOSED },
		select: { id: true, lineItemId: true, stationId: true, date: true, startMinuteOfDay: true }
	});
	const beforeByItem = new Map(before.map((row) => [row.lineItemId, row]));
	const afterItems = new Set(after.map((row) => row.lineItemId));
	const moved = after
		.map((row) => ({ row, prior: beforeByItem.get(row.lineItemId) }))
		.filter(({ row, prior }) => prior && (prior.stationId !== row.stationId || prior.date.getTime() !== row.date.getTime() || prior.startMinuteOfDay !== row.startMinuteOfDay))
		.map(({ row, prior }) => ({
			id: row.id,
			lineItemId: row.lineItemId,
			from: { stationId: prior!.stationId, date: iso(prior!.date), startMin: prior!.startMinuteOfDay ?? 480 },
			to: { stationId: row.stationId, date: iso(row.date), startMin: row.startMinuteOfDay ?? 480 }
		}));
	const changes = await describeChanges(prisma, moved);
	const droppedOff = before.filter((row) => !afterItems.has(row.lineItemId)).length;
	const added = after.filter((row) => !beforeByItem.has(row.lineItemId)).length;

	await prisma.domainAuditLog.create({
		data: {
			entity: 'ScheduleDraft',
			entityId: draft.id,
			action: 'draft_edited',
			actor,
			diff: {
				via: 'claude',
				summary: `Re-planned this draft${input.reason ? ` (${input.reason})` : ''}: ${moved.length} moved, ${added} added, ${droppedOff} taken off`,
				changes
			}
		}
	});

	const problems = await loadDraftProblems(draft.id);
	return {
		draftId: draft.id,
		draftPath: plan.draftPath,
		window: { from, to },
		placedCount: plan.placedCount,
		movedCount: moved.length,
		addedCount: added,
		takenOffCount: droppedOff,
		changes,
		unscheduledOrders: plan.unscheduledOrders,
		atRisk: plan.atRisk.map((flag) => ({ lineItemId: flag.lineItemId, reason: flag.reason, due: dayLabel(iso(flag.dueDate)) })),
		...problemsForTool({ problems })
	};
}
