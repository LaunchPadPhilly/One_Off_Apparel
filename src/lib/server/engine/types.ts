/**
 * Shared plain-data types for the scheduling engine (estimateHours, proposeSchedule,
 * planStaffing) plus the LineItem.dependsOn sentinel strings. Deliberately free of
 * Prisma model types and DB access, so engine code stays pure and testable; the
 * schedule/ layer (e.g. buildBacklogAndCapacity.ts) maps DB rows into these shapes.
 */
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
// NEW (2026-09-28): only for a MATTE row the import couldn't link to its design — it
// waits on every DECORATION row on the order instead. Deliberately NOT "all_siblings":
// that would include fold & bag, which itself waits on everything, and the two would
// wait on each other forever.
export const ALL_DECORATIONS_DEPENDENCY = 'all_decorations' as const;

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
	// The "Color(s)" text from the PDF. Stands in for inkColorCount when that's empty
	// (2026-10-02: assume what's in the PDF instead of asking) — see colorCountFor().
	decorationColors?: string | null;
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
	// NEW (2026-09-28): a person's corrected one-person estimate (order page). Replaces
	// the formula's hours when set — see estimateHours.ts' applyEstimateOverride.
	estimatedHoursOverride?: number | null;
}

/** What estimate_hours returns for one line item: where it runs and for how long. */
export interface EstimateHoursResult {
	// The station *kind* (e.g. "screen_print_auto" — see $lib/schedule/stationKinds.ts),
	// not a Station.id — which real station of that kind a job lands on is
	// propose_schedule's choice (engine code stays DB-agnostic).
	station: string;
	// NEW (2026-09-28): set only for OTHER rows — the one exact station the reviewer
	// assigned. When present, the job may only be placed on this station.
	stationId?: string;
	hours: number;
	// NEW (2026-09-28): how much of the ONE-person time speeds up with a bigger crew
	// (unrounded). estimateHours(item, crewSize) divides only this part by the crew.
	crewDivisibleHours?: number;
	// NEW (2026-09-28): true when a person's edited estimate replaced the formula, and
	// what the formula alone would say (rounded; null when it can't run yet). Callers
	// show "Engine estimated ~X.Xh" alongside an override; the engine estimate is what
	// `engineEstimateFor` returns for that same line item.
	overridden?: boolean;
	formulaHours?: number | null;
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
	// resolved from LineItem.dependsOn (a specific id, every decoration for
	// "all_decorations", or every sibling for "all_siblings"). Empty/absent for
	// decoration rows. See proposeSchedule.ts.
	dependsOnIds?: string[];
}

/** NEW (2026-09-23): what's known about a dependency that ISN'T in this backlog run —
 *  either it's already done (no constraint), or it can't be scheduled yet (so its
 *  dependents can't be either). A dependency id that's in neither the backlog nor this
 *  map is treated as not schedulable. */
export type ExternalDependencyState = 'complete' | 'not_schedulable' | ScheduledDependency;

/** A dependency that's already on the committed schedule and stays where it is during
 *  this run (2026-10-05 re-planning): started, or approved outside the days being
 *  re-planned. Its dependents are placed after `endsAt`, like any placed print. */
export interface ScheduledDependency {
	/** When it ends: the day (UTC midnight, in ms) and the minute of that day. */
	endsAt: { dayMs: number; minute: number };
}

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
	// NEW (2026-09-28): the people working this station that day (planStaffing.ts).
	// Absent = no roster in use, so jobs are estimated for one person (the old behavior).
	crewWorkerIds?: string[];
	// NEW (2026-10-05): work already committed to this slot that this run keeps in
	// place. `availableHrs` should already have those hours taken out; these say where
	// the day's free time starts (minute of day) and how many jobs are already queued,
	// so new jobs go after them. Absent = an empty day starting at shift open.
	busyUntilMin?: number;
	committedJobCount?: number;
}

/** One job the engine placed: which station, which day, when, and for how long. */
export interface ProposedAssignment {
	lineItemId: string;
	stationId: string;
	stationName: string;
	date: Date;
	// Batch order within this station's day ONLY — never cross-job dependency ordering
	// (that's dependsOnIds + startMinuteOfDay). See CLAUDE.md's naming conventions.
	sequenceOrder: number;
	// NEW (2026-09-23): wall-clock start (minutes from midnight) on the shift model in
	// $lib/schedule/shift.ts. The engine now owns this (it used to be packed afterward
	// in proposeIntoNewDraft.ts) because a finisher's start has to come after its
	// print's wall-clock end, not just on the same-or-later day.
	startMinuteOfDay: number;
	estimatedHours: number;
	// NEW (2026-09-28): the crew the hours were estimated for (empty = one unnamed person).
	crewWorkerIds: string[];
}

/** A job the engine could not place on time, with why (flag_at_risk — never hidden). */
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

/** Everything proposeSchedule returns. Nothing in it is saved until commit_schedule. */
export interface ProposeScheduleResult {
	assignments: ProposedAssignment[];
	atRisk: AtRiskFlag[];
	reasoning: string[];
}
