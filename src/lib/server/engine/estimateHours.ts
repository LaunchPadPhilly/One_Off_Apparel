import { DecorationType, FinishingStep, GarmentStyle, LineItemType, MatteSurface, type CapConstruction, type FoldBagGarment, type WeightClass } from '../../../../prisma/generated/prisma/enums';
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
 * numbers — not re-derived. screen_print_auto (2026-09-19), embroidery (2026-09-21)
 * and every finishing step (2026-09-23) are now fully wired — see estimate_hours in
 * CLAUDE.md. DTF/DTG have no formula (time varies by artwork) and use reviewer-entered
 * hours instead — see estimateManualHours. What still throws this: an unknown
 * decoration type or finishing step.
 */
export class MissingFormulaError extends EstimationError {
	constructor(what: string) {
		super(`estimate_hours: ${what} is not yet specified in CLAUDE.md. Pull it from the client's Consolidated IT spreadsheet (or get the open decision resolved) before scheduling this kind of job.`);
		this.name = 'MissingFormulaError';
	}
}

/** The exact LineItem field a MissingLineItemDataError is missing — lets a caller (the
 *  order page's "needs attention" gaps, the notes-based fill-in) target the real field
 *  precisely instead of parsing it back out of the human-readable message. */
export type MissingLineItemField = 'inkColorCount' | 'stitchCount' | 'garmentStyle' | 'capConstruction' | 'matteSurface' | 'foldBagGarment' | 'manualEstimatedHours';

/**
 * Thrown when a station's formula is real, but *this specific job* is missing a field
 * the formula needs (e.g. an embroidery line item with no garmentStyle set yet). Never
 * silently defaulted — see CLAUDE.md's "when unsure, ask" principle. A human resolves
 * this by editing the line item (the Orders page's existing per-item edit form, or the
 * notes-based fill-in — see fillNeedsAttentionFromNotes.ts), not by a schema/decision
 * change, which is what distinguishes it from MissingFormulaError.
 */
