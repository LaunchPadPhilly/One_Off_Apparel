/**
 * Runs the deterministic engine and saves its plan as a new draft — the shared path
 * behind the `propose_schedule` MCP tool and the board's "Create automatic schedule"
 * button (proposeIntoNewDraft.ts). Saving into a draft (2026-10-05; the MCP tool used to
 * write draft-less rows) means a plan proposed in chat shows up on the board, where a
 * person can look at it, adjust it, and approve it.
 *
 * Nothing here touches the live schedule. The plan is only PROPOSED rows in its own
 * draft; approving it (commitSchedule.ts — the second human gate) is what makes it real
 * and replaces any approved jobs it moved.
 */
import { prisma } from '$lib/server/prisma';
import { proposeSchedule } from '$lib/server/engine/proposeSchedule';
import type { AtRiskFlag } from '$lib/server/engine/types';
import { ScheduleAssignmentStatus, ScheduleStrategy } from '../../../../prisma/generated/prisma/enums';
import { buildSchedulingRun } from './committedWork';
import { createDraft } from './draft';
import type { DateRange } from './types';

/** Drafts show at most 4 weeks (draft.ts' createDraftSchema), so a plan can't be longer. */
export const MAX_PROPOSAL_DAYS = 28;

/** One line of "what this plan changes", written for a person to read. */
export interface PlanChange {
	kind: 'new' | 'moved' | 'unchanged' | 'kept_at_risk';
	lineItemId: string;
	job: string;
	from?: { station: string; date: string };
	to?: { station: string; date: string };
}

export interface ProposeAndPersistResult {
	draftId: string;
	/** The board page where people can see and approve this plan. */
	draftPath: string;
	assignmentIds: string[];
	placedCount: number;
	atRisk: AtRiskFlag[];
	changes: PlanChange[];
	reasoning: string[];
}

export interface ProposeOptions {
	range: DateRange;
	/** Approved, not-started jobs dated in this window may move. Null = move nothing. */
	release: DateRange | null;
	name: string;
	description?: string;
	actor: string;
}

function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function dayCount(range: DateRange): number {
	return Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000) + 1;
}

/** A short, readable name for a job: "100127 · Front logo (Screen print)". */
function jobLabel(item: { design: string | null; decorationType: string | null; finishingStep: string | null; otherJobType: string | null; order: { hoopsOrderId: string } }): string {
	const kind = item.decorationType ?? item.finishingStep ?? item.otherJobType ?? 'job';
	return `${item.order.hoopsOrderId} · ${item.design ?? 'untitled'} (${kind.toLowerCase().replace(/_/g, ' ')})`;
}

/**
 * Proposes a plan for `range` and saves it as a new draft.
 *
 * @throws Error when the range is backwards or longer than MAX_PROPOSAL_DAYS.
 */
