/**
 * The `propose_schedule` MCP tool's implementation (registered in mcp/tools.ts): runs the
 * deterministic engine and saves its output as PROPOSED rows (no draft attached).
 * Key rule: it only ever writes or deletes PROPOSED rows — never the approved schedule.
 */
import { prisma } from '$lib/server/prisma';
import { proposeSchedule } from '$lib/server/engine/proposeSchedule';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import { fetchBacklog, fetchStaffedCapacity } from './buildBacklogAndCapacity';
import type { DateRange } from './types';

/** The saved PROPOSED rows, the jobs that couldn't be placed, and the engine's explanation. */
export interface ProposeAndPersistResult {
	assignments: Awaited<ReturnType<typeof persistProposal>>;
	atRisk: ReturnType<typeof proposeSchedule>['atRisk'];
	reasoning: string[];
}

/**
 * Saves the engine's placements as PROPOSED rows (plus an audit-log entry each), in one
 * transaction, after clearing older PROPOSED rows for every line item this run looked at.
 */
async function persistProposal(
	proposed: ReturnType<typeof proposeSchedule>['assignments'],
	touchedLineItemIds: readonly string[],
	proposedBy: string
) {
	return prisma.$transaction(async (tx) => {
		// Replace any stale draft for a line item we just re-proposed — propose_schedule
		// is meant to be rerun (e.g. daily), not to accumulate duplicate drafts for the
		// same job. Only PROPOSED rows are cleared; an already-APPROVED+ assignment is
		// the live schedule and this tool never touches that (see CLAUDE.md: "never
		// writes to the live schedule").
		await tx.scheduleAssignment.deleteMany({
			where: { lineItemId: { in: [...touchedLineItemIds] }, status: ScheduleAssignmentStatus.PROPOSED }
		});

		const created = [];
		for (const assignment of proposed) {
			const row = await tx.scheduleAssignment.create({
				data: {
					lineItemId: assignment.lineItemId,
					stationId: assignment.stationId,
					date: assignment.date,
					sequenceOrder: assignment.sequenceOrder,
					startMinuteOfDay: assignment.startMinuteOfDay,
					estimatedHours: assignment.estimatedHours,
					status: ScheduleAssignmentStatus.PROPOSED,
					proposedBy,
					// The day's crew on this station (planStaffing.ts, 2026-09-28).
					crew: { create: assignment.crewWorkerIds.map((workerId) => ({ workerId })) }
				}
			});
			created.push(row);

			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: row.id,
					action: 'schedule_proposed',
					actor: proposedBy,
					diff: { lineItemId: row.lineItemId, stationId: row.stationId, date: row.date, estimatedHours: row.estimatedHours }
				}
			});
		}
		return created;
	});
}

/**
 * The `propose_schedule` MCP tool's implementation — distinct from the pure
 * `proposeSchedule` engine function it wraps. "Never writes to the live schedule"
 * (CLAUDE.md) means never writes APPROVED+ rows; this persists the engine's output as
 * PROPOSED rows so commit_schedule has real ids to act on (see CLAUDE.md's
 * commit_schedule signature: `commit_schedule(assignment_ids[], approved_by)`). A
 * PROPOSED row is a draft, not yet real/scheduled — get_schedule doesn't return it, and
 * the Production Board wouldn't either.
 *
 * @param range - the window to schedule into
 * @param proposedBy - who asked (stored on each row and in the audit log)
 */
export async function proposeAndPersistSchedule(range: DateRange, proposedBy: string): Promise<ProposeAndPersistResult> {
	const { backlog, externalDependencies } = await fetchBacklog();
	const capacity = await fetchStaffedCapacity(range, backlog);
	const result = proposeSchedule(backlog, capacity, externalDependencies);

	// At-risk items are included too, so a job that was placed last run but can't be
	// placed now loses its old PROPOSED row instead of keeping a stale one.
	const touchedLineItemIds = [...result.assignments.map((a) => a.lineItemId), ...result.atRisk.map((a) => a.lineItemId)];
	const assignments = await persistProposal(result.assignments, touchedLineItemIds, proposedBy);

	return { assignments, atRisk: result.atRisk, reasoning: result.reasoning };
}
