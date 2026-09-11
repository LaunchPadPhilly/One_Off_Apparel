import { DecorationType, FinishingStep, LineItemType, type WeightClass } from '../../../../prisma/generated/prisma/enums';
import type { EstimateHoursInput, EstimateHoursResult } from './types';

/**
 * Thrown instead of returning a guessed number. CLAUDE.md is explicit that every
 * station formula here is a direct port of one "Consolidated IT" spreadsheet tab,
 * unit-tested against that spreadsheet's own numbers — not re-derived. Per CLAUDE.md's
 * Known open items: Relabel and DTF/DTG have no formula (or station) in the source
 * spreadsheet at all — those are not "not yet ported," they need a decision from the
 * client, not an implementation. Matte and Fold & Bag are blocked on new schema fields
 * that don't exist yet, not on a missing formula.
 */
export class MissingFormulaError extends Error {
	constructor(what: string) {
		super(`estimate_hours: ${what} is not yet specified in CLAUDE.md. Pull it from the client's Consolidated IT spreadsheet (or get the open decision resolved) before scheduling this kind of job.`);
		this.name = 'MissingFormulaError';
	}
}

type ScreenPrintRegime = 'SCREENS_LT_5' | 'SCREENS_GT_4';

function screenPrintRegime(screens: number): ScreenPrintRegime {
	return screens < 5 ? 'SCREENS_LT_5' : 'SCREENS_GT_4';
}

// screen_print_auto's run-time term is `max(0, quantity - initial_units) * (60 / rate_per_hr)`,
// and CLAUDE.md is explicit that screens < 5 and screens > 4 are two different rate
// regimes — i.e. two different tables, not two rows of one table. Neither table's
// actual numbers exist in CLAUDE.md yet (grepped for `initial_units`/`rate_per_hr`:
// no hits), so both are left empty rather than filled with placeholder numbers. Once
// the real per-regime, per-weight-class values land in CLAUDE.md, fill in both maps
// below and the MissingFormulaError in estimateScreenPrintAutoHours goes away.
const SCREEN_PRINT_INITIAL_UNITS: Partial<Record<ScreenPrintRegime, Partial<Record<WeightClass, number>>>> = {};
const SCREEN_PRINT_RATE_PER_HOUR: Partial<Record<ScreenPrintRegime, Partial<Record<WeightClass, number>>>> = {};

function lookup(
	table: Partial<Record<ScreenPrintRegime, Partial<Record<WeightClass, number>>>>,
	regime: ScreenPrintRegime,
	weightClass: WeightClass,
	tableName: string
): number {
	const value = table[regime]?.[weightClass];
	if (value === undefined) {
		throw new MissingFormulaError(
			`the screen_print_auto ${tableName} for the ${regime === 'SCREENS_LT_5' ? 'screens < 5' : 'screens > 4'} regime, weight class "${weightClass}"`
		);
	}
	return value;
}

// Direct port of the screen_print_auto tab. setup is per-job (screens + ink colors +
// two fixed 30-minute constants); run only kicks in past initial_units, at a rate that
// depends on both the screens<5/>4 regime and weight class — see the two lookup tables
// above.
function estimateScreenPrintAutoHours(item: EstimateHoursInput): EstimateHoursResult {
	const screens = item.screens ?? 0;
	const inkColorCount = item.inkColorCount ?? 0;
	const setupMinutes = screens * 5 + inkColorCount * 15 + 30 + 30;

	const regime = screenPrintRegime(screens);
	const initialUnits = lookup(SCREEN_PRINT_INITIAL_UNITS, regime, item.weightClass, 'initial_units table');
	const ratePerHour = lookup(SCREEN_PRINT_RATE_PER_HOUR, regime, item.weightClass, 'rate_per_hr table');

	const runMinutes = Math.max(0, item.quantity - initialUnits) * (60 / ratePerHour);
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
				throw new MissingFormulaError('a DTF station and formula — CLAUDE.md flags this as a dropdown value with no backing station at all, not just an unported formula');
			case DecorationType.DTG:
				throw new MissingFormulaError('a DTG station and formula — CLAUDE.md flags this as a dropdown value with no backing station at all, not just an unported formula');
			default:
				throw new MissingFormulaError(`a decoration line item with decorationType "${item.decorationType}"`);
		}
	}

	switch (item.finishingStep) {
		case FinishingStep.MATTE:
			throw new MissingFormulaError('the matte finishing formula — CLAUDE.md flags this as blocked on a new schema field (Surface: Flat vs Specialty) that does not exist yet, not just an unported formula');
		case FinishingStep.RELABEL:
			throw new MissingFormulaError('the relabel finishing formula — CLAUDE.md flags this as having no formula in the source spreadsheet at all, a direct question for the client rather than something to port');
		case FinishingStep.FOLD_BAG:
			throw new MissingFormulaError('the fold & bag finishing formula — CLAUDE.md flags this as blocked on a new schema field ("SS Tee" vs "Other") that does not exist yet, not just an unported formula');
		case FinishingStep.HANG_TAG:
			throw new MissingFormulaError('the hang tag finishing station formula');
		default:
			throw new MissingFormulaError(`a finishing line item with finishingStep "${item.finishingStep}"`);
	}
}
