import { DecorationType, FinishingStep, LineItemType, type WeightClass } from '../../../../prisma/generated/prisma/enums';
import type { EstimateHoursInput, EstimateHoursResult } from './types';

/**
 * Thrown instead of returning a guessed number. CLAUDE.md is explicit that every
 * station formula here is a direct port of one "Consolidated IT" spreadsheet tab,
 * unit-tested against that spreadsheet's own numbers — not re-derived. Only the
 * screen_print_auto formula and its shape are documented; the rest (and the
 * units-per-hour rate table screen_print_auto itself depends on) are not, so they
 * are not implemented here yet. Fill in the table/formula and this error goes away.
 */
export class MissingFormulaError extends Error {
	constructor(what: string) {
		super(`estimate_hours: ${what} is not yet specified in CLAUDE.md. Pull it from the client's Consolidated IT spreadsheet before scheduling this kind of job.`);
		this.name = 'MissingFormulaError';
	}
}

// Units-per-hour run rate by weight class, used by screen_print_auto's run-time term
// (`60 / rate[weight_class]`) — and, per the spreadsheet, presumably by every other
// station's run-time term too. Not documented anywhere in this repo. Left empty on
// purpose rather than filled with placeholder numbers: see MissingFormulaError.
const RATE_PER_HOUR: Partial<Record<WeightClass, number>> = {};

function rateFor(weightClass: WeightClass): number {
	const rate = RATE_PER_HOUR[weightClass];
	if (rate === undefined) {
		throw new MissingFormulaError(`the units-per-hour rate for weight class "${weightClass}"`);
	}
	return rate;
}

// Direct port of the screen_print_auto tab: setup is per-job (screens + ink colors +
// two fixed 30-minute constants), run time only kicks in past the first 100 units.
function estimateScreenPrintAutoHours(item: EstimateHoursInput): EstimateHoursResult {
	const screens = item.screens ?? 0;
	const colors = item.inkColorCount ?? 0;
	const setupMinutes = screens * 5 + colors * 15 + 30 + 30;
	const runMinutes = Math.max(0, item.quantity - 100) * (60 / rateFor(item.weightClass));
	return { station: 'screen_print_auto', hours: (setupMinutes + runMinutes) / 60 };
}

/**
 * Works out how long one job takes, station by station. All math lives here —
 * Claude never computes hours or a schedule itself (see CLAUDE.md's non-negotiable
 * design principles). Pure and DB-free: callable with plain import-review data.
 */
export function estimateHours(item: EstimateHoursInput): EstimateHoursResult {
	if (item.itemType === LineItemType.DECORATION) {
		switch (item.decorationType) {
			case DecorationType.SCREEN_PRINT:
				return estimateScreenPrintAutoHours(item);
			case DecorationType.EMBROIDERY:
				throw new MissingFormulaError('the embroidery station formula (setup from ink_color_count thread changes, run from stitch_count)');
			case DecorationType.DTF:
				throw new MissingFormulaError('the DTF station formula (and which station it runs on — not named in CLAUDE.md\'s engine section)');
			case DecorationType.DTG:
				throw new MissingFormulaError('the DTG station formula (and which station it runs on — not named in CLAUDE.md\'s engine section)');
			default:
				throw new MissingFormulaError(`a decoration line item with decorationType "${item.decorationType}"`);
		}
	}

	switch (item.finishingStep) {
		case FinishingStep.MATTE:
			throw new MissingFormulaError('the matte finishing station formula');
		case FinishingStep.RELABEL:
			throw new MissingFormulaError('the relabel finishing station formula');
		case FinishingStep.FOLD_BAG:
			throw new MissingFormulaError('the fold & bag finishing station formula');
		case FinishingStep.HANG_TAG:
			throw new MissingFormulaError('the hang tag finishing station formula');
		default:
			throw new MissingFormulaError(`a finishing line item with finishingStep "${item.finishingStep}"`);
	}
}
