import { prisma } from '$lib/server/prisma';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * The Schedule page's "edit" action — reassigning a proposal's station/date before
 * approval. Only ever touches PROPOSED rows: once commit_schedule approves an
 * assignment it's the live schedule, and this system's non-negotiable design
 * principles say only a human approval step (not a silent edit) changes that.
 */
export async function reassignProposedAssignment(
	assignmentId: string,
	patch: { stationId?: string; date?: string },
	actor: string
) {
	return prisma.$transaction(async (tx) => {
		const assignment = await tx.scheduleAssignment.findUnique({ where: { id: assignmentId } });
		if (!assignment) throw new Error(`reassign: assignment "${assignmentId}" not found`);
		if (assignment.status !== ScheduleAssignmentStatus.PROPOSED) {
			throw new Error(`reassign: assignment "${assignmentId}" is not proposed (status: ${assignment.status}) — only a draft can be edited`);
		}

		const updated = await tx.scheduleAssignment.update({
			where: { id: assignmentId },
			data: {
				...(patch.stationId ? { stationId: patch.stationId } : {}),
				...(patch.date ? { date: new Date(patch.date) } : {})
			}
		});

		await tx.domainAuditLog.create({
			data: { entity: 'ScheduleAssignment', entityId: assignmentId, action: 'schedule_reassigned', actor, diff: patch }
		});

		return updated;
	});
}

/**
 * The Schedule page's "remove" action. Only PROPOSED rows can be removed — deleting one
 * returns its line item to the backlog (LineItem.status is untouched by this, so the
 * next propose_schedule run picks it back up); it never deletes the LineItem itself.
 */
export async function removeProposedAssignment(assignmentId: string, actor: string) {
	return prisma.$transaction(async (tx) => {
		const assignment = await tx.scheduleAssignment.findUnique({ where: { id: assignmentId } });
		if (!assignment) throw new Error(`remove: assignment "${assignmentId}" not found`);
		if (assignment.status !== ScheduleAssignmentStatus.PROPOSED) {
			throw new Error(`remove: assignment "${assignmentId}" is not proposed (status: ${assignment.status}) — only a draft can be removed`);
		}

		await tx.domainAuditLog.create({
			data: {
				entity: 'ScheduleAssignment',
				entityId: assignmentId,
				action: 'schedule_removed',
				actor,
				diff: { lineItemId: assignment.lineItemId, stationId: assignment.stationId, date: assignment.date }
			}
		});

		await tx.scheduleAssignment.delete({ where: { id: assignmentId } });
	});
}
