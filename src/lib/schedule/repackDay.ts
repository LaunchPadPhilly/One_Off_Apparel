import { SHIFT_END_MIN, SHIFT_START_MIN, skipBreak, wallClockEnd, workingMinutesUntilShiftEnd } from './shift';

/**
 * Gap-preserving cascade for a station/day's queue (2026-09-28, replacing the earlier
 * "always pack back-to-back from shift open" model). The ONE source of truth shared by
 * the drafts workspace's client-side drag-and-drop (drafts/[id]/+page.svelte) and its
 * server-side write actions (drafts/[id]/+page.server.ts): a mutation applied on either
 * side lands at the same wall-clock positions.
 *
 * The user contract:
 *  - MOVE an item to a new time → its followers shift by the same delta, preserving
 *    every gap between them. So a 30-min push later slides every peer after it 30 min
 *    later too, keeping their inter-item spacing identical.
 *  - DROP a NEW item at time T → any peer that would overlap gets pushed later just
 *    enough to clear it, and every peer behind that one shifts by the same delta
 *    (preserving THEIR spacing). Peers before the drop time stay put.
 *  - REMOVE an item → peers after it slide earlier by exactly the removed duration
 *    (closing the gap the removed item spanned; the gap that was *before* the removed
 *    item survives, absorbed into the space between the last pre-remove peer and the
 *    first post-remove peer).
 *
 * Each mutation validates itself: refuses (with a plain reason) if the resulting layout
 * would overlap, run past shift end, or violate a `notBeforeMin` (a finisher's hold
 * against its print's end — see draftDependencies.ts). Sequence order is renumbered
 * 0..N-1 by start time on every return.
 *
 * Breaks (see shift.ts) still work: `wallClockEnd(start, working)` skips them when
 * computing an item's end; `skipBreak(start)` nudges a start OUT of a break if a drop
 * would land inside one.
 */

export interface CascadeItem {
	id: string;
	startMin: number;
	durationMin: number;
	notBeforeMin?: number;
}

export type CascadeResult<T> =
	| { placements: (T & { startMin: number; sequenceOrder: number })[] }
	| { conflict: string };

function endOf(item: { startMin: number; durationMin: number }): number {
	return wallClockEnd(item.startMin, item.durationMin);
}

