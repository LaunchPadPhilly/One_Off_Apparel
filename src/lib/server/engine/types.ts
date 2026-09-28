import type {
	CapConstruction,
	DecorationType,
	FinishingStep,
	FoldBagGarment,
	GarmentStyle,
	MatteSurface,
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
	// NEW (2026-09-23): finishing-only — MATTE rows need matteSurface, FOLD_BAG rows
	// need foldBagGarment. See prisma/schema.prisma's LineItem comments.
	matteSurface?: MatteSurface | null;
	foldBagGarment?: FoldBagGarment | null;
	// NEW (2026-09-23): reviewer-entered hours for DTF/DTG (no formula exists).
	manualEstimatedHours?: number | null;
	// NEW (2026-09-28): OTHER rows only (a job type the system doesn't model, e.g.
	// "Patch Install") — the export's name for it, and the station a reviewer assigned.
	otherJobType?: string | null;
	assignedStationId?: string | null;
}

export interface EstimateHoursResult {
	// The station *kind* (e.g. "screen_print_auto" — see $lib/schedule/stationKinds.ts),
	// not a Station.id — which real station of that kind a job lands on is
	// propose_schedule's choice (engine code stays DB-agnostic).
	station: string;
	// NEW (2026-09-28): set only for OTHER rows — the one exact station the reviewer
	// assigned. When present, the job may only be placed on this station.
	stationId?: string;
	hours: number;
	// true when `hours` came from LineItem.manualEstimatedHours (either a reviewer
	// override on a job that has a real formula, or the required hours entry for a
	// job with no formula — DTF/DTG/OTHER). false or absent when `hours` was computed
	// by the engine. Callers show "Engine estimated ~X.Xh" alongside an override; the
	// engine estimate is what `engineEstimateFor` returns for that same line item.
	fromManualOverride?: boolean;
}

/** One line item waiting to be placed, as propose_schedule needs it. */
export interface BacklogItem extends EstimateHoursInput {
	id: string;
	// The order's `deadline` — the hard floor propose_schedule sorts and places
	// against. Since 2026-09-28 there is only one date on an order (see the Order
	// model in prisma/schema.prisma); its meaning (firm customer commitment vs
	// internal target) is carried alongside on `deadlineIsTight`, not by a second
	// date.
	dueDate: Date;
	// true = firm customer commitment; false = internal target. Placement is
	// identical either way (both cap the job's latest-possible day at `dueDate`);
	// only the meaning of an at-risk flag against it softens for internal targets.
	deadlineIsTight: boolean;
	// NEW (2026-09-23): the line item ids this job must be scheduled AFTER — already
	// resolved from LineItem.dependsOn (a specific id, or every sibling for
	// "all_siblings"). Empty/absent for decoration rows. See proposeSchedule.ts.
	dependsOnIds?: string[];
}

/** NEW (2026-09-23): what's known about a dependency that ISN'T in this backlog run —
 *  either it's already done (no constraint), or it can't be scheduled yet (so its
 *  dependents can't be either). A dependency id that's in neither the backlog nor this
 *  map is treated as not schedulable. */
export type ExternalDependencyState = 'complete' | 'not_schedulable';

/** One day's open capacity at one station, as propose_schedule needs it. */
export interface CapacitySlot {
	stationId: string;
	stationName: string;
	// The station's kind (2026-09-25) — what propose_schedule matches an estimate's
	// `station` against, so a job can land on any station of the right kind (e.g.
	// either of two auto presses).
	stationKind: string;
	date: Date;
	availableHrs: number;
}

export interface ProposedAssignment {
	lineItemId: string;
	stationId: string;
	stationName: string;
	date: Date;
	sequenceOrder: number;
	// NEW (2026-09-23): wall-clock start (minutes from midnight) on the shift model in
	// $lib/schedule/shift.ts. The engine now owns this (it used to be packed afterward
	// in proposeIntoNewDraft.ts) because a finisher's start has to come after its
	// print's wall-clock end, not just on the same-or-later day.
	startMinuteOfDay: number;
	estimatedHours: number;
}

export interface AtRiskFlag {
	lineItemId: string;
	requiredStation: string;
	dueDate: Date;
	// Whether the missed dueDate above is a firm customer commitment (true) or an
	// internal target (false). Set from the source Order's deadlineIsTight so the UI
	// can display an at-risk flag against a loose target more softly than one that
	// misses a customer promise. The engine's placement math itself doesn't branch on
	// this; it only carries the label through.
	deadlineIsTight: boolean;
	reason: string;
}

export interface ProposeScheduleResult {
	assignments: ProposedAssignment[];
	atRisk: AtRiskFlag[];
	reasoning: string[];
}
