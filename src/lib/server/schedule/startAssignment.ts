import { prisma } from '$lib/server/prisma';
import { LineItemStatus, ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * The Production Board's "Start" action — CLAUDE.md's schedule_assignments notes say
 * only that `started_at` "is set when the Start button fires," nothing more. Only
 * approved assignments can start (a proposed one isn't real yet — see get_schedule.ts).
 *
 * Deliberately does not touch LineItem.status. Whether/when a line item should move to
 * in_production isn't documented anywhere (see CLAUDE.md's production-board open item);
 * left alone rather than guessed, same as commit_schedule leaves Order.status alone.
 */
export async function startAssignment(assignmentId: string, startedBy: string) {
	return prisma.$transaction(async (tx) => {
		const assignment = await tx.scheduleAssignment.findUnique({ where: { id: assignmentId }, include: { lineItem: { select: { status: true } } } });
		if (!assignment) {
			throw new Error(`start: assignment "${assignmentId}" not found`);
		}
		if (assignment.status !== ScheduleAssignmentStatus.APPROVED) {
			throw new Error(`start: assignment "${assignmentId}" is not approved (status: ${assignment.status})`);
		}
		// Finishers are scheduled ahead of time (2026-09-23), but on the floor they stay
		// locked until the job they wait on is actually Stopped — check_completion is
		// still the only thing that unlocks a BLOCKED line item.
		if (assignment.lineItem.status === LineItemStatus.BLOCKED) {
			throw new Error("start: this finishing step is still waiting on the job it depends on — stop that job first, then this one unlocks.");
		}

		const startedAt = new Date();
		const updated = await tx.scheduleAssignment.update({
			where: { id: assignmentId },
			data: { status: ScheduleAssignmentStatus.IN_PROGRESS, startedAt }
		});

		await tx.domainAuditLog.create({
			data: {
				entity: 'ScheduleAssignment',
				entityId: assignmentId,
				action: 'schedule_started',
				actor: startedBy,
				diff: { startedAt }
			}
		});

		return updated;
	});
}
