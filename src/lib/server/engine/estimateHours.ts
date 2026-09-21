import { DecorationType, FinishingStep, GarmentStyle, LineItemType, type CapConstruction, type WeightClass } from '../../../../prisma/generated/prisma/enums';
import type { EstimateHoursInput, EstimateHoursResult } from './types';

/**
 * Base for both "can't estimate this job" error classes — proposeSchedule.ts catches
 * this one type and flags the job at_risk either way; explainAtRisk.ts is what tells
 * the two apart for a human (by the message prefix each subclass fixes below), since
 * "the station has no formula at all" and "this specific job is missing a field the
 * real formula needs" are different problems with different fixes.
 */
export abstract class EstimationError extends Error {}

/**
 * Thrown instead of returning a guessed number, for a station with no real formula at
 * all yet. CLAUDE.md is explicit that every station formula here is a direct port of
 * one "Consolidated IT" spreadsheet tab, unit-tested against that spreadsheet's own
 * numbers — not re-derived. screen_print_auto (2026-09-19) and embroidery
 * (2026-09-21) are now fully wired — see estimate_hours in CLAUDE.md. Per CLAUDE.md's
 * Known open items: Relabel and DTF/DTG have no formula (or station) in the source
 * spreadsheet at all — those are not "not yet ported," they need a decision from the
 * client, not an implementation. Matte and Fold & Bag are blocked on new schema fields
 * that don't exist yet, not on a missing formula.
 */
export class MissingFormulaError extends EstimationError {
	constructor(what: string) {
		super(`estimate_hours: ${what} is not yet specified in CLAUDE.md. Pull it from the client's Consolidated IT spreadsheet (or get the open decision resolved) before scheduling this kind of job.`);
		this.name = 'MissingFormulaError';
	}
}

/**
 * Thrown when a station's formula is real, but *this specific job* is missing a field
 * the formula needs (e.g. an embroidery line item with no garmentStyle set yet). Never
 * silently defaulted — see CLAUDE.md's "when unsure, ask" principle. A human resolves
 * this by editing the line item (the Orders page's existing per-item edit form), not by
 * a schema/decision change, which is what distinguishes it from MissingFormulaError.
 */
export class MissingLineItemDataError extends EstimationError {
	constructor(what: string) {
		super(`missing_data: ${what} is required to estimate this job's hours but is not set on this line item. Edit the line item to set it.`);
		this.name = 'MissingLineItemDataError';
	}
}

// Screen print's rate table has two completely different sets of numbers depending on
// how many screens the job uses: fewer than 5 screens, or 5+. This little helper just
// answers "which of those two buckets does this job fall into?" so the rest of the code
// can look up the right numbers without repeating the `< 5` check everywhere.
type ScreenPrintRegime = 'SCREENS_LT_5' | 'SCREENS_GT_4';

function screenPrintRegime(screens: number): ScreenPrintRegime {
	return screens < 5 ? 'SCREENS_LT_5' : 'SCREENS_GT_4';
}

// "initial_units" = how many garments the machine can print before it starts counting
// toward the slower "run time" phase — think of it like a free/already-included batch
// size, and it's different depending on how heavy/thick the garment fabric is (THIN vs
// POLY vs BULKY). Direct port of the screen_print_auto tab (CLAUDE.md's estimate_hours
// section, numbers confirmed with the client) — initial_units does NOT change based on
// how many screens the job uses, only rate_per_hr does (that's why the two tables below
// have different shapes: this one only keyed by weight class, the next one keyed by
// both weight class AND the < 5 / > 4 screens regime).
const SCREEN_PRINT_INITIAL_UNITS: Partial<Record<WeightClass, number>> = {
	THIN: 100,
	POLY: 80,
	BULKY: 50
};

// "rate_per_hr" = how many garments per hour the machine can print once it's past the
// initial_units free batch. Faster for thin garments, slower for bulky ones, and slower
// again once you're using 5+ screens (more screens = more physical setup/changeover on
// the machine, so it can't move through garments as quickly).
const SCREEN_PRINT_RATE_PER_HOUR: Partial<Record<ScreenPrintRegime, Partial<Record<WeightClass, number>>>> = {
	SCREENS_LT_5: { THIN: 360, POLY: 288, BULKY: 180 },
	SCREENS_GT_4: { THIN: 180, POLY: 144, BULKY: 90 }
};

/**
 * Works out how long ONE screen-print job takes, in hours. Direct port of the
 * screen_print_auto tab. The math has two parts:
 *   1. "setup" — fixed time to get the machine ready (put on screens, mix inks, etc.),
 *      which doesn't depend on how many garments you're printing.
 *   2. "run" — the actual printing time, which only kicks in for garments *beyond*
 *      the free initial_units batch, at whatever rate_per_hr applies.
 */
