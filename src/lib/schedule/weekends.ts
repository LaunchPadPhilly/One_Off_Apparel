/**
 * Weekend rule (2026-10-14): One Off Apparel doesn't operate Saturday or Sunday, so no
 * schedule page, capacity default or engine proposal places anything on those days. This
 * one helper is the single source of truth — the schedule page's day iteration, the
 * default capacity enumeration, propose_schedule's defensive filter, and get_schedule's
 * response filter all import it so there's no second convention to drift against.
 *
 * Dates are read in UTC because every date in this codebase is a UTC calendar day (the
 * DB column is `@db.Date`, strings are "YYYY-MM-DD").
 */

export function isWeekendDate(date: Date | string): boolean {
	const day = typeof date === 'string' ? new Date(`${date}T00:00:00Z`).getUTCDay() : date.getUTCDay();
	return day === 0 || day === 6;
}
