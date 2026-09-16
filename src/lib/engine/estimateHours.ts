import { DecorationType, FinishingStep, LineItemType, WeightClass } from '../../../prisma/generated/prisma/enums';
import type { EstimateHoursInput, EstimateHoursResult, EstimateStep } from './types';

export class MissingFormulaError extends Error {
	constructor(what: string) {
		super(`estimate_hours: ${what}`);
		this.name = 'MissingFormulaError';
	}
}

function roundTo15Min(hours: number): number {
	return Math.ceil(hours * 4) / 4;
}

function buildResult(station: string, steps: EstimateStep[]): EstimateHoursResult {
	const totalMinutes = steps.reduce((sum, s) => sum + s.minutes, 0);
	return { station, hours: roundTo15Min(totalMinutes / 60), rawMinutes: totalMinutes, steps };
}

// ---------------------------------------------------------------------------
// Screen Print (AUTO)
// Variables: Y = screens, X = ink colors, Z = quantity
// ---------------------------------------------------------------------------

interface ScreenPrintParams {
	initialPrintUnits: number;
	printUnitsPerHr: number;
}

const SCREEN_PRINT_LT5: Record<WeightClass, ScreenPrintParams> = {
	[WeightClass.THIN]:  { initialPrintUnits: 100, printUnitsPerHr: 360 },
	[WeightClass.POLY]:  { initialPrintUnits: 80,  printUnitsPerHr: 288 },
	[WeightClass.BULKY]: { initialPrintUnits: 50,  printUnitsPerHr: 180 },
};

const SCREEN_PRINT_GT4: Record<WeightClass, ScreenPrintParams> = {
	[WeightClass.THIN]:  { initialPrintUnits: 100, printUnitsPerHr: 180 },
	[WeightClass.POLY]:  { initialPrintUnits: 80,  printUnitsPerHr: 144 },
	[WeightClass.BULKY]: { initialPrintUnits: 50,  printUnitsPerHr: 90 },
};

function estimateScreenPrintAutoHours(item: EstimateHoursInput): EstimateHoursResult {
	const Y = item.screens ?? 0;
	const X = item.inkColorCount ?? 0;
	const Z = item.quantity;

	const regime = Y < 5 ? 'screens < 5' : 'screens > 4';
	const params = (Y < 5 ? SCREEN_PRINT_LT5 : SCREEN_PRINT_GT4)[item.weightClass];

	const screenSetup = Y * 5;
	const inkSetup = X * 15;
	const runMinutes = Math.max(0, Z - params.initialPrintUnits) * (60 / params.printUnitsPerHr);

	const steps: EstimateStep[] = [
		{ label: 'Screen Setup', formula: `${Y} screens x 5 min`, minutes: screenSetup },
		{ label: 'Ink Setup', formula: `${X} colors x 15 min`, minutes: inkSetup },
		{ label: 'Initial Setup', formula: '30 min', minutes: 30 },
		{ label: 'Initial Config', formula: '30 min', minutes: 30 },
		{ label: 'Print Run', formula: `(${Z} - ${params.initialPrintUnits}) x 60/${params.printUnitsPerHr} [${regime}]`, minutes: runMinutes },
	];

	return buildResult('screen_print_auto', steps);
}

// ---------------------------------------------------------------------------
// Embroidery (Flat garment style)
// Variables: Z = quantity, Y = thread count, X = stitch count
// ---------------------------------------------------------------------------

function estimateEmbroideryHours(item: EstimateHoursInput): EstimateHoursResult {
	const Z = item.quantity;
	const Y = item.inkColorCount ?? 1;
	const X = item.stitchCount ?? 0;

	const steps: EstimateStep[] = [];

	switch (item.weightClass) {
		case WeightClass.THIN: {
			steps.push(
				{ label: 'Setup/Boxing', formula: `${Z} x 60/240`, minutes: Z * (60 / 240) },
				{ label: 'Thread Change', formula: `${Y} threads x 5 min`, minutes: Y * 5 },
				{ label: 'Hooping', formula: `(${Z}/6) x 1.5`, minutes: (Z / 6) * 1.5 },
				{ label: 'Load/Unload', formula: `(${Z}/6) x 2`, minutes: (Z / 6) * 2 },
				{ label: 'Cleanup', formula: `(${Z}/6) x 4`, minutes: (Z / 6) * 4 },
				{ label: 'Sew Time', formula: `(${Z}/6) x (${X}/850)`, minutes: (Z / 6) * (X / 850) },
				{ label: 'Steaming', formula: `${Z} x 60/360`, minutes: Z * (60 / 360) },
			);
			break;
		}
		case WeightClass.POLY: {
			steps.push(
				{ label: 'Setup/Boxing', formula: `${Z} x 60/180`, minutes: Z * (60 / 180) },
				{ label: 'Hooping', formula: `(${Z}/6) x 2`, minutes: (Z / 6) * 2 },
				{ label: 'Cleanup', formula: `(${Z}/6) x 6`, minutes: (Z / 6) * 6 },
			);
			break;
		}
		case WeightClass.BULKY: {
			steps.push(
				{ label: 'Setup/Boxing', formula: `${Z} x 60/120`, minutes: Z * (60 / 120) },
				{ label: 'Hooping', formula: `(${Z}/6) x 1.5`, minutes: (Z / 6) * 1.5 },
				{ label: 'Cleanup', formula: `(${Z}/6) x 4`, minutes: (Z / 6) * 4 },
			);
			break;
		}
	}

	return buildResult('embroidery', steps);
}