export async function proposeIntoDraft(options: ProposeOptions): Promise<ProposeAndPersistResult> {
	const { range, release, actor } = options;
	const days = dayCount(range);
	if (days < 1) throw new Error(`propose_schedule: "to" (${range.to}) is before "from" (${range.from})`);
	if (days > MAX_PROPOSAL_DAYS) throw new Error(`propose_schedule: a plan can cover at most ${MAX_PROPOSAL_DAYS} days (got ${days})`);

	const run = await buildSchedulingRun(range, release);
	const result = proposeSchedule(run.backlog, run.capacity, run.externalDependencies);

	const draft = await createDraft(
		{ name: options.name, description: options.description ?? null, startDate: range.from, weeks: Math.ceil(days / 7), strategy: ScheduleStrategy.BATCH_OPTIMIZE },
		actor
	);

	const assignmentIds = await prisma.$transaction(async (tx) => {
		const ids: string[] = [];
		for (const assignment of result.assignments) {
			const row = await tx.scheduleAssignment.create({
				data: {
					lineItemId: assignment.lineItemId,
					stationId: assignment.stationId,
					date: assignment.date,
					sequenceOrder: assignment.sequenceOrder,
					startMinuteOfDay: assignment.startMinuteOfDay,
					estimatedHours: assignment.estimatedHours,
					status: ScheduleAssignmentStatus.PROPOSED,
					proposedBy: actor,
					scheduleDraftId: draft.id,
					// The day's crew on this station (planStaffing.ts, 2026-09-28).
					crew: { create: assignment.crewWorkerIds.map((workerId) => ({ workerId })) }
				}
			});
			ids.push(row.id);
			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: row.id,
					action: 'schedule_proposed',
					actor,
					diff: { lineItemId: row.lineItemId, stationId: row.stationId, date: row.date, estimatedHours: row.estimatedHours, scheduleDraftId: draft.id }
				}
			});
		}
		await tx.domainAuditLog.create({
			data: {
				entity: 'ScheduleDraft',
				entityId: draft.id,
				action: 'schedule_draft_auto_proposed',
				actor,
				diff: { placedCount: result.assignments.length, atRiskCount: result.atRisk.length, releasedCount: run.released.length, range, release }
			}
		});
		return ids;
	});

	// Describe the plan against what's approved now, so a person can see what moves.
	const lineItemIds = [...new Set([...result.assignments.map((a) => a.lineItemId), ...run.released.map((r) => r.lineItemId)])];
	const [items, stations] = await Promise.all([
		prisma.lineItem.findMany({
			where: { id: { in: lineItemIds } },
			select: { id: true, design: true, decorationType: true, finishingStep: true, otherJobType: true, order: { select: { hoopsOrderId: true } } }
		}),
		prisma.station.findMany({ select: { id: true, label: true } })
	]);
	const labelOf = new Map(items.map((item) => [item.id, jobLabel(item)]));
	const stationLabel = new Map(stations.map((station) => [station.id, station.label]));
	const releasedByItem = new Map(run.released.map((row) => [row.lineItemId, row]));

	const changes: PlanChange[] = result.assignments.map((assignment) => {
		const before = releasedByItem.get(assignment.lineItemId);
		const to = { station: stationLabel.get(assignment.stationId) ?? assignment.stationName, date: iso(assignment.date) };
		const job = labelOf.get(assignment.lineItemId) ?? assignment.lineItemId;
		if (!before) return { kind: 'new', lineItemId: assignment.lineItemId, job, to };
		const from = { station: stationLabel.get(before.stationId) ?? before.stationId, date: iso(before.date) };
		const same = before.stationId === assignment.stationId && iso(before.date) === to.date;
		return { kind: same ? 'unchanged' : 'moved', lineItemId: assignment.lineItemId, job, from, to };
	});
	// A released job the new plan couldn't fit keeps its old approved slot (approving the
	// plan doesn't remove it) — but that slot may no longer have room, so say so.
	for (const flag of result.atRisk) {
		const before = releasedByItem.get(flag.lineItemId);
		if (!before) continue;
		changes.push({
			kind: 'kept_at_risk',
			lineItemId: flag.lineItemId,
			job: labelOf.get(flag.lineItemId) ?? flag.lineItemId,
			from: { station: stationLabel.get(before.stationId) ?? before.stationId, date: iso(before.date) }
		});
	}

	return {
		draftId: draft.id,
		draftPath: `/schedule/drafts/${draft.id}`,
		assignmentIds,
		placedCount: result.assignments.length,
		atRisk: result.atRisk,
		changes,
		reasoning: result.reasoning
	};
}

/**
 * The `propose_schedule` MCP tool's implementation: a plan for `range`, saved as a
 * draft named after who asked and why.
 *
 * @param release approved, not-started jobs dated in this window may move (a rush order
 *   or someone out); null places only new work around the committed schedule.
 */
export async function proposeAndPersistSchedule(range: DateRange, proposedBy: string, release: DateRange | null = null, reason?: string): Promise<ProposeAndPersistResult> {
	return proposeIntoDraft({
		range,
		release,
		name: `${reason?.trim() ? reason.trim().slice(0, 80) : 'Proposed in chat'} — ${range.from}`,
		description: `Proposed by ${proposedBy} for ${range.from} to ${range.to}${release ? `, re-planning approved jobs from ${release.from} to ${release.to}` : ''}.`,
		actor: proposedBy
	});
}
