/**
 * Groups propose_schedule's "at risk" flags by plain-English reason, for showing them
 * as grouped at-risk cards. Read-only: it never changes a schedule. Note: as of
 * 2026-10-05 nothing imports this module — check for a caller before relying on it.
 */
import { prisma } from '$lib/server/prisma';
import { DEPENDENCY_REASON_PREFIX } from '$lib/server/engine/proposeSchedule';
import type { AtRiskFlag } from '$lib/server/engine/types';
import { stationKindLabel } from '$lib/schedule/stationKinds';

/**
 * Translates propose_schedule's at_risk flags into something Toby or Nate can actually
 * read. Four genuinely different failure modes reach here (see proposeSchedule.ts and
 * estimateHours.ts's EstimationError subclasses):
 *
 * 1. estimate_hours has no real formula for the station yet (MissingFormulaError,
 *    message prefixed "estimate_hours: ") — STATION_EXPLANATIONS below, keyed by the
 *    decoration/finishing enum value, covers this case.
 * 2. The station's formula is real, but this specific job is missing a field it needs
 *    (MissingLineItemDataError, message prefixed "missing_data: ") — e.g. an
 *    embroidery line item with no garmentStyle set. Different fix from #1: a human
 *    edits the line item, not a schema/formula decision — so it gets the error's own
 *    message (already plain-language) instead of STATION_EXPLANATIONS' "not set up"
 *    wording, which would wrongly imply the station itself isn't ready.
 * 3. A finisher waits on a job that couldn't be placed (message prefixed
 *    DEPENDENCY_REASON_PREFIX, "dependency: ") — fixing the prerequisite fixes this.
 * 4. estimate_hours succeeded but propose_schedule found no open capacity slot for
 *    it — the flag's requiredStation is then a station *kind* key (e.g.
 *    "screen_print_auto", see stationKinds.ts), not the decoration/finishing enum, and
 *    the real problem is missing Station/CapacityCalendar data, not missing timing.
 *    Mapping this through STATION_EXPLANATIONS' "timing isn't set up" sentences would
 *    be wrong once a formula is real but capacity isn't — so it gets its own message.
 *
 * This maps each flag to one plain sentence and groups every job hitting the same
 * reason together, instead of repeating a paragraph once per job.
 *
 * There is no literal duplication bug in propose_schedule's collection loop or the
 * backlog query (both checked directly) — a large, repetitive-looking list here is
 * genuinely many different confirmed line items each independently hitting the same
 * wall, not one job counted twice. Deduping by lineItemId below is a defensive safety
 * net, not a fix for a bug that was found.
 */
const STATION_EXPLANATIONS: Record<string, string> = {
	SCREEN_PRINT: 'Screen print timing isn’t set up for this job yet.',
	EMBROIDERY: 'Embroidery timing isn’t set up for this job yet.',
	DTF: 'DTF has no station or timing set up yet.',
	DTG: 'DTG has no station or timing set up yet.',
	MATTE: 'Matte finishing timing isn’t set up for this job yet.',
	RELABEL: 'Relabel timing isn’t set up for this job yet.',
	FOLD_BAG: 'Fold & bag timing isn’t set up for this job yet.',
	HANG_TAG: 'Hang tag timing isn’t set up for this job yet.',
	WOVENS: 'Wovens timing isn’t set up for this job yet.'
};

// These two prefixes are how this file tells apart WHY a job couldn't be scheduled,
// just by reading the start of the error message text. estimateHours.ts's two error
// classes each always start their message with one of these exact strings — see
// MissingFormulaError and MissingLineItemDataError there. If a message starts with
// neither prefix (nor the dependency prefix below), that means it came from
// proposeSchedule.ts's "no open slot" message, for the "we know the timing but have
// no capacity" case.
const NO_FORMULA_PREFIX = 'estimate_hours: ';
const MISSING_DATA_PREFIX = 'missing_data: ';
// proposeSchedule.ts's own prefix for "this finisher waits on a job that couldn't be placed."
const DEPENDENCY_PREFIX = DEPENDENCY_REASON_PREFIX;

/** Which of the four failure modes above a flag falls into — drives the card's icon/color. */
export type AtRiskCategory = 'formula' | 'missing_data' | 'dependency' | 'capacity';

/** One card's worth: a single reason and every job hitting it. */
export interface AtRiskGroup {
	category: AtRiskCategory;
	reason: string;
	jobs: { lineItemId: string; orderId: string; hoopsOrderId: string; customerName: string; design: string }[];
}

