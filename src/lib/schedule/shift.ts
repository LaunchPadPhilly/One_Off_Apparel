/**
 * The shop's standard production shift model: 8:00 → 16:30 wall clock, with three
 * unavailable segments (two 15-minute breaks, one 30-minute lunch) subtracted from
 * working time. Working time = shift length − break minutes = 510 − 60 = 450 min = 7h30m.
 *
 * Framework-agnostic (no server-only imports) so it can be the ONE source of truth for
 * both the drafts workspace's client-side rendering (drafts/[id]/+page.svelte, drawing
 * the timeline and handling drag-and-drop) and the automatic-schedule engine's wall-clock
 * packing (proposeIntoNewDraft.ts, computing where each engine-placed job actually sits
 * that day) — a divergence here would mean the engine's own placements render wrong on
 * the very timeline that draws them.
 */
export const SHIFT_START_MIN = 8 * 60; // 08:00
export const SHIFT_END_MIN = 16 * 60 + 30; // 16:30
export const SHIFT_LENGTH_MIN = SHIFT_END_MIN - SHIFT_START_MIN;

export const BREAKS = [
	{ startMin: 10 * 60, durationMin: 15, label: 'Break' },
	{ startMin: 12 * 60 + 30, durationMin: 30, label: 'Lunch' },
	{ startMin: 15 * 60, durationMin: 15, label: 'Break' }
] as const;

export const WORKING_MIN = SHIFT_LENGTH_MIN - BREAKS.reduce((sum, b) => sum + b.durationMin, 0);
export const WORKING_HOURS = WORKING_MIN / 60;

/**
 * Wall-clock end of a working span that begins at `startMin`: walks forward, jumping
 * across each break it crosses without consuming working budget. Never advances past
 * SHIFT_END_MIN even if `workingMin` needs more room than the shift has left — an
 * overloaded day (more hours assigned than one shift can hold) just piles up at the
 * end, same as the drag-and-drop workspace already tolerates for a manual placement.
 */
export function wallClockEnd(startMin: number, workingMin: number): number {
	let cursor = startMin;
	let remaining = workingMin;
	while (remaining > 0 && cursor < SHIFT_END_MIN) {
		const inBreak = BREAKS.find((b) => cursor >= b.startMin && cursor < b.startMin + b.durationMin);
		if (inBreak) {
			cursor = inBreak.startMin + inBreak.durationMin;
			continue;
		}
		const nextBreak = BREAKS.find((b) => b.startMin > cursor);
		const segmentEnd = nextBreak ? nextBreak.startMin : SHIFT_END_MIN;
		const available = segmentEnd - cursor;
		if (remaining <= available) {
			cursor += remaining;
			remaining = 0;
		} else {
			cursor = segmentEnd;
			remaining -= available;
		}
	}
	return cursor;
}

/** Split a working span into one visible segment per contiguous working slice — a bar
 *  that crosses a break renders as two (or more) pieces instead of one that silently
 *  overlaps the break. */
export function computeSegments(startMin: number, workingMin: number): Array<{ start: number; end: number }> {
	const segments: Array<{ start: number; end: number }> = [];
	let cursor = startMin;
	let remaining = workingMin;
	while (remaining > 0 && cursor < SHIFT_END_MIN) {
		const inBreak = BREAKS.find((b) => cursor >= b.startMin && cursor < b.startMin + b.durationMin);
		if (inBreak) {
			cursor = inBreak.startMin + inBreak.durationMin;
			continue;
		}
		const nextBreak = BREAKS.find((b) => b.startMin > cursor);
		const segmentEnd = nextBreak ? nextBreak.startMin : SHIFT_END_MIN;
		const available = segmentEnd - cursor;
		const use = Math.min(remaining, available);
		if (use > 0) segments.push({ start: cursor, end: cursor + use });
		remaining -= use;
		cursor += use;
	}
	return segments;
}

/**
 * Packs a station/day's jobs back-to-back starting at the shift's open, in the exact
 * order given — for the automatic engine, that's `sequenceOrder` (the ATCS batch
 * order), so a batch-optimized placement order becomes a batch-optimized wall-clock
 * layout immediately, with no manual dragging needed to make it look right. Breaks are
 * skipped automatically (via wallClockEnd); no overlaps, since each job starts exactly
 * where the previous one's wall-clock span ended.
 */
export function packSequentialStarts(workingMinutesInOrder: readonly number[]): number[] {
	const starts: number[] = [];
	let cursor = SHIFT_START_MIN;
	for (const workingMin of workingMinutesInOrder) {
		starts.push(cursor);
		cursor = wallClockEnd(cursor, workingMin);
	}
	return starts;
}
