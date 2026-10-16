import { ALL_DECORATIONS_DEPENDENCY, ALL_SIBLINGS_DEPENDENCY } from '$lib/server/engine/types';
import { cascadeInsert, cascadeMove, cascadeRemove, type CascadeItem } from '$lib/schedule/repackDay';
import { SHIFT_START_MIN, WORKING_MIN, skipBreak, wallClockEnd, workingMinutesUntilShiftEnd } from '$lib/schedule/shift';
import { isWeekendDay } from '$lib/schedule/defaultCapacity';
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
 *  - Dropping a finisher before its print is allowed and flagged red by
 *    $lib/schedule/draftProblems.ts (2026-10-16 — it used to be refused here).
 *  - When a print moves later, its finishers are cascaded to a legal position —
 *    held on the same day if they still fit, else pushed onto the next day.
 *  - A print moving earlier doesn't pull its finishers along.
 *
 * "After" is judged on real wall-clock times from $lib/schedule/shift.ts, the same
 * model the timeline renders and the engine places with. A COMPLETE dependency
 * imposes no constraint.
 *
 * Called only from the drafts workspace's server actions
 * (routes/schedule/drafts/[id]/+page.server.ts: placeAssignment / moveAssignment /
 * removeAssignment). Only touches assignments inside the one draft it's given.
 */

/** The two Prisma tables this module reads/writes — accepts either `prisma` or a transaction client. */
type Db = Pick<Prisma.TransactionClient, 'scheduleAssignment' | 'lineItem'>;

/** The few LineItem fields needed to work out who waits on whom. */
interface LineItemNode {
	id: string;
	orderId: string;
	itemType: LineItemType;
	dependsOn: string | null;
	status: LineItemStatus;
	design: string;
}

/**
 * An in-memory copy of one ScheduleAssignment in the draft, mutated freely while
 * working out the new layout and written back only at the end of repackDraftDays.
 * `dayMs` is the day's midnight-UTC timestamp; `startMin` is minutes after midnight.
 */
interface DraftPlacement {
	id: string;
	lineItemId: string;
	stationId: string;
	dayMs: number;
	startMin: number;
	durationMin: number;
	sequenceOrder: number;
}

/** Where one assignment ended up — sent back to the board so it can reconcile its local copy. */
export interface PlacementPosition {
	id: string;
	date: string;
	sequenceOrder: number;
	startMinuteOfDay: number;
}

/** One job some other edit moved, so the caller can say what else changed. */
export interface PlacementChange {
	id: string;
	lineItemId: string;
	from: { stationId: string; date: string; startMin: number };
	to: { stationId: string; date: string; startMin: number };
}

/**
 * How an edit treats the rest of the day (2026-10-16):
 * - `flag` (default — the board, and Claude when it's only checking): the edit is applied
 *   where the person put it; an overlap, a job past the end of the shift or a finisher
 *   before its print is left in place and flagged by draftProblems.ts (red on the board,
 *   Approve refused) instead of being refused here.
 * - `makeRoom` (Claude, after the person said they need the change anyway): the edited
 *   job stays exactly where it was put and everything else on that station gives way —
 *   overlapping jobs move after it, and whatever then runs past the end of the shift
 *   moves to the front of the station's next working day (and so on). Every job moved
 *   is reported in `changes` so it can be shown to the person.
 */
export type RepackMode = 'flag' | 'makeRoom';

/** A moment on the schedule: which day, and how many minutes after midnight. */
interface TimePoint {
	dayMs: number;
	minute: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Duration in working minutes — same rule the client uses (min 15). */

/** How far past what it waits on a finishing step may be pushed before giving up. */
const MAX_PUSH_DAYS = 60;

/**
 * A draft edit that can't be completed, written for the person dragging — the board
 * actions turn it into a refusal message. Thrown inside the edit's transaction, so
 * nothing is saved.
 */
export class DraftPlacementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DraftPlacementError';
	}
}

/** Working minutes a job needs free in its day: all of it, or a whole shift if it's longer. */
function fitMinutes(durationMin: number): number {
	return Math.min(durationMin, workingMinutesUntilShiftEnd(SHIFT_START_MIN));
}

function durationMinutes(estimatedHours: number): number {
	return Math.max(15, Math.round(estimatedHours * 60));
}

function iso(dayMs: number): string {
	return new Date(dayMs).toISOString().slice(0, 10);
}

/** The next weekday after `dayMs` — the shop doesn't work weekends (2026-10-14). */
function nextWorkingDayMs(dayMs: number): number {
	let next = dayMs + DAY_MS;
	while (isWeekendDay(iso(next))) next += DAY_MS;
	return next;
}

function isBefore(a: TimePoint, b: TimePoint): boolean {
	return a.dayMs !== b.dayMs ? a.dayMs < b.dayMs : a.minute < b.minute;
}

