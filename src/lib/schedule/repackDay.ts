import { packSequentialStarts } from './shift';

/**
 * Auto-repositioning contract for a station/day's queue: items sit back-to-back
 * starting at the shift's open, in the order given, with no gaps between them.
 * This is the ONE source of truth shared by the drafts workspace's client-side
 * drag-and-drop (drafts/[id]/+page.svelte) and its server-side write actions
 * (drafts/[id]/+page.server.ts), so a repack triggered by either path lands at
 * the same wall-clock positions. Also matches proposeIntoNewDraft.ts's layout
 * of engine-decided placements — this is the same packSequentialStarts helper
 * the automatic engine already uses, wrapped for the manual-edit case.
 *
 * The user contract, as of 2026-09-23:
 *  - drop a NEW item between two peers → subsequent peers push back to make room.
 *  - move an EXISTING item elsewhere → peers behind its old slot slide forward.
 *  - remove an item → peers behind it slide forward, closing the gap.
 *
 * Encoded as: preserve relative order (by inserted rank / removed peer index),
 * assign sequenceOrder = 0..N-1, then packSequentialStarts to derive startMin.
 */

/**
 * Rank at which a drop at `dropMin` should slot into `peers` (already sorted by
 * startMin ASC). Midpoint-based: dropping in the LEFT half of a peer's span puts
 * the new item BEFORE that peer, dropping in the RIGHT half puts it AFTER — the
 * most natural "does this feel like it goes before or after that block?" call.
 */
export function computeInsertRank(dropMin: number, peers: readonly { startMin: number; durationMin: number }[]): number {
	let rank = 0;
	for (const peer of peers) {
		const mid = peer.startMin + peer.durationMin / 2;
		if (dropMin > mid) rank++;
		else break;
	}
	return rank;
}

/**
 * Rewrite an ordered list so items sit back-to-back from SHIFT_START_MIN, and
 * assign sequenceOrder = 0..N-1. Pure — the caller decides what "ordered" means
 * (e.g. insert-at-rank, then repack), and this just does the layout math.
 */
export function repackOrdered<T extends { durationMin: number; notBeforeMin?: number }>(
	ordered: readonly T[]
): Array<T & { startMin: number; sequenceOrder: number }> {
	// notBeforeMin (optional, 2026-09-23): a finisher's earliest start — its print's end
	// time when that print is on the same day. The server passes it; see
	// draftDependencies.ts. Without it this packs flush from shift open as before.
	const starts = packSequentialStarts(
		ordered.map((item) => item.durationMin),
		ordered.map((item) => item.notBeforeMin)
	);
	return ordered.map((item, i) => ({ ...item, startMin: starts[i], sequenceOrder: i }));
}

/**
 * Convenience: insert `incoming` at `rank` into `existing` (already sorted by
 * startMin ASC), then repack the whole list. `existing` MUST NOT already
 * contain the incoming item — for a move, remove it from the peer list first.
 */
export function insertAndRepack<T extends { durationMin: number }>(
	existing: readonly T[],
	incoming: T,
	rank: number
): Array<T & { startMin: number; sequenceOrder: number }> {
	const clamped = Math.max(0, Math.min(existing.length, rank));
	const ordered = [...existing.slice(0, clamped), incoming, ...existing.slice(clamped)];
	return repackOrdered(ordered);
}
