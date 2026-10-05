import { DecorationType, FinishingStep, GarmentStyle, LineItemType, MatteSurface, type CapConstruction, type FoldBagGarment, type WeightClass } from '../../../../prisma/generated/prisma/enums';
import { expectedStationFor } from '$lib/schedule/expectedStation';
import { currentFormulas, maybeRefreshFormulas } from './formulaSettings';
import type { EstimateHoursInput, EstimateHoursResult } from './types';
import { countDecorationColors } from './decorationColors';

/**
 * Color count for screen print / embroidery. Never a question (2026-10-02: assume what
 * the PDF says): the stored count if set, else the colors the PDF's "Color(s)" column
 * lists, else 1. Editing the count on the order page still overrides it.
 */
function colorCountFor(item: EstimateHoursInput): number {
	return item.inkColorCount ?? countDecorationColors(item.decorationColors) ?? 1;
}

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
export type MissingLineItemField =
	| 'inkColorCount'
	| 'stitchCount'
	| 'garmentStyle'
	| 'capConstruction'
	| 'matteSurface'
	| 'foldBagGarment'
	| 'manualEstimatedHours'
	| 'assignedStationId';

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

// Screen-print rate tables (initial_units and rate_per_hr) are read live from
// currentFormulas() (see formulaSettings.ts), so an admin edit in Settings → Formulas
// shows up immediately without a code change. The default values still trace back to
// the client's screen_print_auto tab — see DEFAULT_FORMULAS.

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
	// number here — just a too-low one (setup shrinks to the fixed setup total). It
	// won't show as "pending" on the Orders page. Open question whether this should
	// throw MissingLineItemDataError instead, like embroidery does.
	const screens = item.screens ?? 0;
	const inkColorCount = colorCountFor(item);
	const sp = currentFormulas().screenPrint;

	// Setup time in minutes: per-screen + per-ink-color + a fixed baseline. All three
	// numbers are admin-editable in Settings → Formulas.
	const setupMinutes = screens * sp.setupMinutesPerScreen + inkColorCount * sp.setupMinutesPerInkColor + sp.setupFixedMinutes;

	// Look up how many garments are included "for free" before run time starts
	// counting, based on this job's weight class (THIN/POLY/BULKY).
	const initialUnits = sp.initialUnits[item.weightClass];
	if (initialUnits === undefined) {
		throw new MissingFormulaError(`the screen_print_auto initial_units table has no entry for weight class "${item.weightClass}"`);
	}

	// Figure out which screens bucket (< 5 or > 4) applies, then look up the
	// garments-per-hour rate for that bucket + this job's weight class.
	const regime = screenPrintRegime(screens);
	const ratePerHour = sp.ratePerHour[regime]?.[item.weightClass];
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
	// Crew (2026-09-28): only the run time speeds up with more people; setup is fixed.
	return { station: 'screen_print_auto', hours: (setupMinutes + runMinutes) / 60, crewDivisibleHours: runMinutes / 60 };
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

