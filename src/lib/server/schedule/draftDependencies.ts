import { ALL_DECORATIONS_DEPENDENCY, ALL_SIBLINGS_DEPENDENCY } from '$lib/server/engine/types';
import { cascadeInsert, cascadeMove, cascadeRemove, type CascadeItem } from '$lib/schedule/repackDay';
import { SHIFT_START_MIN, wallClockEnd, workingMinutesUntilShiftEnd } from '$lib/schedule/shift';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import { LineItemStatus, LineItemType } from '../../../../prisma/generated/prisma/enums';

/**
 * Server-side finisher-hold enforcement layered over the client-side gap-preserving
 * cascade (2026-09-28 rewrite of the earlier "always pack from shift open" model).
 * $lib/schedule/repackDay.ts is the ONE source of truth for the cascade math — this
 * module handles the two things it can't:
 *
 *  1. Applying the user's mutation as a server-authoritative write (defense-in-depth
 *     against a client that could send an overlapping or shift-overflow position).
 *  2. Re-settling any finisher whose print now ends AFTER the finisher's current
 *     start — cascading the finisher (and everything after it on that day) forward
 *     to its new earliest allowed start, or moving it to the next day if it no
 *     longer fits.
 *
 * User contract (matches repackDay.ts):
 *  - MOVE / INSERT / REMOVE preserve gaps in the destination day.
 *  - Dropping a finisher before its print, or where it can't fit after the print
 *    within the shift, is REFUSED with a plain reason.
 *  - When a print moves later, its finishers are cascaded to a legal position —
 *    held on the same day if they still fit, else pushed onto the next day.
 *  - A print moving earlier doesn't pull its finishers along.
 *
 * "After" is judged on real wall-clock times from $lib/schedule/shift.ts, the same
 * model the timeline renders and the engine places with. A COMPLETE dependency
 * imposes no constraint.
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

/** Duration in working minutes — same rule the client uses (min 15). */
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
		// A matte not linked to one design (2026-09-28): every design on the order.
		if (item.dependsOn === ALL_DECORATIONS_DEPENDENCY) {
			return lineItems.filter((other) => other.orderId === item.orderId && other.itemType === LineItemType.DECORATION);
		}
		const dep = nodes.get(item.dependsOn);
		return dep ? [dep] : [];
	}

	return { nodes, placements, dependenciesOf };
}

type Context = Awaited<ReturnType<typeof loadContext>>;

/** Earliest legal start for `item` given its dependencies' current placements. Returns
 *  null when nothing constrains it; { missing } when a dependency isn't placed and
 *  isn't already complete. */
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

/** notBeforeMin for a placement on its OWN day (undefined if the constraint is on
 *  another day — the caller handles cross-day moves separately). */
function sameDayNotBefore(ctx: Context, p: DraftPlacement): number | undefined {
	const earliest = earliestFor(ctx, p);
	return earliest && earliest.dayMs === p.dayMs ? earliest.minute : undefined;
}

function dayPeersOf(ctx: Context, stationId: string, dayMs: number): DraftPlacement[] {
	return ctx.placements.filter((p) => p.stationId === stationId && p.dayMs === dayMs).sort((a, b) => a.startMin - b.startMin);
}

/** Convert the ctx's DraftPlacement into a plain CascadeItem including per-item notBefore. */
function toCascadeItems(ctx: Context, peers: readonly DraftPlacement[]): CascadeItem[] {
	return peers.map((p) => ({ id: p.id, startMin: p.startMin, durationMin: p.durationMin, notBeforeMin: sameDayNotBefore(ctx, p) }));
}

/**
 * A human-readable reason to refuse putting `lineItemId` on `date`, or null if it's
 * allowed. Only finishers are ever refused (they may only be scheduled AFTER the jobs
 * they depend on). Wall-clock feasibility on the target day is checked too — a finisher
 * whose print ends at 4:00pm can't fit a 2-hour job on that day and must go to another.
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
 * Describes what the caller (place / move / remove action) just did, so this module
 * can apply the same cascade the client did, server-authoritatively.
 */
export type DraftMutation =
	| { kind: 'insert'; assignmentId: string; stationId: string; dayMs: number; targetStartMin: number; durationMin: number }
	| { kind: 'move'; assignmentId: string; oldStationId: string; oldDayMs: number; newStationId: string; newDayMs: number; targetStartMin: number }
	| { kind: 'remove'; oldStationId: string; oldDayMs: number; removedStartMin: number; removedDurationMin: number };

/**
 * Applies the user's mutation to the loaded placements in memory, using the same
 * cascade helpers the client used, then settles any finisher whose print now ends
 * after the finisher's start. Writes changed rows and returns the positions of every
 * placement in every day it touched.
 */
