import { prisma } from '$lib/server/prisma';
import { LineItemStatus, OrderStatus } from '../../../../prisma/generated/prisma/enums';
import type { BacklogItem, CapacitySlot } from '$lib/server/engine/types';
import type { DateRange } from './types';

/**
 * The real backlog: line items ready to place. Two conditions, both required —
 * LineItem.status alone isn't enough (see CLAUDE.md's engine section: "backlog only
 * ever contains status: needs_review — blocked line items never reach here") because
 * that doesn't account for the *other* human approval gate. A line item can be
 * needs_review while its parent order is still needs_review too (import confirmation
 * hasn't happened yet) — CLAUDE.md's "Two human approval gates" are both required, and
 * nothing else in this codebase enforces the second one, so this is where it happens.
 */
export async function fetchBacklog(): Promise<BacklogItem[]> {
	const lineItems = await prisma.lineItem.findMany({
		where: { status: LineItemStatus.NEEDS_REVIEW, order: { status: OrderStatus.CONFIRMED } },
		include: { order: { select: { internalDueDate: true } } },
		distinct: ['id']
	});

	return lineItems.map((item) => ({
		id: item.id,
		itemType: item.itemType,
		decorationType: item.decorationType,
		finishingStep: item.finishingStep,
		inkColorCount: item.inkColorCount,
		screens: item.screens,
		stitchCount: item.stitchCount,
		quantity: item.quantity,
		weightClass: item.weightClass,
		dueDate: item.order.internalDueDate
	}));
}

/** Every station's open capacity within a date range. */
export async function fetchCapacity(range: DateRange): Promise<CapacitySlot[]> {
	// range.from/to are z.iso.date() strings; Prisma's runtime validation needs a real
	// Date (see getSchedule.ts for why they aren't Date-typed at the schema level).
	const rows = await prisma.capacityCalendar.findMany({
		where: { date: { gte: new Date(range.from), lte: new Date(range.to) } },
		include: { station: { select: { id: true, name: true } } }
	});

	return rows.map((row) => ({
		stationId: row.station.id,
		stationName: row.station.name,
		date: row.date,
		availableHrs: row.availableHrs
	}));
}