// Embroidery rate plans (thread-change minutes, flat + cap tables) are read live from
// currentFormulas().embroidery (see formulaSettings.ts) — admin-editable in Settings →
// Formulas. Defaults trace back to the client's embroidery tab; see DEFAULT_FORMULAS.

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
	const inkColorCount = colorCountFor(item); // "Y" — number of thread colors
	const stitchCount = item.stitchCount; // "X" — total stitches in the design
	if (stitchCount == null) throw new MissingLineItemDataError('stitch_count', 'stitchCount');

	const emb = currentFormulas().embroidery;
	// Pick which set of rate numbers (the "plan") applies to this specific job. A cap
	// needs its capConstruction (structured/unstructured) set too, since that's what
	// selects which cap plan to use — checked separately from the FLAT case just above
	// it, since FLAT doesn't need that field at all.
	let plan: EmbroideryRatePlan;
	if (item.garmentStyle === GarmentStyle.FLAT) {
		plan = emb.flat[item.weightClass];
	} else if (item.garmentStyle === GarmentStyle.CAP) {
		if (!item.capConstruction) throw new MissingLineItemDataError('cap_construction (structured vs unstructured)', 'capConstruction');
		plan = emb.cap[item.capConstruction];
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
	const threadChangeMinutes = inkColorCount * emb.threadChangeMinPerColor;
	const hoopingMinutes = (quantity / 6) * plan.hoopingFactor;
	const loadUnloadMinutes = (quantity / 6) * plan.loadUnloadFactor;
	const cleanupMinutes = (quantity / 6) * plan.cleanupFactor;
	const sewMinutes = (quantity / 6) * (stitchCount / plan.sewRateDivisor);

	// Add every step together, then convert from minutes to hours (÷ 60) since that's
	// the unit the rest of the scheduling engine expects back.
	const totalMinutes = setupBoxingMinutes + threadChangeMinutes + hoopingMinutes + loadUnloadMinutes + cleanupMinutes + sewMinutes;
	// Crew (client, 2026-09-28): only setup & boxing speeds up with more people — thread
	// changes, hooping, load/unload, cleanup and the machine's sew time don't.
	return { station: 'embroidery', hours: totalMinutes / 60, crewDivisibleHours: setupBoxingMinutes / 60 };
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

// Finishing formulas read from currentFormulas().finishing (see formulaSettings.ts) —
// admin-editable in Settings → Formulas. Defaults trace back to the client's
// finishing flowcharts; see DEFAULT_FORMULAS.

function estimateFinishingHours(item: EstimateHoursInput): EstimateHoursResult {
	const quantity = item.quantity;
	const fin = currentFormulas().finishing;
	switch (item.finishingStep) {
		case FinishingStep.RELABEL:
			return { station: 'printed_relabel', hours: perUnitHours(quantity, 60 / fin.relabelUnitsPerHour[item.weightClass]) };
		case FinishingStep.HANG_TAG:
			return { station: 'hang_tags', hours: perUnitHours(quantity, 60 / fin.hangTagUnitsPerHour[item.weightClass]) };
		case FinishingStep.FOLD_BAG:
			if (!item.foldBagGarment) throw new MissingLineItemDataError('fold_bag_garment (SS tee vs other)', 'foldBagGarment');
			return { station: 'fold_bag', hours: perUnitHours(quantity, 60 / fin.foldBagUnitsPerHour[item.foldBagGarment]) };
		case FinishingStep.MATTE:
			if (!item.matteSurface) throw new MissingLineItemDataError('matte_surface (flat vs specialty)', 'matteSurface');
			if (item.matteSurface === MatteSurface.SPECIALTY) {
				return { station: 'matte_finish', hours: perUnitHours(quantity, fin.matteSpecialtyMinutesPerUnit) };
			}
			return { station: 'matte_finish', hours: perUnitHours(quantity, fin.matteFlatMinutesNumerator / fin.matteFlatRate[item.weightClass]) };
		case FinishingStep.WOVENS:
			return { station: 'wovens', hours: perUnitHours(quantity, 60 / fin.wovensUnitsPerHour) };
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
	// Crew (client, 2026-09-28): the entered hours are for one person; more people divide them.
	return { station, hours, crewDivisibleHours: hours };
}

/**
 * OTHER rows (2026-09-28) — a job type the system doesn't model yet, e.g. "Patch
 * Install". Kept at import instead of dropped so a person can review it; it needs a
 * reviewer-assigned station and reviewer-entered hours, asked for in that order on the
 * order page. Placed only on that exact station (the result's `stationId`).
 */
export const OTHER_STATION_KIND = 'other';

function estimateOtherHours(item: EstimateHoursInput): EstimateHoursResult {
	const name = item.otherJobType ? `"${item.otherJobType}"` : 'this job';
	if (!item.assignedStationId) {
		throw new MissingLineItemDataError(`assigned station (${name} isn't a job type the system knows — which station does it run on?)`, 'assignedStationId');
	}
	const hours = item.manualEstimatedHours;
	if (hours == null || !(hours > 0)) {
		throw new MissingLineItemDataError(`manual_estimated_hours (${name} has no formula — how many hours does this job need?)`, 'manualEstimatedHours');
	}
	// Crew: not decided for OTHER jobs yet, so the entered hours stay fixed.
	return { station: OTHER_STATION_KIND, stationId: item.assignedStationId, hours, crewDivisibleHours: 0 };
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
 * MANUAL OVERRIDE (2026-09-28): a positive `estimatedHoursOverride` replaces the
 * formula's number for any job type with a real formula; `overridden: true` plus
 * `formulaHours` in the result tells the UI to show the engine's own estimate alongside
 * via `engineEstimateFor`. DTF, DTG, and OTHER have no formula and REQUIRE
 * `manualEstimatedHours` instead (never an override).
 *
 * The final hours are rounded to the nearest 15 minutes (see roundToQuarterHour
 * above) so estimates shown at import/order creation and slots produced by
 * propose_schedule share the same granularity.
 *
 * `crewSize` (2026-09-28): the client's formulas are the rate for ONE person. With N
 * people on the job, only its crew-divisible part (`crewDivisibleHours` — screen print
 * run time, embroidery setup & boxing, all finishing time, DTF/DTG entered hours) is
 * divided by N; everything else stays fixed. Default 1 = the unchanged formula.
 */
export function estimateHours(item: EstimateHoursInput, crewSize = 1): EstimateHoursResult {
	// Kick off a background refresh if the formula cache is older than its TTL — see
	// formulaSettings.ts's multi-instance note. The call is fire-and-forget; this
	// function still returns its result synchronously against whatever's cached.
	maybeRefreshFormulas();
	const raw = applyEstimateOverride(item);
	const crew = Math.max(1, Math.floor(crewSize));
	const divisible = raw.crewDivisibleHours ?? 0;
	const hours = raw.hours - divisible + divisible / crew;
	return { ...raw, hours: roundToQuarterHour(hours) };
}

/**
 * A person's edited estimate (2026-09-28, the order page): when the formula's number is
 * off, `estimatedHoursOverride` replaces it for this job (one-person hours). The station
 * still comes from the job's type, and a bigger crew still shrinks the same share of it
 * the formula would have (e.g. only screen print's run portion). If the formula can't
 * run yet — a missing field, or no formula — the person's number stands in for it:
 * decorations and finishing then treat all of it as crew-divisible (like DTF's entered
 * hours), OTHER jobs none of it, and an OTHER job still needs its station assigned.
 */
function applyEstimateOverride(item: EstimateHoursInput): EstimateHoursResult {
	const override = item.estimatedHoursOverride;
	if (override == null || !(override > 0)) return estimateHoursRaw(item);

	let formula: EstimateHoursResult | null = null;
	try {
		formula = estimateHoursRaw(item);
	} catch (error) {
		if (!(error instanceof EstimationError)) throw error;
	}
	if (formula) {
		const divisibleShare = formula.hours > 0 ? (formula.crewDivisibleHours ?? 0) / formula.hours : 0;
		return { ...formula, hours: override, crewDivisibleHours: override * divisibleShare, overridden: true, formulaHours: roundToQuarterHour(formula.hours) };
	}

	if (item.itemType === LineItemType.OTHER) {
		if (!item.assignedStationId) {
			throw new MissingLineItemDataError(`assigned station (which station does ${item.otherJobType ? `"${item.otherJobType}"` : 'this job'} run on?)`, 'assignedStationId');
		}
		return { station: OTHER_STATION_KIND, stationId: item.assignedStationId, hours: override, crewDivisibleHours: 0, overridden: true, formulaHours: null };
	}
	const kind = expectedStationFor(item);
	if (!kind) throw new MissingFormulaError(`a line item of type "${item.decorationType ?? item.finishingStep ?? item.itemType}"`);
	return { station: kind, hours: override, crewDivisibleHours: override, overridden: true, formulaHours: null };
}

/**
 * What the engine's formula would say for this line item, ignoring any manual
 * override. Returns null when the line item has no engine formula at all (DTF, DTG,
 * OTHER — for those the override IS the estimate, so there's nothing separate to
 * show alongside). Never throws: swallows MissingFormulaError/MissingLineItemDataError
 * and returns null, since this is display-only.
 */
export function engineEstimateFor(item: EstimateHoursInput): EstimateHoursResult | null {
	if (item.itemType === LineItemType.OTHER) return null;
	if (item.itemType === LineItemType.DECORATION && (item.decorationType === DecorationType.DTF || item.decorationType === DecorationType.DTG)) return null;
	try {
		const raw = estimateHoursRaw(item);
		return { ...raw, hours: roundToQuarterHour(raw.hours) };
	} catch (err) {
		if (err instanceof EstimationError) return null;
		throw err;
	}
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

	if (item.itemType === LineItemType.OTHER) return estimateOtherHours(item);

	// Every finishing formula is pure per-garment time, so all of it speeds up with crew.
	const finishing = estimateFinishingHours(item);
	return { ...finishing, crewDivisibleHours: finishing.hours };
}
