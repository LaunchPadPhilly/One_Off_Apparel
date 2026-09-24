import { prisma } from '$lib/server/prisma';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { DateRange } from './types';

/**
 * Looks up what's currently scheduled — the live schedule, not draft proposals.
 * PROPOSED rows are excluded on purpose: propose_schedule persists them as drafts (see
 * proposeAndPersistSchedule.ts), but they only become part of "what's currently
 * scheduled" once commit_schedule approves them. This is the read side of that same
 * distinction, not a separate concept.
 */
export async function getSchedule(range: DateRange, stationId?: string) {
	// range.from/to are z.iso.date() strings ("YYYY-MM-DD") — kept as plain date strings
	// so the MCP tool's advertised input schema stays JSON-Schema-representable (a bare
	// Date type isn't). Prisma's runtime validation, unlike its TS types, rejects a
	// date-only string ("premature end of input, expected ISO-8601 DateTime") — it needs
	// a real Date.
	return prisma.scheduleAssignment.findMany({
		where: {
			date: { gte: new Date(range.from), lte: new Date(range.to) },
			...(stationId ? { stationId } : {}),
			status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS, ScheduleAssignmentStatus.COMPLETE] }
		},
		include: {
			lineItem: { select: { id: true, design: true, itemType: true, decorationType: true, finishingStep: true, orderId: true, status: true } },
			station: { select: { id: true, name: true, type: true } }
		},
		orderBy: [{ date: 'asc' }, { stationId: 'asc' }, { sequenceOrder: 'asc' }]
	});
}