/** Format a minutes-from-midnight value as "8:45a" / "12:30p" for human error messages. */
function clock(minute: number): string {
	const h = Math.floor(minute / 60);
	const m = minute % 60;
	const h12 = ((h + 11) % 12) + 1;
	const suffix = h < 12 ? 'a' : 'p';
	return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/** Renumber a placement list by start time and return with fresh sequenceOrder. */
function withSequence<T extends { startMin: number }>(placements: readonly T[]): (T & { sequenceOrder: number })[] {
	return [...placements]
		.sort((a, b) => a.startMin - b.startMin)
		.map((p, i) => ({ ...p, sequenceOrder: i }));
}

/**
 * If `target` falls INSIDE another placement's wall-clock span (excluding the moving
 * item itself, identified by `movingId` for moves), snap out — LEFT half of the peer's
 * span → snap to that peer's start (drop BEFORE it); RIGHT half → snap to that peer's
 * end (drop AFTER it). This is the same midpoint rule the old computeInsertRank used,
 * translated from a discrete rank to an absolute time. When target lands in a gap or
 * outside every peer, it's returned unchanged.
 */
function snapOutOfOverlap(queue: readonly { id: string; startMin: number; durationMin: number }[], target: number, movingId: string | null): number {
	for (const p of queue) {
		if (movingId != null && p.id === movingId) continue;
		const end = endOf(p);
		if (target >= p.startMin && target < end) {
			const mid = p.startMin + (end - p.startMin) / 2;
			return target < mid ? p.startMin : end;
		}
	}
	return target;
}

/**
 * Move `movingId` (already in the queue) to `targetStartMin`. Every peer whose ORIGINAL
 * startMin is strictly greater than the moving item's original startMin shifts by the
 * same delta — that's how inter-item gaps are preserved. Peers with a strictly-earlier
 * original startMin don't move. See file-level doc.
 */
export function cascadeMove<T extends CascadeItem>(queue: readonly T[], movingId: string, targetStartMin: number): CascadeResult<T> {
	const sorted = [...queue].sort((a, b) => a.startMin - b.startMin);
	const k = sorted.findIndex((p) => p.id === movingId);
	if (k === -1) return { conflict: 'That item is no longer on this day — reload the board.' };

	const moving = sorted[k];
	const snapped = snapOutOfOverlap(sorted, Math.round(targetStartMin), movingId);
	const target = skipBreak(Math.max(SHIFT_START_MIN, snapped));
	const delta = target - moving.startMin;

	const next: (T & { startMin: number })[] = sorted.map((p, i) => {
		if (i < k) return { ...p, startMin: p.startMin };
		if (i === k) return { ...p, startMin: target };
		return { ...p, startMin: p.startMin + delta };
	});

	// Predecessor collision (only possible when dragging earlier).
	if (k > 0) {
		const prevEnd = endOf(next[k - 1]);
		if (target < prevEnd) return { conflict: `That would collide with the job before it (ends ${clock(prevEnd)}).` };
	}

	// Shift-end / notBefore / negative-start checks on everyone that moved.
	for (let i = k; i < next.length; i++) {
		const p = next[i];
		if (p.startMin < SHIFT_START_MIN) return { conflict: `That would start "${p.id}" before the shift opens at ${clock(SHIFT_START_MIN)}.` };
		if (p.notBeforeMin != null && p.startMin < p.notBeforeMin) {
			return { conflict: `A job is held here until ${clock(p.notBeforeMin)} (waiting on the print it depends on).` };
		}
		const end = endOf(p);
		if (end > SHIFT_END_MIN || workingMinutesUntilShiftEnd(p.startMin) < p.durationMin) {
			return { conflict: `That would push a job past the end of the shift (${clock(SHIFT_END_MIN)}).` };
		}
	}

	return { placements: withSequence(next) };
}

/**
 * Insert `incoming` at `targetStartMin`. Any peer whose ORIGINAL startMin is at or
 * after the incoming's wall-clock end is a candidate for shift; if the first such peer
 * still overlaps, EVERY peer at-or-after it shifts by the same delta (preserving THEIR
 * gaps). Peers strictly before the incoming's start don't move. Returns the layout plus
 * the incoming item's snapped start (may differ from target if target landed in a
 * break).
 */
export function cascadeInsert<T extends CascadeItem>(queue: readonly T[], incoming: T, targetStartMin: number): CascadeResult<T> & { incomingStart?: number } {
	const sorted = [...queue].sort((a, b) => a.startMin - b.startMin);
	const snapped = snapOutOfOverlap(sorted, Math.round(targetStartMin), null);
	const start = skipBreak(Math.max(SHIFT_START_MIN, snapped));
	if (incoming.notBeforeMin != null && start < incoming.notBeforeMin) {
		return { conflict: `This job waits on another that finishes ${clock(incoming.notBeforeMin)} — drop it there or later.` };
	}

	// Predecessor collision (peer whose OLD start is strictly before incoming's start,
	// but whose OLD end overruns it).
	const before = sorted.filter((p) => p.startMin < start);
	if (before.length > 0) {
		const prevEnd = endOf(before[before.length - 1]);
		if (start < prevEnd) return { conflict: `That would collide with the job before it (ends ${clock(prevEnd)}).` };
	}

	const insertedItem: T & { startMin: number } = { ...incoming, startMin: start };
	const incomingEnd = endOf(insertedItem);

	// First peer whose OLD start is >= incoming's start. If none, incoming goes at the end.
	const firstAfterIndex = sorted.findIndex((p) => p.startMin >= start);
	const after = firstAfterIndex === -1 ? [] : sorted.slice(firstAfterIndex);

	let delta = 0;
	if (after.length > 0 && after[0].startMin < incomingEnd) {
		delta = incomingEnd - after[0].startMin;
	}

	const shifted: (T & { startMin: number })[] = after.map((p) => ({ ...p, startMin: p.startMin + delta }));
	const kept: (T & { startMin: number })[] = before.map((p) => ({ ...p, startMin: p.startMin }));

	for (const p of shifted) {
		if (p.notBeforeMin != null && p.startMin < p.notBeforeMin) {
			return { conflict: `A job here is held until ${clock(p.notBeforeMin)} (waiting on a print).` };
		}
		const end = endOf(p);
		if (end > SHIFT_END_MIN || workingMinutesUntilShiftEnd(p.startMin) < p.durationMin) {
			return { conflict: `That would push a job past the end of the shift (${clock(SHIFT_END_MIN)}).` };
		}
	}
	if (endOf(insertedItem) > SHIFT_END_MIN || workingMinutesUntilShiftEnd(insertedItem.startMin) < insertedItem.durationMin) {
		return { conflict: `That job doesn't fit before the shift ends at ${clock(SHIFT_END_MIN)}.` };
	}

	return { placements: withSequence([...kept, insertedItem, ...shifted]), incomingStart: start };
}

/**
 * Remove `removedId`. Every peer whose ORIGINAL startMin is strictly greater than the
 * removed item's original startMin slides earlier by exactly the removed item's
 * duration — closing the removed item's own span. Any gap that was BEFORE the removed
 * item survives as a gap between the last pre-remove peer and the first post-remove
 * peer.
 */
export function cascadeRemove<T extends CascadeItem>(queue: readonly T[], removedId: string): CascadeResult<T> {
	const sorted = [...queue].sort((a, b) => a.startMin - b.startMin);
	const k = sorted.findIndex((p) => p.id === removedId);
	if (k === -1) return { conflict: 'That item is no longer on this day — reload the board.' };

	const removed = sorted[k];
	const delta = -removed.durationMin;
	const before = sorted.slice(0, k);
	const after: (T & { startMin: number })[] = sorted.slice(k + 1).map((p) => ({ ...p, startMin: Math.max(SHIFT_START_MIN, p.startMin + delta) }));

	// Predecessor collision — the first post-remove peer could now start before the last
	// pre-remove peer's end (rare, only when the removed item spanned less than its
	// leading gap).
	if (before.length > 0 && after.length > 0) {
		const prevEnd = endOf(before[before.length - 1]);
		if (after[0].startMin < prevEnd) {
			// Snap it up to the predecessor's end (preserving gaps thereafter) — safer than
			// refusing, since a REMOVE the user asked for shouldn't fail on this edge case.
			const bump = prevEnd - after[0].startMin;
			for (const p of after) p.startMin += bump;
		}
	}

	for (const p of after) {
		if (p.notBeforeMin != null && p.startMin < p.notBeforeMin) p.startMin = p.notBeforeMin;
		if (endOf(p) > SHIFT_END_MIN) {
			// A pulled-forward peer can't overrun the shift; this branch is only for the
			// notBeforeMin bump above. Refuse rather than truncate.
			return { conflict: `Removing this job would push another past the end of the shift (${clock(SHIFT_END_MIN)}).` };
		}
	}

	return { placements: withSequence([...before, ...after]) };
}

/**
 * The engine's blank-slate helper — kept for proposeSchedule.ts, which builds a fresh
 * layout from scratch and wants everything packed back-to-back from shift open. NOT
 * used by the manual-edit path any more (that's cascadeMove / cascadeInsert /
 * cascadeRemove above). `notBeforeInOrder` (per-item earliest start) still honored.
 */
export function packFromShiftStart<T extends { durationMin: number; notBeforeMin?: number }>(
	ordered: readonly T[]
): Array<T & { startMin: number; sequenceOrder: number }> {
	const result: Array<T & { startMin: number; sequenceOrder: number }> = [];
	let cursor = SHIFT_START_MIN;
	ordered.forEach((item, i) => {
		const start = skipBreak(Math.max(cursor, item.notBeforeMin ?? SHIFT_START_MIN));
		result.push({ ...item, startMin: start, sequenceOrder: i });
		cursor = wallClockEnd(start, item.durationMin);
	});
	return result;
}
