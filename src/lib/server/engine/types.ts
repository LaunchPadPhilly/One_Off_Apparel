import type {
	CapConstruction,
	DecorationType,
	FinishingStep,
	GarmentStyle,
	LineItemType,
	WeightClass
} from '../../../../prisma/generated/prisma/enums';

// The literal sentinel LineItem.dependsOn carries instead of another LineItem's id —
// see the schema note in prisma/schema.prisma and CLAUDE.md's Domain section. Shared
// here so check_completion and whatever creates finishing rows never drift on the string.
export const ALL_SIBLINGS_DEPENDENCY = 'all_siblings' as const;

/**
 * The subset of LineItem fields estimate_hours needs. Deliberately not the full Prisma
 * LineItem type: this keeps estimate_hours a pure function of plain data (callable
 * before a row even exists, e.g. during import review) and unit-testable against the
 * Consolidated IT spreadsheet without a database.
 */
export interface EstimateHoursInput {
	itemType: LineItemType;
	decorationType?: DecorationType | null;
	finishingStep?: FinishingStep | null;
	inkColorCount?: number | null;
	screens?: number | null;
	stitchCount?: number | null;
	quantity: number;
	weightClass: WeightClass;
	// NEW (2026-09-21): decoration-only, meaningful today for embroidery's
	// estimate_hours formula — see prisma/schema.prisma's LineItem.garmentStyle
	// comment. The `?` marks these as optional and `| null` allows null too, matching
	// how they're stored in the database (a line item might not have these set yet).
	garmentStyle?: GarmentStyle | null;
	capConstruction?: CapConstruction | null;
}

export interface EstimateHoursResult {
	// The station *name* (e.g. "screen_print_auto"), not a Station.id — resolving a
	// name to a real row is the caller's job (engine code stays DB-agnostic).
	station: string;
	hours: number;
}

/** One line item waiting to be placed, as propose_schedule needs it. */
export interface BacklogItem extends EstimateHoursInput {
	id: string;
	// The order's internal_due_date — the hard floor propose_schedule sorts and
	// places against. Never external_ship_date; see CLAUDE.md's orders table note.
	dueDate: Date;
}

/** One day's open capacity at one station, as propose_schedule needs it. */
export interface CapacitySlot {
	stationId: string;
	stationName: string;
	date: Date;
	availableHrs: number;
}

export interface ProposedAssignment {
	lineItemId: string;
	stationId: string;
	stationName: string;
	date: Date;
	sequenceOrder: number;
	estimatedHours: number;
}

export interface AtRiskFlag {
	lineItemId: string;
	requiredStation: string;
	dueDate: Date;
	reason: string;
}

export interface ProposeScheduleResult {
	assignments: ProposedAssignment[];
	atRisk: AtRiskFlag[];
	reasoning: string[];
}
