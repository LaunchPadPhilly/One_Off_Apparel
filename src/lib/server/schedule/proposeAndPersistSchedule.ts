import { prisma } from '$lib/server/prisma';
import { proposeSchedule } from '$lib/server/engine/proposeSchedule';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import { fetchBacklog, fetchCapacity } from './buildBacklogAndCapacity';
import type { DateRange } from './types';

export interface ProposeAndPersistResult {
	assignments: Awaited<ReturnType<typeof persistProposal>>;
	atRisk: ReturnType<typeof proposeSchedule>['atRisk'];
	reasoning: string[];
}

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
					proposedBy
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
 */
export async function proposeAndPersistSchedule(range: DateRange, proposedBy: string): Promise<ProposeAndPersistResult> {
	const [{ backlog, externalDependencies }, capacity] = await Promise.all([fetchBacklog(), fetchCapacity(range)]);
	const result = proposeSchedule(backlog, capacity, externalDependencies);

	const touchedLineItemIds = [...result.assignments.map((a) => a.lineItemId), ...result.atRisk.map((a) => a.lineItemId)];
	const assignments = await persistProposal(result.assignments, touchedLineItemIds, proposedBy);

	return { assignments, atRisk: result.atRisk, reasoning: result.reasoning };
}