export class MissingLineItemDataError extends EstimationError {
	constructor(
		what: string,
		public readonly field: MissingLineItemField
	) {
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
	// CAUTION: unlike embroidery below (which throws MissingLineItemDataError for a
	// missing field), a screen-print job with no screens/ink count set still gets a
	// number here — just a too-low one (setup shrinks to the fixed 60 minutes). It
	// won't show as "pending" on the Orders page. Open question whether this should
	// throw MissingLineItemDataError instead, like embroidery does.
	const screens = item.screens ?? 0;
	const inkColorCount = item.inkColorCount ?? 0;

	// Setup time in minutes: 5 minutes per screen used, plus 15 minutes per ink color,
	// plus two fixed 30-minute chunks. (The spreadsheet lists them as two separate
	// +30 terms; what each one represents hasn't been confirmed with the client.)
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
	if (inkColorCount == null) throw new MissingLineItemDataError('ink_color_count (thread color count)', 'inkColorCount');
	const stitchCount = item.stitchCount; // "X" — total stitches in the design
	if (stitchCount == null) throw new MissingLineItemDataError('stitch_count', 'stitchCount');

	// Pick which set of rate numbers (the "plan") applies to this specific job. A cap
	// needs its capConstruction (structured/unstructured) set too, since that's what
	// selects which cap plan to use — checked separately from the FLAT case just above
	// it, since FLAT doesn't need that field at all.
	let plan: EmbroideryRatePlan;
	if (item.garmentStyle === GarmentStyle.FLAT) {
		plan = EMBROIDERY_FLAT_PLAN[item.weightClass];
	} else if (item.garmentStyle === GarmentStyle.CAP) {
		if (!item.capConstruction) throw new MissingLineItemDataError('cap_construction (structured vs unstructured)', 'capConstruction');
		plan = EMBROIDERY_CAP_PLAN[item.capConstruction];
	} else {
		// garmentStyle wasn't set to either FLAT or CAP (it's probably just null,
		// meaning nobody has filled it in yet on this line item).
		throw new MissingLineItemDataError('garment_style (flat vs cap)', 'garmentStyle');
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

// ─── Finishing steps (client's finishing flowcharts, 2026-09-23) ─────────────────────
// Every finishing formula has the same shape: each garment takes a fixed number of
// minutes, so hours = quantity * minutesPerUnit / 60. The client writes most of them as
// "QO * (60 / unitsPerHour) / 60" — i.e. a units-per-hour rate. The tables below keep
// the client's own numbers (the rate, or the minutes numerator) rather than
// pre-dividing them, so each one can be checked against the flowchart at a glance.

/** hours for `quantity` units at a flat `minutesPerUnit`. */
function perUnitHours(quantity: number, minutesPerUnit: number): number {
	return (quantity * minutesPerUnit) / 60;
}

// Printed Re-Label: QO * (60 / rate) / 60, rate keyed by weight class.
const RELABEL_UNITS_PER_HOUR: Record<WeightClass, number> = { THIN: 144, POLY: 144, BULKY: 72 };

// Hang Tags: QO * (60 / rate) / 60, rate keyed by weight class.
const HANG_TAG_UNITS_PER_HOUR: Record<WeightClass, number> = { THIN: 300, POLY: 300, BULKY: 150 };

// Fold & Bag: QO * (60 / rate) / 60, keyed on short-sleeve tee vs anything else — NOT
// weight class (see LineItem.foldBagGarment).
const FOLD_BAG_UNITS_PER_HOUR: Record<FoldBagGarment, number> = { SS_TEE: 300, OTHER: 100 };

// Matte Finish, Flat Surface: QO * (70 / rate) / 60 — note the numerator is 70, not 60
// like the other flowcharts (that's how the client's chart reads).
const MATTE_FLAT_MINUTES_NUMERATOR = 70;
const MATTE_FLAT_RATE: Record<WeightClass, number> = { THIN: 200, POLY: 200, BULKY: 100 };

// Matte Finish, Specialty Surface: QO * 1 / 60 — one minute per garment, the same for
// every weight class.
const MATTE_SPECIALTY_MINUTES_PER_UNIT = 1;

// Wovens: the client's chart reads "QO * (60/90)" with no trailing "/ 60", unlike every
// other finishing chart, and the client describes it as not fully thought out yet.
// ASSUMPTION (confirmed with Yara 2026-09-23, not yet with the client): the "/ 60" was
// just left off, so this is 90 units/hour like the other charts' pattern. Read
// literally it would be 40 minutes per garment (~67h for 100 units). Revisit once the
// client finalizes the Wovens formula.
const WOVENS_UNITS_PER_HOUR = 90;

function estimateFinishingHours(item: EstimateHoursInput): EstimateHoursResult {
	const quantity = item.quantity;
	switch (item.finishingStep) {
		case FinishingStep.RELABEL:
			return { station: 'printed_relabel', hours: perUnitHours(quantity, 60 / RELABEL_UNITS_PER_HOUR[item.weightClass]) };
		case FinishingStep.HANG_TAG:
			return { station: 'hang_tags', hours: perUnitHours(quantity, 60 / HANG_TAG_UNITS_PER_HOUR[item.weightClass]) };
		case FinishingStep.FOLD_BAG:
			if (!item.foldBagGarment) throw new MissingLineItemDataError('fold_bag_garment (SS tee vs other)', 'foldBagGarment');
			return { station: 'fold_bag', hours: perUnitHours(quantity, 60 / FOLD_BAG_UNITS_PER_HOUR[item.foldBagGarment]) };
		case FinishingStep.MATTE:
			if (!item.matteSurface) throw new MissingLineItemDataError('matte_surface (flat vs specialty)', 'matteSurface');
			if (item.matteSurface === MatteSurface.SPECIALTY) {
				return { station: 'matte_finish', hours: perUnitHours(quantity, MATTE_SPECIALTY_MINUTES_PER_UNIT) };
			}
			return { station: 'matte_finish', hours: perUnitHours(quantity, MATTE_FLAT_MINUTES_NUMERATOR / MATTE_FLAT_RATE[item.weightClass]) };
		case FinishingStep.WOVENS:
			return { station: 'wovens', hours: perUnitHours(quantity, 60 / WOVENS_UNITS_PER_HOUR) };
		default:
			throw new MissingFormulaError(`a finishing line item with finishingStep "${item.finishingStep}"`);
	}
}

/**
 * DTF (direct-to-film) and DTG (direct-to-garment) have no formula — the client says
 * their time depends on the artwork (2026-09-23) — so a reviewer answers "how many
 * hours does this job need?" and that number is the estimate. Missing → a
 * MissingLineItemDataError, which the order page turns into that question (and which
 * blocks confirming the import), never a guessed default.
 */
function estimateManualHours(item: EstimateHoursInput, station: string, label: string): EstimateHoursResult {
	const hours = item.manualEstimatedHours;
	if (hours == null || !(hours > 0)) {
		throw new MissingLineItemDataError(`manual_estimated_hours (${label} has no formula — how many hours does this job need?)`, 'manualEstimatedHours');
	}
	return { station, hours };
}

/**
 * Round to the nearest 15-minute increment, with a 15-minute floor so a very small
 * job never rounds to zero (which would give the scheduler a zero-duration slot).
 * Applied once here at the end of estimateHours so every consumer — Orders list,
 * order detail, draft board, propose_schedule — sees quarter-hour-aligned numbers
 * from the same source, without each caller re-implementing the rounding. Decision
 * made 2026-09-24: quarter-hour granularity matches how the shop plans days and
 * keeps the packed timeline from stacking irregular 3-minute overhangs.
 */
const QUARTER_HOUR = 0.25;
function roundToQuarterHour(hours: number): number {
	const rounded = Math.round(hours / QUARTER_HOUR) * QUARTER_HOUR;
	return Math.max(QUARTER_HOUR, rounded);
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
 *
 * The final hours are rounded to the nearest 15 minutes (see roundToQuarterHour
 * above) so estimates shown at import/order creation and slots produced by
 * propose_schedule share the same granularity.
 */
export function estimateHours(item: EstimateHoursInput): EstimateHoursResult {
	const raw = estimateHoursRaw(item);
	return { station: raw.station, hours: roundToQuarterHour(raw.hours) };
}

function estimateHoursRaw(item: EstimateHoursInput): EstimateHoursResult {
	if (item.itemType === LineItemType.DECORATION) {
		switch (item.decorationType) {
			case DecorationType.SCREEN_PRINT:
				return estimateScreenPrintAutoHours(item);
			case DecorationType.EMBROIDERY:
				// NEW (2026-09-21): this used to just throw MissingFormulaError — now it
				// actually computes a real answer via estimateEmbroideryHours above.
				return estimateEmbroideryHours(item);
			case DecorationType.DTF:
				return estimateManualHours(item, 'dtf', 'DTF');
			case DecorationType.DTG:
				return estimateManualHours(item, 'dtg', 'DTG');
			default:
				throw new MissingFormulaError(`a decoration line item with decorationType "${item.decorationType}"`);
		}
	}

	return estimateFinishingHours(item);
}