export async function repackDraftDays(tx: Db, draftId: string, mutation: DraftMutation): Promise<{ peers: PlacementPosition[]; pushedCount: number }> {
	const ctx = await loadContext(tx, draftId);
	const before = new Map(ctx.placements.map((p) => [p.id, { dayMs: p.dayMs, stationId: p.stationId, startMin: p.startMin, sequenceOrder: p.sequenceOrder }]));
	const touchedDays = new Set<string>();
	const pushed = new Set<string>();

	function markTouched(stationId: string, dayMs: number) {
		touchedDays.add(`${stationId}__${dayMs}`);
	}

	function applyCascadeResult(stationId: string, dayMs: number, placements: readonly { id: string; startMin: number; sequenceOrder: number }[]) {
		const byId = new Map(placements.map((p) => [p.id, p]));
		for (const p of ctx.placements) {
			if (p.stationId !== stationId || p.dayMs !== dayMs) continue;
			const upd = byId.get(p.id);
			if (upd) {
				p.startMin = upd.startMin;
				p.sequenceOrder = upd.sequenceOrder;
			}
		}
		markTouched(stationId, dayMs);
	}

	// 1. Apply the user's mutation via the shared cascade helpers.
	if (mutation.kind === 'insert') {
		const peers = dayPeersOf(ctx, mutation.stationId, mutation.dayMs);
		const items = toCascadeItems(ctx, peers);
		const incoming: CascadeItem = { id: mutation.assignmentId, startMin: mutation.targetStartMin, durationMin: mutation.durationMin };
		const result = cascadeInsert(items, incoming, mutation.targetStartMin);
		if ('conflict' in result) throw new Error(result.conflict);
		// Update the incoming assignment's fields on the in-memory placement (created by
		// the caller with placeholder position — cascade tells us where it actually goes).
		const insertedStart = result.incomingStart ?? mutation.targetStartMin;
		const target = ctx.placements.find((p) => p.id === mutation.assignmentId);
		if (target) {
			target.startMin = insertedStart;
			target.stationId = mutation.stationId;
			target.dayMs = mutation.dayMs;
		}
		applyCascadeResult(mutation.stationId, mutation.dayMs, result.placements);
	} else if (mutation.kind === 'move') {
		const stayed = mutation.oldStationId === mutation.newStationId && mutation.oldDayMs === mutation.newDayMs;
		if (stayed) {
			const peers = dayPeersOf(ctx, mutation.newStationId, mutation.newDayMs);
			const items = toCascadeItems(ctx, peers);
			const result = cascadeMove(items, mutation.assignmentId, mutation.targetStartMin);
			if ('conflict' in result) throw new Error(result.conflict);
			applyCascadeResult(mutation.newStationId, mutation.newDayMs, result.placements);
		} else {
			// Cross-day/cross-row: remove from origin, insert into destination.
			const originPeers = dayPeersOf(ctx, mutation.oldStationId, mutation.oldDayMs);
			const originItems = toCascadeItems(ctx, originPeers);
			const removeResult = cascadeRemove(originItems, mutation.assignmentId);
			if ('conflict' in removeResult) throw new Error(removeResult.conflict);
			applyCascadeResult(mutation.oldStationId, mutation.oldDayMs, removeResult.placements);

			// Update the moving placement's station/day BEFORE recomputing destination peers,
			// so `dayPeersOf` for the destination sees the moving placement in place.
			const moving = ctx.placements.find((p) => p.id === mutation.assignmentId);
			if (moving) {
				moving.stationId = mutation.newStationId;
				moving.dayMs = mutation.newDayMs;
				moving.startMin = mutation.targetStartMin;
			}
			const destPeers = dayPeersOf(ctx, mutation.newStationId, mutation.newDayMs).filter((p) => p.id !== mutation.assignmentId);
			const destItems = toCascadeItems(ctx, destPeers);
			const insertResult = cascadeInsert(destItems, { id: mutation.assignmentId, startMin: mutation.targetStartMin, durationMin: moving?.durationMin ?? 15 }, mutation.targetStartMin);
			if ('conflict' in insertResult) throw new Error(insertResult.conflict);
			const insertedStart = insertResult.incomingStart ?? mutation.targetStartMin;
			if (moving) moving.startMin = insertedStart;
			applyCascadeResult(mutation.newStationId, mutation.newDayMs, insertResult.placements);
		}
	} else if (mutation.kind === 'remove') {
		// Caller already deleted the row from the DB; ctx no longer includes it. Pull
		// forward every remaining peer whose OLD start was strictly greater than the
		// removed row's OLD start by the removed row's working duration (the "close the
		// gap" contract from repackDay.ts's cascadeRemove — kept in sync here because
		// the removed row is gone from ctx, so cascadeRemove itself can't be reused
		// directly).
		const peers = dayPeersOf(ctx, mutation.oldStationId, mutation.oldDayMs);
		for (const p of peers) {
			if (p.startMin > mutation.removedStartMin) {
				p.startMin = Math.max(SHIFT_START_MIN, p.startMin - mutation.removedDurationMin);
			}
		}
		// Renumber sequenceOrder by new startMin.
		const sorted = [...peers].sort((a, b) => a.startMin - b.startMin);
		sorted.forEach((p, i) => (p.sequenceOrder = i));
		markTouched(mutation.oldStationId, mutation.oldDayMs);
	}

	// 2. Settle finisher-hold violations. A print moving later can push its finishers
	//    forward; a finisher pushed past shift end moves to the next day's queue front.
	for (let guard = 0; guard < 500; guard++) {
		const violator = ctx.placements.find((p) => {
			const earliest = earliestFor(ctx, p);
			if (!earliest) return false;
			if (isBefore({ dayMs: p.dayMs, minute: p.startMin }, earliest)) return true;
			// Also violates if it can't fit within the shift starting at its current time.
			if (workingMinutesUntilShiftEnd(p.startMin) < p.durationMin) return true;
			return false;
		});
		if (!violator) break;
		pushed.add(violator.id);
		const earliest = earliestFor(ctx, violator)!;
		const originStation = violator.stationId;
		const originDay = violator.dayMs;

		if (violator.dayMs < earliest.dayMs) {
			// Move to earliest's day, front-of-queue at shift start (will be re-cascaded).
			violator.dayMs = earliest.dayMs;
			violator.startMin = SHIFT_START_MIN;
		} else {
			// Same day — cascade violator to its notBefore. If it doesn't fit, push to next.
			const peers = dayPeersOf(ctx, violator.stationId, violator.dayMs);
			const items = toCascadeItems(ctx, peers);
			const result = cascadeMove(items, violator.id, earliest.minute);
			if ('conflict' in result || workingMinutesUntilShiftEnd(earliest.minute) < violator.durationMin) {
				// Doesn't fit on this day — push to next day's front.
				violator.dayMs += DAY_MS;
				violator.startMin = SHIFT_START_MIN;
			} else {
				applyCascadeResult(violator.stationId, violator.dayMs, result.placements);
			}
		}
		// Recompute origin day now that violator is gone (if it moved days).
		if (originDay !== violator.dayMs) {
			const remainingOrigin = dayPeersOf(ctx, originStation, originDay);
			// No cascade needed — the violator's departure is a remove, but subsequent
			// peers keep their positions (we don't pull them forward for a system-driven
			// move; the human contract only applies to user removes).
			markTouched(originStation, originDay);
			void remainingOrigin;
		}
		// Cascade-insert violator on its new day.
		const destPeers = dayPeersOf(ctx, violator.stationId, violator.dayMs).filter((p) => p.id !== violator.id);
		const destItems = toCascadeItems(ctx, destPeers);
		const insertResult = cascadeInsert(destItems, { id: violator.id, startMin: violator.startMin, durationMin: violator.durationMin, notBeforeMin: earliest && earliest.dayMs === violator.dayMs ? earliest.minute : undefined }, violator.startMin);
		if ('conflict' in insertResult) {
			// Can't fit on this day either — push another day.
			violator.dayMs += DAY_MS;
			violator.startMin = SHIFT_START_MIN;
			continue;
		}
		violator.startMin = insertResult.incomingStart ?? violator.startMin;
		applyCascadeResult(violator.stationId, violator.dayMs, insertResult.placements);
	}

	// 3. Write changes.
	const peers: PlacementPosition[] = [];
	for (const p of ctx.placements) {
		const prior = before.get(p.id);
		if (!prior) continue;
		const changed = prior.dayMs !== p.dayMs || prior.stationId !== p.stationId || prior.startMin !== p.startMin || prior.sequenceOrder !== p.sequenceOrder;
		if (changed) {
			await tx.scheduleAssignment.update({
				where: { id: p.id },
				data: { date: new Date(p.dayMs), stationId: p.stationId, startMinuteOfDay: p.startMin, sequenceOrder: p.sequenceOrder }
			});
		}
		if (changed || touchedDays.has(`${p.stationId}__${p.dayMs}`) || touchedDays.has(`${prior.stationId}__${prior.dayMs}`)) {
			peers.push({ id: p.id, date: iso(p.dayMs), sequenceOrder: p.sequenceOrder, startMinuteOfDay: p.startMin });
		}
	}
	return { peers, pushedCount: pushed.size };
}
