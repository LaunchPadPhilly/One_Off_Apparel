/**
 * internal_due_date's default: the shop wants to be ready for an order two weeks before
 * it's actually due, so it defaults to externalShipDate minus this many days. Confirmed
 * with the client (2026-09-22), resolving the "only one date in the export" open item in
 * CLAUDE.md — the single "Deadline" date is externalShipDate; internalDueDate is derived
 * from it at import time. It's a starting point, not a lock: a human reviewing the order
 * can still set it directly (see the order edit form and updateOrderFields.ts /
 * confirmImport.ts, which only fall back to this default when internalDueDate isn't
 * explicitly given alongside externalShipDate).
 *
 * Framework-agnostic (no server-only imports) so both server code (extraction, the
 * update/confirm actions) and the order edit page's client-side "suggest a new default
 * when you change the ship date" convenience can share the exact same rule.
 */
const INTERNAL_DUE_DATE_LEAD_DAYS = 14;

/** @param isoDate an externalShipDate as a "YYYY-MM-DD" string (z.iso.date()'s shape). */
export function computeInternalDueDate(isoDate: string): string {
	const date = new Date(`${isoDate}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() - INTERNAL_DUE_DATE_LEAD_DAYS);
	return date.toISOString().slice(0, 10);
}
