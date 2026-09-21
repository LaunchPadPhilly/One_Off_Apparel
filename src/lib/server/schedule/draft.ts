import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { ScheduleStrategy, ScheduleDraftStatus } from '../../../../prisma/generated/prisma/enums';

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
