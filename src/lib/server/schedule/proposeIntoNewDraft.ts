/**
 * Backs the "Create automatic schedule" button on /schedule (routes/schedule/+page.server.ts):
 * makes a new draft and fills it with the deterministic engine's proposal. Key rule:
 * everything it writes is PROPOSED and attached to the new draft — nothing is approved
 * until a person approves it.
 */
import { prisma } from '$lib/server/prisma';
import { proposeSchedule } from '$lib/server/engine/proposeSchedule';
import { ScheduleAssignmentStatus, ScheduleStrategy } from '../../../../prisma/generated/prisma/enums';
import { fetchBacklog, fetchStaffedCapacity } from './buildBacklogAndCapacity';
import { createDraft } from './draft';
import type { DateRange } from './types';

/** A Date as its "YYYY-MM-DD" UTC day. */
function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" plus `days` calendar days, as "YYYY-MM-DD". */
function addDays(isoDate: string, days: number): string {
	const date = new Date(`${isoDate}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return iso(date);
}

// "3-4 weeks out" — the same window CLAUDE.md's Production Board section already picked
// (its 28-day default) for showing what's coming up; reused here as the automatic
// schedule's window rather than inventing a second convention.
const AUTOMATIC_SCHEDULE_WEEKS = 4;

/** What the button reports back: the new draft's id and how many jobs did / didn't fit. */
export interface ProposeIntoNewDraftResult {
	draftId: string;
	placedCount: number;
	atRiskCount: number;
	reasoning: string[];
}

/**
 * "Create automatic schedule" — a brand-new ScheduleDraft populated straight from the
 * deterministic propose_schedule engine (fetchBacklog + fetchStaffedCapacity + proposeSchedule),
 * the exact same engine the propose_schedule MCP tool already calls when Claude runs it
 * in conversation. No LLM decides any placement here — CLAUDE.md's non-negotiable design
 * principle ("Claude never computes hours or schedules itself") applies just as much to
 * this button as it does to chat. This only wires that existing engine into the drafts
 * workspace, which previously supported manual placement only: its output now lands in
 * an editable, reviewable draft (scheduleDraftId set on every row) instead of loose
 * PROPOSED rows with no draft at all, which is what the `propose_schedule` MCP tool still
 * does on its own (see proposeAndPersistSchedule.ts) — that tool is untouched by this.
 *
 * fetchBacklog() already enforces every scheduling gate (order CONFIRMED, deadline today
 * or later — see its doc comment for the full, current list) — this function does not
 * add or loosen any of that.
 *
 * The window is always today plus AUTOMATIC_SCHEDULE_WEEKS (UTC days).
 *
 * @param actor - who clicked the button (draft creator, proposedBy, audit log)
 */
export async function proposeIntoNewDraft(actor: string): Promise<ProposeIntoNewDraftResult> {
	const startIso = iso(new Date());
	const endIso = addDays(startIso, AUTOMATIC_SCHEDULE_WEEKS * 7 - 1);
	const range: DateRange = { from: startIso, to: endIso };

	const draft = await createDraft(
		{
			name: `Automatic schedule — ${startIso}`,
			description: 'Proposed by the propose_schedule engine from confirmed, approval-gated orders.',
			startDate: startIso,
			weeks: AUTOMATIC_SCHEDULE_WEEKS,
			strategy: ScheduleStrategy.BATCH_OPTIMIZE
		},
		actor
	);

	const { backlog, externalDependencies } = await fetchBacklog();
	// Each (station, day) staffed from the roster (planStaffing.ts, 2026-09-28).
	const capacity = await fetchStaffedCapacity(range, backlog);
	const result = proposeSchedule(backlog, capacity, externalDependencies);

	// Each placement's wall-clock start comes straight from the engine now (2026-09-23):
	// it packs every station's day back-to-back in batch order, skipping breaks — same
	// layout this file used to compute afterward — but it also has to hold a finisher
	// until its print's end time, which only the engine knows while it's placing jobs.

	await prisma.$transaction(async (tx) => {
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
				diff: { placedCount: result.assignments.length, atRiskCount: result.atRisk.length, range }
			}
		});
	});

	return {
		draftId: draft.id,
		placedCount: result.assignments.length,
		atRiskCount: result.atRisk.length,
		reasoning: result.reasoning
	};
}
