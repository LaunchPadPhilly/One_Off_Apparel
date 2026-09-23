import { prisma } from '$lib/server/prisma';
import {
	ArtworkApprovalStatus,
	BlankOrderingStatus,
	CustomerApprovalStatus,
	LineItemStatus,
	LineItemType,
	OrderStatus
} from '../../../../prisma/generated/prisma/enums';
import { ALL_SIBLINGS_DEPENDENCY, type BacklogItem, type CapacitySlot, type ExternalDependencyState } from '$lib/server/engine/types';
import { KNOWN_STATIONS, DEFAULT_STATION_DAY_HOURS } from '$lib/schedule/defaultCapacity';
import type { DateRange } from './types';

function startOfToday(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface SchedulingBacklog {
	backlog: BacklogItem[];
	/** Dependencies of backlog items that aren't themselves in the backlog. */
	externalDependencies: Map<string, ExternalDependencyState>;
}

/**
 * The real backlog: line items ready to place. A line item enters the backlog only when
 * ALL of the following are true:
 *   1. LineItem.status is NEEDS_REVIEW — or, for FINISHING rows only, BLOCKED
 *      (2026-09-23 decision: finishers are scheduled ahead of time, after the job they
 *      wait on — see proposeSchedule.ts. Being on the schedule doesn't unlock them on
 *      the floor; startAssignment.ts still refuses to Start a BLOCKED line item.)
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
 *
 * Alongside the backlog itself, returns what propose_schedule needs to order finishers
 * after their prints: each item's `dependsOnIds` resolved from LineItem.dependsOn ("all_siblings"
 * expands to every other line item on the order), and the state of any dependency
 * that isn't itself in the backlog (already COMPLETE = no constraint; anything else =
 * not schedulable, so its dependents get flagged at risk rather than placed early).
 */
export async function fetchBacklog(): Promise<SchedulingBacklog> {
	const lineItems = await prisma.lineItem.findMany({
		where: {
			OR: [
				{ itemType: LineItemType.DECORATION, status: LineItemStatus.NEEDS_REVIEW, artworkApprovalStatus: ArtworkApprovalStatus.APPROVED },
				{ itemType: LineItemType.FINISHING, status: { in: [LineItemStatus.NEEDS_REVIEW, LineItemStatus.BLOCKED] } }
			],
			order: {
				status: OrderStatus.CONFIRMED,
				blankOrderingStatus: BlankOrderingStatus.RECEIVED,
				customerApprovalStatus: CustomerApprovalStatus.APPROVED,
				internalDueDate: { gte: startOfToday() }
			}
		},
		include: { order: { select: { internalDueDate: true } } },
		distinct: ['id']
	});

	// Every line item on the orders involved, for resolving "all_siblings" and for the
	// state of dependencies that didn't make it into the backlog.
	const orderIds = [...new Set(lineItems.map((item) => item.orderId))];
	const siblings = await prisma.lineItem.findMany({
		where: { orderId: { in: orderIds } },
		select: { id: true, orderId: true, status: true }
	});
	const siblingIdsByOrder = new Map<string, string[]>();
	for (const sibling of siblings) {
		const ids = siblingIdsByOrder.get(sibling.orderId) ?? [];
		ids.push(sibling.id);
		siblingIdsByOrder.set(sibling.orderId, ids);
	}
	const statusById = new Map(siblings.map((sibling) => [sibling.id, sibling.status]));

	const inBacklog = new Set(lineItems.map((item) => item.id));
	const externalDependencies = new Map<string, ExternalDependencyState>();

	const backlog = lineItems.map((item) => {
		let dependsOnIds: string[] = [];
		if (item.itemType === LineItemType.FINISHING && item.dependsOn) {
			dependsOnIds = item.dependsOn === ALL_SIBLINGS_DEPENDENCY ? (siblingIdsByOrder.get(item.orderId) ?? []).filter((id) => id !== item.id) : [item.dependsOn];
		}
		for (const id of dependsOnIds) {
			if (!inBacklog.has(id)) externalDependencies.set(id, statusById.get(id) === LineItemStatus.COMPLETE ? 'complete' : 'not_schedulable');
		}
		const backlogItem: BacklogItem = {
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
			dueDate: item.order.internalDueDate,
			dependsOnIds
		};
		return backlogItem;
	});

	return { backlog, externalDependencies };
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
