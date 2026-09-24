import { ALL_SIBLINGS_DEPENDENCY } from '$lib/server/engine/types';
import { repackOrdered } from '$lib/schedule/repackDay';
import { SHIFT_START_MIN, wallClockEnd, workingMinutesUntilShiftEnd } from '$lib/schedule/shift';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import { LineItemStatus, LineItemType } from '../../../../prisma/generated/prisma/enums';

/**
 * Keeps finishers after their prints inside one schedule draft (2026-09-23), on top of
 * the draft board's packed-queue model ($lib/schedule/repackDay.ts): every (station,
 * day) is a queue packed back-to-back from shift open, and a finisher's only extra
 * rule is that it can't start before the job(s) it depends on end — so the packer
 * holds it at that time (`notBeforeMin`) instead of flush against the job ahead of it.
 * That hold is the only way a gap appears in a packed day.
 *
 * - Dropping a finisher on a day before its print's day, or on the print's day when it
 *   can't fit after the print within the shift, is REFUSED with a message. Dropping it
 *   earlier in the right day's queue just holds it until the print ends.
 * - When a print moves later, its finishers are re-packed only if they'd now start too
 *   early — held on the same day if they still fit, else moved to the front of the next
 *   day's queue — cascading to anything waiting on them (e.g. fold & bag on
 *   "all_siblings"). A print moving earlier doesn't pull its finishers along.
 *
 * "After" is judged on real wall-clock times from $lib/schedule/shift.ts, the same
 * model the timeline renders and the engine places with. A dependency that's already
 * COMPLETE imposes no constraint.
 */

type Db = Pick<Prisma.TransactionClient, 'scheduleAssignment' | 'lineItem'>;

interface LineItemNode {
	id: string;
	orderId: string;
	itemType: LineItemType;
	dependsOn: string | null;
	status: LineItemStatus;
	design: string;
}

interface DraftPlacement {
	id: string;
	lineItemId: string;
	stationId: string;
	dayMs: number;
	startMin: number;
	durationMin: number;
	sequenceOrder: number;
}

/** One placement's position after a server-side repack — what the client reconciles to. */
export interface PlacementPosition {
	id: string;
	date: string;
	sequenceOrder: number;
	startMinuteOfDay: number;
}

interface TimePoint {
	dayMs: number;
	minute: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Same duration rule the drafts workspace renders with (+page.svelte's hydration).
function durationMinutes(estimatedHours: number): number {
	return Math.max(15, Math.round(estimatedHours * 60));
}

function iso(dayMs: number): string {
	return new Date(dayMs).toISOString().slice(0, 10);
}

function formatClock(minute: number): string {
	const h24 = Math.floor(minute / 60);
	const m = minute % 60;
	const h12 = ((h24 + 11) % 12) + 1;
	return `${h12}:${String(m).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`;
}

function isBefore(a: TimePoint, b: TimePoint): boolean {
	return a.dayMs !== b.dayMs ? a.dayMs < b.dayMs : a.minute < b.minute;
}

async function loadContext(db: Db, draftId: string, extraLineItemIds: string[] = []) {
	const assignments = await db.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId },
		select: {
			id: true,
			lineItemId: true,
			stationId: true,
			date: true,
			sequenceOrder: true,
			startMinuteOfDay: true,
			estimatedHours: true,
			lineItem: { select: { orderId: true } }
		}
	});
	const extra = extraLineItemIds.length ? await db.lineItem.findMany({ where: { id: { in: extraLineItemIds } }, select: { orderId: true } }) : [];
	const orderIds = [...new Set([...assignments.map((a) => a.lineItem.orderId), ...extra.map((e) => e.orderId)])];
	const lineItems: LineItemNode[] = await db.lineItem.findMany({
		where: { orderId: { in: orderIds } },
		select: { id: true, orderId: true, itemType: true, dependsOn: true, status: true, design: true }
	});

	const nodes = new Map(lineItems.map((item) => [item.id, item]));
	const placements: DraftPlacement[] = assignments.map((a) => ({
		id: a.id,
		lineItemId: a.lineItemId,
		stationId: a.stationId,
		dayMs: a.date.getTime(),
		startMin: a.startMinuteOfDay ?? SHIFT_START_MIN,
		durationMin: durationMinutes(a.estimatedHours),
		sequenceOrder: a.sequenceOrder
	}));

	function dependenciesOf(item: LineItemNode): LineItemNode[] {
		if (item.itemType !== LineItemType.FINISHING || !item.dependsOn) return [];
		if (item.dependsOn === ALL_SIBLINGS_DEPENDENCY) return lineItems.filter((other) => other.orderId === item.orderId && other.id !== item.id);
		const dep = nodes.get(item.dependsOn);
		return dep ? [dep] : [];
	}

	function dependentsOf(lineItemId: string): LineItemNode[] {
		const item = nodes.get(lineItemId);
		if (!item) return [];
		return lineItems.filter(
			(other) =>
				other.itemType === LineItemType.FINISHING &&
				other.id !== lineItemId &&
				(other.dependsOn === lineItemId || (other.dependsOn === ALL_SIBLINGS_DEPENDENCY && other.orderId === item.orderId))
		);
	}

	return { nodes, placements, dependenciesOf, dependentsOf };
}

