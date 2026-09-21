import { prisma } from '$lib/server/prisma';
import {
	ArtworkApprovalStatus,
	BlankOrderingStatus,
	CustomerApprovalStatus,
	LineItemStatus,
	LineItemType,
	OrderStatus
} from '../../../../prisma/generated/prisma/enums';
import type { BacklogItem, CapacitySlot } from '$lib/server/engine/types';
import type { DateRange } from './types';

/**
 * The real backlog: line items ready to place. A line item enters the backlog only when
 * ALL of the following are true:
 *   1. LineItem.status is NEEDS_REVIEW (not BLOCKED, not already in production/complete)
 *   2. Order.status is CONFIRMED (import confirmation gate passed)
 *   3. Order.blankOrderingStatus is RECEIVED (garments are in hand)
 *   4. Order.customerApprovalStatus is APPROVED (customer signed off)
 *   5. For DECORATION rows: artworkApprovalStatus is APPROVED
 *      For FINISHING rows: artworkApprovalStatus is null (no artwork to approve)
 *
 * These gates limit scheduling, not estimates — estimateHours is a pure function that
 * runs independently of approval status (e.g. at import review time).
 */
export async function fetchBacklog(): Promise<BacklogItem[]> {
	const lineItems = await prisma.lineItem.findMany({
		where: {
			status: LineItemStatus.NEEDS_REVIEW,
			order: {
				status: OrderStatus.CONFIRMED,
				blankOrderingStatus: BlankOrderingStatus.RECEIVED,
				customerApprovalStatus: CustomerApprovalStatus.APPROVED
			},
			OR: [
				{ itemType: LineItemType.FINISHING },
				{ artworkApprovalStatus: ArtworkApprovalStatus.APPROVED }
			]
		},
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
		garmentStyle: item.garmentStyle,
		capConstruction: item.capConstruction,
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
