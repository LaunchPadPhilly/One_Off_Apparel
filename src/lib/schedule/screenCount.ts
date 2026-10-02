/**
 * Weekly screen count (2026-09-28): an estimate of how many screens the
 * shop needs to prepare for a week — the sum of the `screens` field of every
 * screen-print job scheduled to run that week (a 2-color design with 2 screens counts
 * 2). Client-safe: the draft board recomputes it live as jobs are dragged, and the
 * /schedule page uses it for the approved schedule.
 *
 * A screen-print job with no `screens` value set counts 0 but is reported in
 * `missingCount`, so the total is never silently low.
 */
export interface ScreenCountInput {
	lineItemId: string;
	date: string; // YYYY-MM-DD
	decorationType: string | null | undefined;
	screens: number | null | undefined;
}

export interface ScreenCount {
	screens: number;
	jobCount: number;
	missingCount: number;
}

export function countScreens(items: readonly ScreenCountInput[]): ScreenCount {
	// One line item counts once per week even if it has more than one placement.
	const seen = new Set<string>();
	const result: ScreenCount = { screens: 0, jobCount: 0, missingCount: 0 };
	for (const item of items) {
		if (item.decorationType !== 'SCREEN_PRINT' || seen.has(item.lineItemId)) continue;
		seen.add(item.lineItemId);
		result.jobCount += 1;
		if (item.screens == null) result.missingCount += 1;
		else result.screens += item.screens;
	}
	return result;
}

/** Monday (UTC) of the calendar week an ISO date falls in, as YYYY-MM-DD. */
export function mondayOf(isoDate: string): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	const offset = (d.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
	d.setUTCDate(d.getUTCDate() - offset);
	return d.toISOString().slice(0, 10);
}

/** Groups items into calendar weeks (Monday start), sorted oldest first. */
export function screensByCalendarWeek(items: readonly ScreenCountInput[]): { weekStart: string; count: ScreenCount }[] {
	const byWeek = new Map<string, ScreenCountInput[]>();
	for (const item of items) {
		const key = mondayOf(item.date);
		const list = byWeek.get(key) ?? [];
		list.push(item);
		byWeek.set(key, list);
	}
	return [...byWeek.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([weekStart, list]) => ({ weekStart, count: countScreens(list) }))
		.filter((week) => week.count.jobCount > 0);
}