/**
 * Loads everything the checks below need for one draft: every placement in it, and
 * every line item on the orders those placements belong to (so "all_siblings" can be
 * expanded). `extraLineItemIds` pulls in the orders of line items not placed yet — e.g.
 * the one being dropped onto the board right now.
 */
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

	/** The line items `item` has to wait for (empty for anything that isn't a finisher). */
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

/** earliestAllowedStart() for a placed job, treating "dependency not placed" as no constraint. */
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

/** Every placement on one station's day, earliest start first. Doesn't modify ctx. */
function dayPeersOf(ctx: Context, stationId: string, dayMs: number): DraftPlacement[] {
	return ctx.placements.filter((p) => p.stationId === stationId && p.dayMs === dayMs).sort((a, b) => a.startMin - b.startMin);
}

/** Convert the ctx's DraftPlacement into a plain CascadeItem including per-item notBefore. */
function toCascadeItems(ctx: Context, peers: readonly DraftPlacement[]): CascadeItem[] {
	return peers.map((p) => ({ id: p.id, startMin: p.startMin, durationMin: p.durationMin, notBeforeMin: sameDayNotBefore(ctx, p) }));
}

/**
 * Describes what the caller (place / move / remove action) just did, so this module
 * can apply the same cascade the client did, server-authoritatively.
 */
export type DraftMutation =
	| { kind: 'insert'; assignmentId: string; stationId: string; dayMs: number; targetStartMin: number; durationMin: number }
	| { kind: 'move'; assignmentId: string; oldStationId: string; oldDayMs: number; oldStartMin: number; newStationId: string; newDayMs: number; targetStartMin: number }
	| { kind: 'remove'; oldStationId: string; oldDayMs: number; removedStartMin: number; removedDurationMin: number }
	// A day's crew changed (People panel, 2026-10-14), so some jobs on these stations got
	// longer or shorter. The caller has already saved their new hours; start times stay,
	// and a job that now overlaps the one before it is pushed just past its end.
	| { kind: 'restaff'; dayMs: number; stationIds: string[] };

/**
 * Applies the user's mutation to the loaded placements in memory, using the same
 * cascade helpers the client used, then settles any finisher whose print now ends
 * after the finisher's start. Writes changed rows and returns the positions of every
 * placement in every day it touched.
 *
 * Must run inside the caller's transaction (`tx`), after the caller has already
 * created/updated/deleted the row the mutation describes.
 *
 * @returns `peers` — new positions for every placement on every touched day — and
 *   `pushedCount`, how many finishers had to be moved later to stay after their print
 * @throws Error with a user-facing message when the cascade can't fit the mutation
 */