type Context = Awaited<ReturnType<typeof loadContext>>;

/** The latest end among `item`'s placed dependencies; `missing` when one isn't placed
 *  in this draft (and isn't already complete); null when nothing constrains it. */
function earliestAllowedStart(ctx: Context, item: LineItemNode): TimePoint | { missing: LineItemNode } | null {
	let earliest: TimePoint | null = null;
	for (const dep of ctx.dependenciesOf(item)) {
		if (dep.status === LineItemStatus.COMPLETE) continue;
		const placement = ctx.placements.find((p) => p.lineItemId === dep.id);
		if (!placement) return { missing: dep };
		const end = { dayMs: placement.dayMs, minute: wallClockEnd(placement.startMin, placement.durationMin) };
		if (!earliest || isBefore(earliest, end)) earliest = end;
	}
	return earliest;
}

function earliestFor(ctx: Context, placement: DraftPlacement): TimePoint | null {
	const node = ctx.nodes.get(placement.lineItemId);
	if (!node) return null;
	const earliest = earliestAllowedStart(ctx, node);
	return earliest && !('missing' in earliest) ? earliest : null;
}

/**
 * A human-readable reason to refuse putting `lineItemId` on `date`, or null if it's
 * allowed. Only finishers are ever refused. Within the allowed day, the packer holds
 * the finisher until its print ends, so the exact drop position doesn't matter.
 */
export async function checkFinisherPlacement(db: Db, draftId: string, lineItemId: string, date: Date, durationMin: number): Promise<string | null> {
	const ctx = await loadContext(db, draftId, [lineItemId]);
	const item = ctx.nodes.get(lineItemId);
	if (!item || item.itemType !== LineItemType.FINISHING) return null;

	const earliest = earliestAllowedStart(ctx, item);
	if (!earliest) return null;
	if ('missing' in earliest) {
		return `Place "${earliest.missing.design}" on this schedule first — "${item.design}" has to come after it.`;
	}
	const dayMs = date.getTime();
	if (dayMs < earliest.dayMs) {
		return `"${item.design}" has to come after the job it waits on, which finishes ${iso(earliest.dayMs)} at ${formatClock(earliest.minute)}.`;
	}
	if (dayMs === earliest.dayMs && workingMinutesUntilShiftEnd(earliest.minute) < Math.min(durationMin, workingMinutesUntilShiftEnd(SHIFT_START_MIN))) {
		return `"${item.design}" doesn't fit after the job it waits on (done ${formatClock(earliest.minute)}) on ${iso(dayMs)} — put it on a later day.`;
	}
	return null;
}