function estimateScreenPrintAutoHours(item: EstimateHoursInput): EstimateHoursResult {
	// `?? 0` means "if this value is missing (null/undefined), just treat it as 0" —
	// a safe fallback so the math below doesn't crash on incomplete data.
	const screens = item.screens ?? 0;
	const inkColorCount = item.inkColorCount ?? 0;

	// Setup time in minutes: 5 minutes per screen used, plus 15 minutes per ink color,
	// plus two fixed 30-minute chunks (one for general setup, one for machine config).
	const setupMinutes = screens * 5 + inkColorCount * 15 + 30 + 30;

	// Look up how many garments are included "for free" before run time starts
	// counting, based on this job's weight class (THIN/POLY/BULKY).
	const initialUnits = SCREEN_PRINT_INITIAL_UNITS[item.weightClass];
	if (initialUnits === undefined) {
		// This should never actually happen (every WeightClass has an entry above), but
		// it's here as a safety net in case a new weight class ever gets added to the
		// database without also updating this table.
		throw new MissingFormulaError(`the screen_print_auto initial_units table has no entry for weight class "${item.weightClass}"`);
	}

	// Figure out which screens bucket (< 5 or > 4) applies, then look up the
	// garments-per-hour rate for that bucket + this job's weight class.
	const regime = screenPrintRegime(screens);
	const ratePerHour = SCREEN_PRINT_RATE_PER_HOUR[regime]?.[item.weightClass];
	if (ratePerHour === undefined) {
		throw new MissingFormulaError(
			`the screen_print_auto rate_per_hr table for the ${regime === 'SCREENS_LT_5' ? 'screens < 5' : 'screens > 4'} regime has no entry for weight class "${item.weightClass}"`
		);
	}

	// Run time only applies to garments past the free initial_units batch —
	// Math.max(0, ...) makes sure we never end up with a negative number of "extra"
	// garments if the order is smaller than the free batch size.
	const runMinutes = Math.max(0, item.quantity - initialUnits) * (60 / ratePerHour);

	// Add setup + run together, then divide by 60 to convert minutes into hours (since
	// that's the unit the rest of the scheduling engine works in).
	return { station: 'screen_print_auto', hours: (setupMinutes + runMinutes) / 60 };
}

// Direct port of the embroidery tab (confirmed with the client, 2026-09-21). Flat and
// Cap are genuinely different formulas (different sew rate, different step weights),
// not a weight-class variant of one table — see LineItem.garmentStyle. Blank cells in
// the client's table (Poly/Bulky's Thread Change/Load-Unload/Sew Time/Steaming, and
// Cap Unstructured's every column but Hooping) were confirmed to mean "identical to
// the row above," not zero/N/A — that's why several rows below share the same
// threadChangeMinPerColor/loadUnloadFactor/sewRateDivisor constant.
//
// X = stitch_count, Y = ink_color_count, Z = quantity — note this is the OPPOSITE
// pairing from screen_print_auto's X/Y (there X = ink_color_count, Y = screens).
// Confirmed with the client 2026-09-21; do not assume the letters mean the same thing
// across stations.
// This "shape" (interface) describes the handful of numbers that differ between each
// garment-style/weight-class combination (e.g. "Flat + Thin" vs "Cap + Structured").
// Everything else about the embroidery formula (the actual math) is identical no
// matter which of these combinations you're looking up — only these numbers change.
interface EmbroideryRatePlan {
	setupBoxingDivisor: number; // minutes = Z * (60 / divisor)
	hoopingFactor: number; // minutes = (Z/6) * factor
	loadUnloadFactor: number; // minutes = (Z/6) * factor
	cleanupFactor: number; // minutes = (Z/6) * factor
	sewRateDivisor: number; // minutes = (Z/6) * (X / divisor)
}

// Every color of thread used means one machine stop to swap thread, at 5 minutes per
// swap. This number is the same regardless of garment style or weight class.
const EMBROIDERY_THREAD_CHANGE_MIN_PER_COLOR = 5; // minutes = Y * 5, same for Flat and Cap

// The rate plan to use for a regular (non-cap) garment, looked up by weight class.
// Heavier/bulkier garments generally take longer to hoop, load/unload, and clean up
// between pieces — that's why BULKY's numbers are bigger than THIN's for most steps.
const EMBROIDERY_FLAT_PLAN: Record<WeightClass, EmbroideryRatePlan> = {
	THIN: { setupBoxingDivisor: 240, hoopingFactor: 1.5, loadUnloadFactor: 2, cleanupFactor: 4, sewRateDivisor: 850 },
	POLY: { setupBoxingDivisor: 180, hoopingFactor: 2, loadUnloadFactor: 2, cleanupFactor: 6, sewRateDivisor: 850 },
	BULKY: { setupBoxingDivisor: 120, hoopingFactor: 1.5, loadUnloadFactor: 2, cleanupFactor: 4, sewRateDivisor: 850 }
};

