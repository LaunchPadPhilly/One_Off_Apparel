import { prisma } from '$lib/server/prisma';
import { checkCompletion } from '$lib/server/engine/checkCompletion';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * The Production Board's "Stop" action. Sets `completed_at`, writes an `Actual` row
 * (`actual_hours` = completed_at − started_at, exactly as CLAUDE.md's actuals table
 * notes specify), and — if this was the last still-incomplete assignment for the line
 * item — calls `check_completion`, matching CLAUDE.md's engine section: "Runs the
 * moment the Stop button fires for the LAST station on a line item." "Last" is
 * evaluated mechanically here: the last of *that line item's own* assignments to
 * finish, not a separately documented concept.
 *
 * check_completion runs as its own follow-up call, after this function's transaction
 * commits, rather than nested inside it — it touches different rows (LineItem, Order)
 * than this transaction does (ScheduleAssignment, Actual), so there's no correctness
 * reason to force them atomic, and keeping them separate avoids relying on
 * cross-transaction lock behavior between two independent `prisma.$transaction` calls.
 */
export async function stopAssignment(assignmentId: string, stoppedBy: string) {
	const { updated, lineItemId, isLastForLineItem } = await prisma.$transaction(async (tx) => {
		const assignment = await tx.scheduleAssignment.findUnique({ where: { id: assignmentId } });
		if (!assignment) {
			throw new Error(`stop: assignment "${assignmentId}" not found`);
		}
		if (assignment.status !== ScheduleAssignmentStatus.IN_PROGRESS) {
			throw new Error(`stop: assignment "${assignmentId}" is not in progress (status: ${assignment.status})`);
		}
		if (!assignment.startedAt) {
			// Shouldn't happen — IN_PROGRESS is only reached via startAssignment, which
			// always sets startedAt — but actual_hours is meaningless without it.
			throw new Error(`stop: assignment "${assignmentId}" is in_progress but has no startedAt`);
		}

		const completedAt = new Date();
		const updated = await tx.scheduleAssignment.update({
			where: { id: assignmentId },
			data: { status: ScheduleAssignmentStatus.COMPLETE, completedAt }
		});

		const actualHours = (completedAt.getTime() - assignment.startedAt.getTime()) / (1000 * 60 * 60);
		await tx.actual.create({
			data: { lineItemId: assignment.lineItemId, stationId: assignment.stationId, actualHours, completedAt }
		});

		await tx.domainAuditLog.create({
			data: {
				entity: 'ScheduleAssignment',
				entityId: assignmentId,
				action: 'schedule_stopped',
				actor: stoppedBy,
				diff: { completedAt, actualHours }
			}
		});

		const otherIncomplete = await tx.scheduleAssignment.count({
			where: {
				lineItemId: assignment.lineItemId,
				id: { not: assignmentId },
				status: { not: ScheduleAssignmentStatus.COMPLETE }
			}
		});

		return { updated, lineItemId: assignment.lineItemId, isLastForLineItem: otherIncomplete === 0 };
	});

	if (isLastForLineItem) {
		await checkCompletion(lineItemId);
	}

	return updated;
}
