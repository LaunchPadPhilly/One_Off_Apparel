import { prisma } from '$lib/server/prisma';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Makes a proposed schedule official — the second of CLAUDE.md's two human approval
 * gates. Writes only to schedule_assignments + audit_log, exactly as CLAUDE.md's tool
 * table says; it does not touch Order or LineItem status. (When an order's status
 * should move to `scheduled` isn't documented anywhere — not addressed here rather
 * than guessed.)
 */
export async function commitSchedule(assignmentIds: readonly string[], approvedBy: string) {
	if (assignmentIds.length === 0) return [];

	return prisma.$transaction(async (tx) => {
		const assignments = await tx.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } } });

		if (assignments.length !== assignmentIds.length) {
			const found = new Set(assignments.map((a) => a.id));
			const missing = assignmentIds.filter((id) => !found.has(id));
			throw new Error(`commit_schedule: assignment id(s) not found: ${missing.join(', ')}`);
		}

		const notProposed = assignments.filter((a) => a.status !== ScheduleAssignmentStatus.PROPOSED);
		if (notProposed.length > 0) {
			throw new Error(`commit_schedule: assignment(s) not in proposed status: ${notProposed.map((a) => `${a.id} (${a.status})`).join(', ')}`);
		}

		const approvedAt = new Date();
		await tx.scheduleAssignment.updateMany({
			where: { id: { in: [...assignmentIds] } },
			data: { status: ScheduleAssignmentStatus.APPROVED, approvedBy, approvedAt }
		});

		for (const assignment of assignments) {
			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: assignment.id,
					action: 'schedule_committed',
					actor: approvedBy,
					diff: { lineItemId: assignment.lineItemId, stationId: assignment.stationId, date: assignment.date }
				}
			});
		}

		return tx.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } } });
	});
}
