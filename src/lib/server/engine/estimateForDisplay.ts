import { estimateHours, MissingFormulaError, MissingLineItemDataError, type MissingLineItemField } from './estimateHours';
import type { EstimateHoursInput } from './types';

/**
 * NEW (2026-09-21): a thin display wrapper around estimateHours() for anywhere the UI
 * wants to show "how long will this job take" *before* propose_schedule has run — the
 * Orders list and an order's detail page, not just the Schedule/production board.
 *
 * This does NOT duplicate or reimplement any formula — it only calls the real
 * estimateHours() and turns its result/thrown error into a shape a Svelte page can
 * render directly, with a short category so the template can pick an icon/badge tone
 * without re-parsing error message text (unlike explainAtRisk.ts, which only has the
 * *serialized* AtRiskFlag.reason string to work from — this helper gets the live Error
 * object straight from estimateHours(), so `instanceof` is available and preferred).
 */
export type DisplayEstimate =
	| { ok: true; hours: number; station: string }
	| { ok: false; category: 'missing_formula'; reason: string }
	| { ok: false; category: 'missing_data'; reason: string; field: MissingLineItemField };

export function estimateForDisplay(item: EstimateHoursInput): DisplayEstimate {
	try {
		const result = estimateHours(item);
		return { ok: true, hours: result.hours, station: result.station };
	} catch (err) {
		if (err instanceof MissingFormulaError) return { ok: false, category: 'missing_formula', reason: err.message };
		if (err instanceof MissingLineItemDataError) return { ok: false, category: 'missing_data', reason: err.message, field: err.field };
		throw err;
	}
}

/** Rolls a list of line items into one order-level summary: a total for whatever is
 *  currently estimable, plus how many line items aren't (yet). Line items already
 *  BLOCKED (unstarted finishing steps waiting on `depends_on`) aren't excluded here —
 *  the caller decides what to pass in; this function just sums whatever it's given. */
export interface OrderEstimateSummary {
	totalHours: number;
	estimableCount: number;
	unestimableCount: number;
}

export function summarizeOrderEstimate(lineItems: readonly EstimateHoursInput[]): OrderEstimateSummary {
	let totalHours = 0;
	let estimableCount = 0;
	let unestimableCount = 0;

	for (const item of lineItems) {
		const estimate = estimateForDisplay(item);
		if (estimate.ok) {
			totalHours += estimate.hours;
			estimableCount += 1;
		} else {
			unestimableCount += 1;
		}
	}

	return { totalHours, estimableCount, unestimableCount };
}
