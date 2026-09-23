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
import { KNOWN_STATIONS, DEFAULT_STATION_DAY_HOURS } from '$lib/schedule/defaultCapacity';
import type { DateRange } from './types';

function startOfToday(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The real backlog: line items ready to place. A line item enters the backlog only when
 * ALL of the following are true:
 *   1. LineItem.status is NEEDS_REVIEW (not BLOCKED, not already in production/complete)
 *   2. Order.status is CONFIRMED (import confirmation gate passed)
 *   3. Order.blankOrderingStatus is RECEIVED (garments are in hand)
 *   4. Order.customerApprovalStatus is APPROVED (customer signed off)
 *   5. For DECORATION rows: artworkApprovalStatus is APPROVED
 *      For FINISHING rows: artworkApprovalStatus is null (no artwork to approve)
 *   6. Order.internalDueDate is today or later (2026-09-22 decision: an order whose due
 *      date has already passed is excluded from scheduling entirely — not placed with a
 *      "past due" flag, not even offered as a candidate — until its due date is
 *      corrected. See CLAUDE.md's engine section for why this replaced an earlier
 *      "place it anyway, flagged" attempt.)
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
				customerApprovalStatus: CustomerApprovalStatus.APPROVED,
				internalDueDate: { gte: startOfToday() }
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
		matteSurface: item.matteSurface,
		foldBagGarment: item.foldBagGarment,
		dueDate: item.order.internalDueDate
	}));
}

function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function* enumerateDays(range: DateRange): Generator<string> {
	const cursor = new Date(`${range.from}T00:00:00Z`);
	const end = new Date(`${range.to}T00:00:00Z`);
	while (cursor.getTime() <= end.getTime()) {
		yield iso(cursor);
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
}

/**
 * Every station's open capacity within a date range. A real CapacityCalendar row
 * always wins; anywhere one doesn't exist yet, this fills the gap with
 * DEFAULT_STATION_DAY_HOURS for each known station (see
 * defaultCapacity.ts's doc comment for exactly why and what business assumption that
 * represents) — otherwise the deterministic engine would see literally zero capacity
 * anywhere and flag every job at risk, even though the drafts workspace's own timeline
 * already displays that same default as if it were real. Ensuring a real Station row
 * exists for each known name (upsert-on-read, same idempotent pattern the drag-and-drop
 * workspace's own ensureStation() already uses) is what lets a default slot reference a
 * real id.
 */
export async function fetchCapacity(range: DateRange): Promise<CapacitySlot[]> {
	// range.from/to are z.iso.date() strings; Prisma's runtime validation needs a real
	// Date (see getSchedule.ts for why they aren't Date-typed at the schema level).
	const rows = await prisma.capacityCalendar.findMany({
		where: { date: { gte: new Date(range.from), lte: new Date(range.to) } },
		include: { station: { select: { id: true, name: true } } }
	});

	const realSlots: CapacitySlot[] = rows.map((row) => ({
		stationId: row.station.id,
		stationName: row.station.name,
		date: row.date,
		availableHrs: row.availableHrs
	}));

	const stations = await Promise.all(
		KNOWN_STATIONS.map((name) => prisma.station.upsert({ where: { name }, create: { name, type: 'production' }, update: {} }))
	);

	const existingKeys = new Set(realSlots.map((slot) => `${slot.stationId}__${iso(slot.date)}`));
	const defaultSlots: CapacitySlot[] = [];
	for (const station of stations) {
		for (const day of enumerateDays(range)) {
			const key = `${station.id}__${day}`;
			if (existingKeys.has(key)) continue;
			defaultSlots.push({ stationId: station.id, stationName: station.name, date: new Date(`${day}T00:00:00Z`), availableHrs: DEFAULT_STATION_DAY_HOURS });
		}
	}

	return [...realSlots, ...defaultSlots];
}