// ---------------------------------------------------------------------------
// Printed Relabel — Z = quantity
// ---------------------------------------------------------------------------

const RELABEL_UNITS_PER_HR: Record<WeightClass, number> = {
	[WeightClass.THIN]:  144,
	[WeightClass.POLY]:  144,
	[WeightClass.BULKY]: 72,
};

function estimateRelabelHours(item: EstimateHoursInput): EstimateHoursResult {
	const Z = item.quantity;
	const rate = RELABEL_UNITS_PER_HR[item.weightClass];
	const minutes = Z * (60 / rate);
	return buildResult('printed_relabel', [
		{ label: 'Relabel', formula: `${Z} x 60/${rate}`, minutes },
	]);
}

// ---------------------------------------------------------------------------
// Fold & Bag — defaults to "Other" rate (no garment category field yet)
// ---------------------------------------------------------------------------

function estimateFoldBagHours(item: EstimateHoursInput): EstimateHoursResult {
	const Z = item.quantity;
	const ratePerHr = 100;
	const minutes = Z * (60 / ratePerHr);
	return buildResult('fold_bag', [
		{ label: 'Fold & Bag', formula: `${Z} x 60/${ratePerHr} [Other rate]`, minutes },
	]);
}

// ---------------------------------------------------------------------------
// Matte Finish — defaults to Flat surface
// ---------------------------------------------------------------------------

function estimateMatteHours(item: EstimateHoursInput): EstimateHoursResult {
	const Z = item.quantity;
	let minutes: number;
	let formula: string;
	switch (item.weightClass) {
		case WeightClass.THIN:
		case WeightClass.POLY:
			minutes = Z * (70 / 200);
			formula = `${Z} x 70/200`;
			break;
		case WeightClass.BULKY:
			minutes = Z * (70 / 100);
			formula = `${Z} x 70/100`;
			break;
	}
	return buildResult('matte_finish', [
		{ label: 'Matte (Flat)', formula, minutes },
	]);
}

// ---------------------------------------------------------------------------
// Hang Tags
// ---------------------------------------------------------------------------

const HANG_TAG_UNITS_PER_HR: Record<WeightClass, number> = {
	[WeightClass.THIN]:  300,
	[WeightClass.POLY]:  300,
	[WeightClass.BULKY]: 150,
};

function estimateHangTagHours(item: EstimateHoursInput): EstimateHoursResult {
	const Z = item.quantity;
	const rate = HANG_TAG_UNITS_PER_HR[item.weightClass];
	const minutes = Z * (60 / rate);
	return buildResult('hang_tags', [
		{ label: 'Hang Tags', formula: `${Z} x 60/${rate}`, minutes },
	]);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function estimateHours(item: EstimateHoursInput): EstimateHoursResult {
	if (item.itemType === LineItemType.DECORATION) {
		switch (item.decorationType) {
			case DecorationType.SCREEN_PRINT:
				return estimateScreenPrintAutoHours(item);
			case DecorationType.EMBROIDERY:
				return estimateEmbroideryHours(item);
			case DecorationType.DTF:
				throw new MissingFormulaError('DTF has no station or formula in the source spreadsheet');
			case DecorationType.DTG:
				throw new MissingFormulaError('DTG has no station or formula in the source spreadsheet');
			default:
				throw new MissingFormulaError(`Unknown decoration type "${item.decorationType}"`);
		}
	}

	switch (item.finishingStep) {
		case FinishingStep.MATTE:
			return estimateMatteHours(item);
		case FinishingStep.RELABEL:
			return estimateRelabelHours(item);
		case FinishingStep.FOLD_BAG:
			return estimateFoldBagHours(item);
		case FinishingStep.HANG_TAG:
			return estimateHangTagHours(item);
		default:
			throw new MissingFormulaError(`Unknown finishing step "${item.finishingStep}"`);
	}
}