// The rate plan to use for a cap (headwear), looked up by whether the cap has a stiff
// front panel (STRUCTURED) or not (UNSTRUCTURED). Notice sewRateDivisor is 650 here
// instead of 850 like Flat garments above — caps sew slower on this machine.
const EMBROIDERY_CAP_PLAN: Record<CapConstruction, EmbroideryRatePlan> = {
	STRUCTURED: { setupBoxingDivisor: 240, hoopingFactor: 1, loadUnloadFactor: 1, cleanupFactor: 1.5, sewRateDivisor: 650 },
	UNSTRUCTURED: { setupBoxingDivisor: 240, hoopingFactor: 2.5, loadUnloadFactor: 1, cleanupFactor: 1.5, sewRateDivisor: 650 }
};

/**
 * "Steaming (IF Dark/Pigment)" is a real step in the client's table (Z * (60/360) for
 * Flat, N/A for Cap) that this deliberately does NOT compute: nothing in the schema
 * signals whether a garment is dark/uses pigment ink (apparelColor is free text, not a
 * light/dark flag), and guessing from the color string would be exactly the kind of
 * inferred business logic CLAUDE.md says to ask about, not assume. Every embroidery
 * estimate below is therefore a slight underestimate for dark/pigment jobs until a
 * real signal exists. Flagged here and in CLAUDE.md, not silently omitted.
 */
function estimateEmbroideryHours(item: EstimateHoursInput): EstimateHoursResult {
	const quantity = item.quantity; // this is "Z" in the formula notes — total garments in the job

	// Before doing any math, check that every field the formula needs is actually
	// filled in on this line item. If any of them are missing, we stop immediately and
	// throw a clear, specific error saying exactly what's missing — instead of, say,
	// silently treating a missing value as 0 (which would produce a wrong, misleadingly
	// confident-looking answer).
	const inkColorCount = item.inkColorCount; // "Y" — number of thread colors
	if (inkColorCount == null) throw new MissingLineItemDataError('ink_color_count (thread color count)');
	const stitchCount = item.stitchCount; // "X" — total stitches in the design
	if (stitchCount == null) throw new MissingLineItemDataError('stitch_count');

	// Pick which set of rate numbers (the "plan") applies to this specific job. A cap
	// needs its capConstruction (structured/unstructured) set too, since that's what
	// selects which cap plan to use — checked separately from the FLAT case just above
	// it, since FLAT doesn't need that field at all.
	let plan: EmbroideryRatePlan;
	if (item.garmentStyle === GarmentStyle.FLAT) {
		plan = EMBROIDERY_FLAT_PLAN[item.weightClass];
	} else if (item.garmentStyle === GarmentStyle.CAP) {
		if (!item.capConstruction) throw new MissingLineItemDataError('cap_construction (structured vs unstructured)');
		plan = EMBROIDERY_CAP_PLAN[item.capConstruction];
	} else {
		// garmentStyle wasn't set to either FLAT or CAP (it's probably just null,
		// meaning nobody has filled it in yet on this line item).
		throw new MissingLineItemDataError('garment_style (flat vs cap)');
	}

	// Now the actual formula — six separate steps of the embroidery process, each
	// contributing some number of minutes. Adding them all up gives the total time for
	// this job. A few of these divide quantity by 6 first (quantity/6) because the
	// embroidery machine hoops (loads) 6 garments onto it at a time as one batch.
	const setupBoxingMinutes = quantity * (60 / plan.setupBoxingDivisor);
	const threadChangeMinutes = inkColorCount * EMBROIDERY_THREAD_CHANGE_MIN_PER_COLOR;
	const hoopingMinutes = (quantity / 6) * plan.hoopingFactor;
	const loadUnloadMinutes = (quantity / 6) * plan.loadUnloadFactor;
	const cleanupMinutes = (quantity / 6) * plan.cleanupFactor;
	const sewMinutes = (quantity / 6) * (stitchCount / plan.sewRateDivisor);

	// Add every step together, then convert from minutes to hours (÷ 60) since that's
	// the unit the rest of the scheduling engine expects back.
	const totalMinutes = setupBoxingMinutes + threadChangeMinutes + hoopingMinutes + loadUnloadMinutes + cleanupMinutes + sewMinutes;
	return { station: 'embroidery', hours: totalMinutes / 60 };
}

/**
 * Works out how long one job takes, station by station. All math lives here —
 * Claude never computes hours or a schedule itself (see CLAUDE.md's non-negotiable
 * design principles). Pure and DB-free: callable with plain import-review data.
 *
 * This function is basically a big router: look at what kind of job this line item
 * is (screen print? embroidery? a finishing step?) and hand it off to whichever
 * smaller function knows how to do that specific math. If we don't have a real
 * formula for a given kind of job yet, we throw an error instead of guessing — see
 * the MissingFormulaError/MissingLineItemDataError classes above for why.
 */
export function estimateHours(item: EstimateHoursInput): EstimateHoursResult {
	if (item.itemType === LineItemType.DECORATION) {
		switch (item.decorationType) {
			case DecorationType.SCREEN_PRINT:
				return estimateScreenPrintAutoHours(item);
			case DecorationType.EMBROIDERY:
				// NEW (2026-09-21): this used to just throw MissingFormulaError — now it
				// actually computes a real answer via estimateEmbroideryHours above.
				return estimateEmbroideryHours(item);
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
