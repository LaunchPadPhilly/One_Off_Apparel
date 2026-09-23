import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import {
	ScheduleAssignmentStatus,
	ScheduleStrategy,
	ScheduleDraftStatus
} from '../../../../prisma/generated/prisma/enums';

/**
 * A schedule draft is a named, editable proposal for a production window (1–4 weeks
 * starting on a chosen date). It is the multi-draft parent record that lets a shop
 * hold several candidate schedules side-by-side; the actual ScheduleAssignment rows
 * are not linked here yet — that comes with "propose into a specific draft".
 */
export const createDraftSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
	description: z.string().trim().max(1000).optional().nullable(),
	startDate: z.iso.date(),
	weeks: z.number().int().min(1, 'Pick at least 1 week').max(4, 'Pick at most 4 weeks'),
	strategy: z.enum(ScheduleStrategy).default(ScheduleStrategy.BATCH_OPTIMIZE)
});

export type CreateDraftInput = z.infer<typeof createDraftSchema>;

export async function createDraft(input: CreateDraftInput, createdBy: string) {
	return prisma.scheduleDraft.create({
		data: {
			name: input.name,
			description: input.description ?? null,
			startDate: new Date(`${input.startDate}T00:00:00Z`),
			weeks: input.weeks,
			strategy: input.strategy,
			createdBy
		}
	});
}

export async function listDrafts() {
	return prisma.scheduleDraft.findMany({
		where: { status: { not: ScheduleDraftStatus.ARCHIVED } },
		orderBy: { createdAt: 'desc' }
	});
}

export async function getDraft(id: string) {
	return prisma.scheduleDraft.findUnique({ where: { id } });
}

/**
 * Delete a draft and its still-proposed assignments in one transaction. Any
 * assignments that have been committed (APPROVED / IN_PROGRESS / COMPLETE)
 * survive the delete — the ScheduleAssignment → ScheduleDraft FK is
 * onDelete: SetNull for exactly this reason, so a committed row is decoupled
 * rather than cascaded. Deliberately hard delete (not a status flip to
 * ARCHIVED): a draft the user actively deleted isn't one they might want to
 * find in an archive later, and leaving orphaned PROPOSED rows behind would
 * make them show up on future queries with no draft to explain them.
 */
export async function deleteDraft(id: string, actor: string) {
	await prisma.$transaction(async (tx) => {
		const removed = await tx.scheduleAssignment.deleteMany({
			where: { scheduleDraftId: id, status: ScheduleAssignmentStatus.PROPOSED }
		});
		await tx.scheduleDraft.delete({ where: { id } });
		await tx.domainAuditLog.create({
			data: {
				entity: 'ScheduleDraft',
				entityId: id,
				action: 'schedule_draft_deleted',
				actor,
				diff: { removedProposedAssignments: removed.count }
			}
		});
	});
}
