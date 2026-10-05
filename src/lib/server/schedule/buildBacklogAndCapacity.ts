/**
 * The database-reading half of every automatic engine run: it loads the backlog (which
 * line items are ready to place) and the capacity (how many hours each station has each
 * day, and who is staffing it). The engine itself (engine/proposeSchedule.ts) is pure and
 * never touches the database — it only sees what this file hands it. Called by
 * proposeAndPersistSchedule.ts, proposeIntoNewDraft.ts and simulateChange.ts.
 */
import { prisma } from '$lib/server/prisma';
import {
	LineItemStatus,
	LineItemType,
	OrderStatus
} from '../../../../prisma/generated/prisma/enums';
import { ALL_DECORATIONS_DEPENDENCY, ALL_SIBLINGS_DEPENDENCY, type BacklogItem, type CapacitySlot, type ExternalDependencyState } from '$lib/server/engine/types';
import { DEFAULT_STATION_DAY_HOURS } from '$lib/schedule/defaultCapacity';
import { finishingDependencyRule } from '$lib/server/engine/finishingDependencies';
import { planStaffing, staffingKey, type StaffingInputs } from '$lib/server/engine/planStaffing';
import type { DateRange } from './types';

/** Midnight UTC today — the cutoff for "deadline already passed". Dates are stored as UTC days. */
function startOfToday(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What fetchBacklog() returns: the jobs to place, plus the state of anything they wait on. */
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
 *   3–4. (Removed 2026-10-02: blanks are always assumed ordered and customer approval
 *      assumed, so neither gates scheduling.)
 *   5. (Removed 2026-09-28: artwork approval is no longer a gate — the client always
 *      considers artwork done.)
 *   6. Order.deadline is today or later (2026-09-22 decision, retained across the
 *      2026-09-28 one-date rewrite: an order whose deadline has already passed is
 *      excluded from scheduling entirely — not placed with a "past due" flag, not
 *      even offered as a candidate — until its deadline is corrected. Loose internal
 *      deadlines are gated the same way; the tightness flag changes how at-risk reads
 *      to a human, not whether the order enters the backlog.)
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
				{ itemType: LineItemType.DECORATION, status: LineItemStatus.NEEDS_REVIEW },
				{ itemType: LineItemType.FINISHING, status: { in: [LineItemStatus.NEEDS_REVIEW, LineItemStatus.BLOCKED] } },
				// A job type the system doesn't model (e.g. Patch Install) — schedulable once a
				// reviewer has assigned it a station and hours (estimateHours flags it otherwise).
				{ itemType: LineItemType.OTHER, status: LineItemStatus.NEEDS_REVIEW }
			],
			order: {
				status: OrderStatus.CONFIRMED,
				deadline: { gte: startOfToday() }
			}
		},
		include: { order: { select: { deadline: true, deadlineIsTight: true } } },
		distinct: ['id']
	});

	// Every line item on the orders involved, for resolving "all_siblings" and for the
	// state of dependencies that didn't make it into the backlog.
	const orderIds = [...new Set(lineItems.map((item) => item.orderId))];
	const siblings = await prisma.lineItem.findMany({
		where: { orderId: { in: orderIds } },
		select: { id: true, orderId: true, status: true, itemType: true }
	});
	const siblingIdsByOrder = new Map<string, string[]>();
	const decorationIdsByOrder = new Map<string, string[]>();
	for (const sibling of siblings) {
		const ids = siblingIdsByOrder.get(sibling.orderId) ?? [];
		ids.push(sibling.id);
		siblingIdsByOrder.set(sibling.orderId, ids);
		if (sibling.itemType === LineItemType.DECORATION) {
			const decorationIds = decorationIdsByOrder.get(sibling.orderId) ?? [];
			decorationIds.push(sibling.id);
			decorationIdsByOrder.set(sibling.orderId, decorationIds);
		}
	}
	const statusById = new Map(siblings.map((sibling) => [sibling.id, sibling.status]));

	const inBacklog = new Set(lineItems.map((item) => item.id));
	const externalDependencies = new Map<string, ExternalDependencyState>();

	const backlog = lineItems.map((item) => {
		let dependsOnIds: string[] = [];
		if (item.itemType === LineItemType.FINISHING) {
			// The finishing rule (finishingDependencies.ts, 2026-09-28) wins over whatever
			// an older row has stored: relabel / hang tags / wovens wait on nothing, fold &
			// bag on everything, matte on its linked decoration — or, when it isn't linked to
			// one, on every design on the order. An unlinked matte stored as "all_siblings"
			// (imports before this fix) is read the same way: waiting on everything would
			// include fold & bag, which waits on everything too, a deadlock.
			const rule = finishingDependencyRule(item.finishingStep);
			const unlinkedMatte = rule === 'decoration' && (item.dependsOn === ALL_DECORATIONS_DEPENDENCY || item.dependsOn === ALL_SIBLINGS_DEPENDENCY);
			if (rule === 'all_siblings') dependsOnIds = (siblingIdsByOrder.get(item.orderId) ?? []).filter((id) => id !== item.id);
			else if (unlinkedMatte) dependsOnIds = decorationIdsByOrder.get(item.orderId) ?? [];
			else if (rule === 'decoration' && item.dependsOn) dependsOnIds = [item.dependsOn];
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
			decorationColors: item.decorationColors,
			screens: item.screens,
			stitchCount: item.stitchCount,
			quantity: item.quantity,
			weightClass: item.weightClass,
			garmentStyle: item.garmentStyle,
			capConstruction: item.capConstruction,
			matteSurface: item.matteSurface,
			foldBagGarment: item.foldBagGarment,
			manualEstimatedHours: item.manualEstimatedHours,
			otherJobType: item.otherJobType,
			assignedStationId: item.assignedStationId,
			estimatedHoursOverride: item.estimatedHoursOverride,
			// Never null here: the `deadline: { gte: … }` filter above excludes orders
			// with no deadline yet (they can't be confirmed without one anyway).
			dueDate: item.order.deadline!,
			deadlineIsTight: item.order.deadlineIsTight,
			dependsOnIds
		};
		return backlogItem;
	});

	return { backlog, externalDependencies };
}