/**
 * Takes the raw list of "at risk" flags from propose_schedule (one per job that
 * couldn't be placed) and turns it into a shorter list of GROUPS, each with one
 * plain-English reason and the list of jobs affected by it — e.g. instead of showing
 * 24 separate lines that each say almost the same thing, this shows one line:
 * "Embroidery timing isn't set up for this job yet (24 jobs)".
 *
 * @returns the groups, biggest first
 */
export async function groupAtRiskForDisplay(atRisk: readonly AtRiskFlag[]): Promise<AtRiskGroup[]> {
	// Defensive dedupe by lineItemId — see doc comment above. `new Map(...)` here builds
	// a lookup table keyed by lineItemId; if the same lineItemId showed up twice in the
	// input array, the Map would just keep the last one, which naturally removes
	// duplicates without us having to write a separate dedupe step.
	const uniqueByLineItem = new Map(atRisk.map((flag) => [flag.lineItemId, flag]));

	// Go fetch the actual order/design info for every flagged line item in one query,
	// so we can show something readable ("Trail Network — HooDoo logo") instead of just
	// raw database ids.
	const lineItems = await prisma.lineItem.findMany({
		where: { id: { in: [...uniqueByLineItem.keys()] } },
		select: { id: true, design: true, order: { select: { id: true, hoopsOrderId: true, customerName: true } } }
	});
	const infoByLineItem = new Map(lineItems.map((item) => [item.id, item]));

	// This is where each flag gets sorted into one of four buckets and given its
	// plain-English explanation. We walk through every flagged job once, figure out
	// which of the four situations it's in, and build up `groups` — a Map from a
	// "group key" string to the group of jobs sharing that exact situation.
	const groups = new Map<string, AtRiskGroup>();
	for (const flag of uniqueByLineItem.values()) {
		// Check the very start of the error message to see which situation this is.
		const isMissingFormula = flag.reason.startsWith(NO_FORMULA_PREFIX);
		const isMissingLineItemData = flag.reason.startsWith(MISSING_DATA_PREFIX);

		let category: AtRiskCategory;
		let reason: string;
		if (isMissingFormula) {
			// Situation 1: we don't have a formula for this station at all yet. Look up
			// a friendly sentence for it, falling back to a generic one if this station
			// somehow isn't in the STATION_EXPLANATIONS list above.
			category = 'formula';
			reason = STATION_EXPLANATIONS[flag.requiredStation] ?? `No timing set up yet for "${flag.requiredStation}".`;
		} else if (isMissingLineItemData) {
			// Situation 2: the formula IS real, but this particular job is missing a
			// field the formula needs. MissingLineItemDataError already writes a clear,
			// human-readable message itself, so we just strip off the "missing_data: "
			// prefix and use its message as-is instead of writing a new one here.
			category = 'missing_data';
			reason = flag.reason.slice(MISSING_DATA_PREFIX.length);
		} else if (flag.reason.startsWith(DEPENDENCY_PREFIX)) {
			// Situation 3: a finisher whose print (or other prerequisite) couldn't be placed — it can't
			// go on the schedule before that job, so fixing the prerequisite fixes this.
			category = 'dependency';
			const detail = flag.reason.slice(DEPENDENCY_PREFIX.length);
			reason = detail.charAt(0).toUpperCase() + detail.slice(1);
		} else {
			// Situation 4: no prefix matched, so this must be proposeSchedule.ts's
			// "no open slot" message — the formula and job data are both fine, there's
			// just no available station capacity to actually place the job into.
			category = 'capacity';
			// requiredStation is a station kind (stationKinds.ts) — any active,
			// auto-scheduled station of that kind could have taken it, so the message
			// names the kind, not one machine.
			reason = `No open capacity on any ${stationKindLabel(flag.requiredStation)} station before this job's due date — either every one is full, or none is set up (or all are archived / manual-only) in Settings → Stations.`;
		}

		// Jobs get grouped together only if they share the SAME category, station, AND
		// exact reason text — that's why the key combines all three with "|" between
		// them. This matters for situation 2 especially: two embroidery jobs could be
		// missing two *different* fields (one missing garment_style, one missing
		// stitch_count), and we don't want to lump those into one misleading group.
		const groupKey = `${category}|${flag.requiredStation}|${reason}`;
		const group = groups.get(groupKey) ?? { category, reason, jobs: [] };
		const info = infoByLineItem.get(flag.lineItemId);
		if (info) {
			group.jobs.push({
				lineItemId: flag.lineItemId,
				orderId: info.order.id,
				hoopsOrderId: info.order.hoopsOrderId,
				customerName: info.order.customerName,
				design: info.design
			});
		}
		groups.set(groupKey, group);
	}

	// Return the groups as a plain array, biggest group first, so the most common
	// blocker shows up at the top of the page.
	return [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length);
}