/**
 * Repacks the given (station, day) queues with finishers held after their prints,
 * then settles any finisher elsewhere in the draft that would now start too early
 * (cascading). Writes every changed row and returns the positions of every placement
 * in every day it touched, so the client can reconcile its optimistic layout, plus
 * how many finishers were moved because of a print.
 */
export async function repackDraftDays(
	tx: Db,
	draftId: string,
	days: ReadonlyArray<{ stationId: string; date: Date }>
): Promise<{ peers: PlacementPosition[]; pushedCount: number }> {
	const ctx = await loadContext(tx, draftId);
	const before = new Map(ctx.placements.map((p) => [p.id, { dayMs: p.dayMs, startMin: p.startMin, sequenceOrder: p.sequenceOrder }]));
	const touchedDays = new Set<string>();
	const pushed = new Set<string>();

	function repackInMemory(stationId: string, dayMs: number) {
		touchedDays.add(`${stationId}__${dayMs}`);
		const queue = ctx.placements
			.filter((p) => p.stationId === stationId && p.dayMs === dayMs)
			.sort((a, b) => a.sequenceOrder - b.sequenceOrder || a.startMin - b.startMin)
			.map((p) => {
				const earliest = earliestFor(ctx, p);
				return { placement: p, durationMin: p.durationMin, notBeforeMin: earliest && earliest.dayMs === dayMs ? earliest.minute : undefined };
			});
		for (const packed of repackOrdered(queue)) {
			packed.placement.startMin = packed.startMin;
			packed.placement.sequenceOrder = packed.sequenceOrder;
		}
	}

	for (const day of days) repackInMemory(day.stationId, day.date.getTime());

	// Settle finishers that now start before their dependencies end. Each pass either
	// holds one on its own day or moves it to the front of the next day's queue.
	for (let guard = 0; guard < 500; guard++) {
		const violator = ctx.placements.find((p) => {
			const earliest = earliestFor(ctx, p);
			if (!earliest) return false;
			const fitsWhereItIs = p.dayMs !== earliest.dayMs || workingMinutesUntilShiftEnd(p.startMin) >= Math.min(p.durationMin, workingMinutesUntilShiftEnd(SHIFT_START_MIN));
			return isBefore({ dayMs: p.dayMs, minute: p.startMin }, earliest) || !fitsWhereItIs;
		});
		if (!violator) break;
		pushed.add(violator.id);
		const earliest = earliestFor(ctx, violator)!;
		const originDay = violator.dayMs;

		if (violator.dayMs < earliest.dayMs) {
			violator.dayMs = earliest.dayMs;
			violator.sequenceOrder = -1; // front of that day's queue; the hold places it right after the print
		} else {
			repackInMemory(violator.stationId, violator.dayMs);
			const stillFits = workingMinutesUntilShiftEnd(violator.startMin) >= Math.min(violator.durationMin, workingMinutesUntilShiftEnd(SHIFT_START_MIN));
			if (!isBefore({ dayMs: violator.dayMs, minute: violator.startMin }, earliest) && stillFits) continue;
			violator.dayMs += DAY_MS;
			violator.sequenceOrder = -1;
		}
		repackInMemory(violator.stationId, violator.dayMs);
		if (originDay !== violator.dayMs) repackInMemory(violator.stationId, originDay);
	}

	const peers: PlacementPosition[] = [];
	for (const p of ctx.placements) {
		const prior = before.get(p.id)!;
		const changed = prior.dayMs !== p.dayMs || prior.startMin !== p.startMin || prior.sequenceOrder !== p.sequenceOrder;
		if (changed) {
			await tx.scheduleAssignment.update({
				where: { id: p.id },
				data: { date: new Date(p.dayMs), startMinuteOfDay: p.startMin, sequenceOrder: p.sequenceOrder }
			});
		}
		if (changed || touchedDays.has(`${p.stationId}__${p.dayMs}`)) {
			peers.push({ id: p.id, date: iso(p.dayMs), sequenceOrder: p.sequenceOrder, startMinuteOfDay: p.startMin });
		}
	}
	return { peers, pushedCount: pushed.size };
}