/** A Date as its "YYYY-MM-DD" UTC day. */
function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Every day from range.from to range.to inclusive, as "YYYY-MM-DD" strings. */
function* enumerateDays(range: DateRange): Generator<string> {
	const cursor = new Date(`${range.from}T00:00:00Z`);
	const end = new Date(`${range.to}T00:00:00Z`);
	while (cursor.getTime() <= end.getTime()) {
		yield iso(cursor);
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
}

/**
 * Open capacity within a date range, for the automatic engine only (every caller is a
 * propose/simulate run). Covers every station an admin has set up at
 * /settings?screen=stations that is active (not archived) and open to automatic
 * scheduling (`autoSchedule` — false for e.g. the manual press, which people choose per
 * design). A real CapacityCalendar row always wins; anywhere one doesn't exist yet,
 * this fills the gap with DEFAULT_STATION_DAY_HOURS (see defaultCapacity.ts's doc
 * comment for exactly why and what business assumption that represents) — otherwise
 * the deterministic engine would see literally zero capacity anywhere and flag every
 * job at risk, even though the drafts workspace's own timeline already displays that
 * same default as if it were real.
 *
 * This used to upsert a hard-coded list of station names on every read; it no longer
 * creates stations at all (2026-09-25), since that would resurrect a station an admin
 * archived (e.g. DTG, which isn't done in house).
 */
export async function fetchCapacity(range: DateRange): Promise<CapacitySlot[]> {
	const stations = await prisma.station.findMany({
		where: { archivedAt: null, autoSchedule: true },
		select: { id: true, name: true, kind: true }
	});
	const stationIds = stations.map((station) => station.id);

	// range.from/to are z.iso.date() strings; Prisma's runtime validation needs a real
	// Date (see getSchedule.ts for why they aren't Date-typed at the schema level).
	const rows = await prisma.capacityCalendar.findMany({
		where: { stationId: { in: stationIds }, date: { gte: new Date(range.from), lte: new Date(range.to) } },
		include: { station: { select: { id: true, name: true, kind: true } } }
	});

	const realSlots: CapacitySlot[] = rows.map((row) => ({
		stationId: row.station.id,
		stationName: row.station.name,
		stationKind: row.station.kind,
		date: row.date,
		availableHrs: row.availableHrs
	}));

	// Fill every (station, day) that has no real row with the default, so a real row
	// always wins and the default only covers gaps.
	const existingKeys = new Set(realSlots.map((slot) => `${slot.stationId}__${iso(slot.date)}`));
	const defaultSlots: CapacitySlot[] = [];
	for (const station of stations) {
		for (const day of enumerateDays(range)) {
			const key = `${station.id}__${day}`;
			if (existingKeys.has(key)) continue;
			defaultSlots.push({ stationId: station.id, stationName: station.name, stationKind: station.kind, date: new Date(`${day}T00:00:00Z`), availableHrs: DEFAULT_STATION_DAY_HOURS });
		}
	}

	return [...realSlots, ...defaultSlots];
}

/**
 * Who's available to staff stations in a date range (2026-09-28): the active roster
 * with its certifications on active stations, the days people are out, and people a
 * human pinned to a station (both set through Claude). Feeds planStaffing.
 */
export async function fetchStaffingInputs(range: DateRange): Promise<StaffingInputs> {
	const from = new Date(range.from);
	const to = new Date(range.to);
	const [workers, unavailability, pins] = await Promise.all([
		prisma.worker.findMany({
			where: { archivedAt: null },
			select: { id: true, certifications: { where: { station: { archivedAt: null } }, select: { stationId: true } } }
		}),
		prisma.workerUnavailability.findMany({ where: { date: { gte: from, lte: to } }, select: { workerId: true, date: true } }),
		prisma.staffingPin.findMany({ where: { date: { gte: from, lte: to } }, select: { workerId: true, date: true, stationId: true } })
	]);
	return {
		workers: workers.map((worker) => ({ id: worker.id, stationIds: worker.certifications.map((cert) => cert.stationId) })),
		unavailable: new Set(unavailability.map((row) => staffingKey(row.workerId, row.date))),
		pins: new Map(pins.map((row) => [staffingKey(row.workerId, row.date), row.stationId]))
	};
}

/**
 * fetchCapacity() with each (station, day) staffed by planStaffing — the capacity every
 * engine run should use (2026-09-28). Slots with nobody on them are dropped; with no
 * roster at all it's the same as fetchCapacity().
 */
export async function fetchStaffedCapacity(range: DateRange, backlog: readonly BacklogItem[]): Promise<CapacitySlot[]> {
	const [capacity, inputs] = await Promise.all([fetchCapacity(range), fetchStaffingInputs(range)]);
	return planStaffing(backlog, capacity, inputs);
}