export async function repackDraftDays(
	tx: Db,
	draftId: string,
	mutation: DraftMutation,
	mode: RepackMode = 'flag'
): Promise<{ peers: PlacementPosition[]; pushedCount: number; changes: PlacementChange[] }> {
	const ctx = await loadContext(tx, draftId);
	// The caller has already saved the moved row's new position; put it back where it was
	// so the cascade starts from the real "before" (otherwise a same-day move pushed
	// nothing and a cross-day move couldn't find the job on its old day — 2026-10-16 fix).
	if (mutation.kind === 'move') {
		const moving = ctx.placements.find((p) => p.id === mutation.assignmentId);
		if (moving) {
			moving.stationId = mutation.oldStationId;
			moving.dayMs = mutation.oldDayMs;
			moving.startMin = mutation.oldStartMin;
		}
	}
	const before = new Map(ctx.placements.map((p) => [p.id, { dayMs: p.dayMs, stationId: p.stationId, startMin: p.startMin, sequenceOrder: p.sequenceOrder }]));
	const touchedDays = new Set<string>();
	const pushed = new Set<string>();
	const lenient = { lenient: true };
	// The job the person placed: it stays where they put it (flag and makeRoom alike).
	const editedId = mutation.kind === 'insert' || mutation.kind === 'move' ? mutation.assignmentId : null;
	// Finishers already out of order before a person's move/insert are theirs to fix
	// (flagged), not something to quietly rearrange now. A crew change (restaff) or a
	// removal settles every finisher, as before — its job lengths changed under it.
	const violatesDependency = (p: DraftPlacement) => {
		const earliest = earliestFor(ctx, p);
		if (!earliest) return false;
		if (isBefore({ dayMs: p.dayMs, minute: p.startMin }, earliest)) return true;
		return workingMinutesUntilShiftEnd(p.startMin) < fitMinutes(p.durationMin);
	};
	// (Judged on the layout before the edit: a job being inserted isn't on it yet.)
	const allPlacements = ctx.placements;
	if (mutation.kind === 'insert') ctx.placements = allPlacements.filter((p) => p.id !== mutation.assignmentId);
	const alreadyViolating = new Set(editedId ? ctx.placements.filter((p) => p.id !== editedId && violatesDependency(p)).map((p) => p.id) : []);
	ctx.placements = allPlacements;

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
		const result = cascadeInsert(items, incoming, mutation.targetStartMin, lenient);
		if ('conflict' in result) throw new DraftPlacementError(result.conflict);
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
			const result = cascadeMove(items, mutation.assignmentId, mutation.targetStartMin, lenient);
			if ('conflict' in result) throw new DraftPlacementError(result.conflict);
			applyCascadeResult(mutation.newStationId, mutation.newDayMs, result.placements);
		} else {
			// Cross-day/cross-row: remove from origin, insert into destination.
			const originPeers = dayPeersOf(ctx, mutation.oldStationId, mutation.oldDayMs);
			const originItems = toCascadeItems(ctx, originPeers);
			const removeResult = cascadeRemove(originItems, mutation.assignmentId, lenient);
			if ('conflict' in removeResult) throw new DraftPlacementError(removeResult.conflict);
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
			const insertResult = cascadeInsert(destItems, { id: mutation.assignmentId, startMin: mutation.targetStartMin, durationMin: moving?.durationMin ?? 15 }, mutation.targetStartMin, lenient);
			if ('conflict' in insertResult) throw new DraftPlacementError(insertResult.conflict);
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
	} else if (mutation.kind === 'restaff') {
		for (const stationId of mutation.stationIds) {
			const peers = dayPeersOf(ctx, stationId, mutation.dayMs);
			let previousEnd = SHIFT_START_MIN;
			for (const p of peers) {
				// A job that got longer pushes the next one just past its end. If that runs
				// past the shift it's flagged (flag mode) or spilled to the next day (makeRoom).
				p.startMin = skipBreak(Math.max(p.startMin, previousEnd));
				previousEnd = wallClockEnd(p.startMin, p.durationMin);
			}
			peers.forEach((p, i) => (p.sequenceOrder = i));
			markTouched(stationId, mutation.dayMs);
		}
	}

	// 1b. makeRoom: everything else on the edited station gives way (see RepackMode).
	if (mode === 'makeRoom') {
		const spilled = new Set<string>();
		const makeRoomOnDay = (stationId: string, dayMs: number, fixedId: string | null, depth: number) => {
			if (depth > MAX_PUSH_DAYS) {
				throw new DraftPlacementError(`Making room would push jobs more than ${MAX_PUSH_DAYS} days out. Nothing was changed.`);
			}
			const peers = dayPeersOf(ctx, stationId, dayMs);
			const fixed = fixedId ? (peers.find((p) => p.id === fixedId) ?? null) : null;
			// Jobs spilled in from the day before go first; the rest keep their order.
			const others = peers
				.filter((p) => p !== fixed)
				.sort((a, b) => Number(spilled.has(b.id)) - Number(spilled.has(a.id)) || a.startMin - b.startMin);
			const ahead: DraftPlacement[] = [];
			const behind: DraftPlacement[] = [];
			let cursor = SHIFT_START_MIN;
			for (const p of others) {
				if (!fixed) {
					behind.push(p);
					continue;
				}
				const start = skipBreak(Math.max(p.startMin, cursor));
				if (p.startMin >= fixed.startMin || wallClockEnd(start, p.durationMin) > fixed.startMin) {
					behind.push(p);
					continue;
				}
				p.startMin = start;
				cursor = wallClockEnd(start, p.durationMin);
				ahead.push(p);
			}
			if (fixed) cursor = Math.max(cursor, wallClockEnd(fixed.startMin, fixed.durationMin));
			const overflow: DraftPlacement[] = [];
			for (const p of behind) {
				if (overflow.length) {
					overflow.push(p);
					continue;
				}
				const start = skipBreak(Math.max(spilled.has(p.id) ? SHIFT_START_MIN : p.startMin, cursor));
				const longJobAtOpen = p.durationMin > WORKING_MIN && start <= SHIFT_START_MIN;
				if (!longJobAtOpen && workingMinutesUntilShiftEnd(start) < p.durationMin) {
					overflow.push(p);
					continue;
				}
				p.startMin = start;
				cursor = wallClockEnd(start, p.durationMin);
			}
			[...ahead, ...(fixed ? [fixed] : []), ...behind.filter((p) => !overflow.includes(p))]
				.sort((a, b) => a.startMin - b.startMin)
				.forEach((p, i) => (p.sequenceOrder = i));
			markTouched(stationId, dayMs);
			if (overflow.length === 0) return;
			const next = nextWorkingDayMs(dayMs);
			for (const p of overflow) {
				p.dayMs = next;
				p.startMin = SHIFT_START_MIN;
				spilled.add(p.id);
			}
			makeRoomOnDay(stationId, next, null, depth + 1);
		};
		if (mutation.kind === 'insert') makeRoomOnDay(mutation.stationId, mutation.dayMs, mutation.assignmentId, 0);
		else if (mutation.kind === 'move') makeRoomOnDay(mutation.newStationId, mutation.newDayMs, mutation.assignmentId, 0);
		else if (mutation.kind === 'restaff') for (const stationId of mutation.stationIds) makeRoomOnDay(stationId, mutation.dayMs, null, 0);
	}

	// 2. Settle finisher-hold violations. A print moving later can push its finishers
	//    forward; a finisher pushed past shift end moves to the next day's queue front.
	//    Fixing one violator can create another (its own finishers, or a peer it pushed),
	//    so loop until none are left. `guard` is only a safety cap against an endless loop.
	let settled = false;
	for (let guard = 0; guard < 500; guard++) {
		// Also violates if it can't fit within the shift starting at its current time. A
		// job longer than a whole shift only has to start at shift open (fitMinutes) —
		// otherwise it would "not fit" on every day and get pushed forward forever. The
		// job the person just placed, and finishers that were already out of order, are
		// left where they are and flagged instead (2026-10-16).
		const violator = ctx.placements.find((p) => p.id !== editedId && !alreadyViolating.has(p.id) && violatesDependency(p));
		if (!violator) {
			settled = true;
			break;
		}
		// Safety net: never save a job pushed absurdly far past what it waits on.
		const target = earliestFor(ctx, violator)!;
		if (violator.dayMs - target.dayMs > MAX_PUSH_DAYS * DAY_MS) {
			throw new DraftPlacementError(
				`"${ctx.nodes.get(violator.lineItemId)?.design ?? 'A finishing step'}" couldn't be fitted within ${MAX_PUSH_DAYS} days after the job it waits on. Nothing was changed — try a different day or station.`
			);
		}
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
			if ('conflict' in result || workingMinutesUntilShiftEnd(earliest.minute) < fitMinutes(violator.durationMin)) {
				// Doesn't fit on this day — push to next working day's front.
				violator.dayMs = nextWorkingDayMs(violator.dayMs);
				violator.startMin = SHIFT_START_MIN;
			} else {
				applyCascadeResult(violator.stationId, violator.dayMs, result.placements);
			}
		}
		// If the violator left its origin day, report that day as touched so the board
		// refreshes it.
		if (originDay !== violator.dayMs) {
			// No cascade needed — the violator's departure is a remove, but subsequent
			// peers keep their positions (we don't pull them forward for a system-driven
			// move; the human contract only applies to user removes).
			markTouched(originStation, originDay);
		}
		// Cascade-insert violator on its new day.
		const destPeers = dayPeersOf(ctx, violator.stationId, violator.dayMs).filter((p) => p.id !== violator.id);
		const destItems = toCascadeItems(ctx, destPeers);
		const insertResult = cascadeInsert(destItems, { id: violator.id, startMin: violator.startMin, durationMin: violator.durationMin, notBeforeMin: earliest && earliest.dayMs === violator.dayMs ? earliest.minute : undefined }, violator.startMin);
		if ('conflict' in insertResult) {
			// Can't fit on this day either — push another working day.
			violator.dayMs = nextWorkingDayMs(violator.dayMs);
			violator.startMin = SHIFT_START_MIN;
			continue;
		}
		violator.startMin = insertResult.incomingStart ?? violator.startMin;
		applyCascadeResult(violator.stationId, violator.dayMs, insertResult.placements);
	}

	if (!settled) {
		throw new DraftPlacementError('These finishing steps kept pushing each other around and couldn’t be settled. Nothing was changed — try placing them by hand on later days.');
	}

	// 3. Write changes.
	const peers: PlacementPosition[] = [];
	const changes: PlacementChange[] = [];
	for (const p of ctx.placements) {
		const prior = before.get(p.id);
		if (!prior) continue;
		const changed = prior.dayMs !== p.dayMs || prior.stationId !== p.stationId || prior.startMin !== p.startMin || prior.sequenceOrder !== p.sequenceOrder;
		const movedInTime = prior.dayMs !== p.dayMs || prior.stationId !== p.stationId || prior.startMin !== p.startMin;
		if (movedInTime && p.id !== editedId) {
			changes.push({
				id: p.id,
				lineItemId: p.lineItemId,
				from: { stationId: prior.stationId, date: iso(prior.dayMs), startMin: prior.startMin },
				to: { stationId: p.stationId, date: iso(p.dayMs), startMin: p.startMin }
			});
		}
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
	return { peers, pushedCount: pushed.size, changes };
}
