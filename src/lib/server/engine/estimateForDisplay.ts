import { estimateHours, MissingFormulaError, MissingLineItemDataError, type MissingLineItemField } from './estimateHours';
import type { EstimateHoursInput } from './types';

/**
 * WHERE AN ORDER'S ESTIMATE COMES FROM, end to end:
 *
 *   1. Hoops PDF upload → extractOrderFromPdf.ts. Claude reads the PDF and fills in
 *      each line item's raw facts: quantity, weightClass, inkColorCount (from "N Color
 *      Screen Print"), screens (only if stated; otherwise assumed = inkColorCount and
 *      flagged), stitchCount (from "(N Stitches)"). Claude only *reads* these numbers
 *      off the PDF; it never computes hours.
 *   2. A human reviews/corrects those fields on the order page (updateOrderFields.ts)
 *      and confirms the import.
 *   3. On every page load, the Orders list (orders/+page.server.ts) and an order's
 *      detail page (orders/[id]/+page.server.ts) pass each line item's current fields
 *      into the functions below → estimateHours() in estimateHours.ts, which is plain
 *      deterministic TypeScript: the client's "Consolidated IT" spreadsheet formulas
 *      ported line for line:
 *        - screen print: setup (screens*5 + inks*15 + 60 min) + run time for units
 *          past the weight class's initial batch, at the weight class's rate/hr.
 *        - embroidery: setup/boxing + thread changes + hooping + load/unload +
 *          cleanup + sew time, from the flat or cap rate plan.
 *        - finishing (relabel, hang tags, fold & bag, matte, wovens): a flat
 *          minutes-per-garment rate × quantity (added 2026-09-23; wovens' rate is
 *          provisional — see estimateHours.ts).
 *      DTF and DTG have no formula; until a reviewer enters their hours they throw
 *      MissingLineItemDataError and show up as "pending," not as a guessed number. So
 *      does a matte / fold & bag row whose matteSurface / foldBagGarment hasn't been
 *      set yet. An unknown decoration type / finishing step throws MissingFormulaError.
 *   4. summarizeOrderEstimate() sums the line items that *could* be estimated into the
 *      order's "~Nh" total, and counts the rest as "+N pending." So an order total is
 *      a lower bound whenever any line item is pending.
 *
 * Nothing is stored: LineItem.estimatedHours is never written. The same estimateHours()
 * is what propose_schedule uses, so the Orders page and the scheduler always agree.
 *
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

/**
 * What a page renders for one line item's estimate. `ok: true` carries the rounded hours
 * and station kind (plus override info); `ok: false` carries a category for the badge
 * and the error message as `reason` (and, for missing data, the exact field to fill in).
 */
export type DisplayEstimate =
	| { ok: true; hours: number; station: string; overridden: boolean; formulaHours: number | null }
	| { ok: false; category: 'missing_formula'; reason: string }
	| { ok: false; category: 'missing_data'; reason: string; field: MissingLineItemField };

/**
 * Estimates one line item for display (one-person hours — no crew size). Never throws
 * for an estimation gap: MissingFormulaError / MissingLineItemDataError become
 * `ok: false` results. Any other error is a real bug and is re-thrown.
 */
export function estimateForDisplay(item: EstimateHoursInput): DisplayEstimate {
	try {
		const result = estimateHours(item);
		// overridden/formulaHours (2026-09-28): a person's edited estimate, and what the formula says.
		return { ok: true, hours: result.hours, station: result.station, overridden: result.overridden ?? false, formulaHours: result.overridden ? (result.formulaHours ?? null) : result.hours };
	} catch (err) {
		if (err instanceof MissingFormulaError) return { ok: false, category: 'missing_formula', reason: err.message };
		if (err instanceof MissingLineItemDataError) return { ok: false, category: 'missing_data', reason: err.message, field: err.field };
		throw err;
	}
}

/** An order's estimate roll-up: hours for the estimable line items, plus counts of
 *  how many could and couldn't be estimated. */
export interface OrderEstimateSummary {
	totalHours: number;
	estimableCount: number;
	unestimableCount: number;
}

/** Rolls a list of line items into one order-level summary: a total for whatever is
 *  currently estimable, plus how many line items aren't (yet). Line items already
 *  BLOCKED (unstarted finishing steps waiting on `depends_on`) aren't excluded here —
 *  the caller decides what to pass in; this function just sums whatever it's given.
 *  The total is a lower bound whenever `unestimableCount > 0`. */
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
