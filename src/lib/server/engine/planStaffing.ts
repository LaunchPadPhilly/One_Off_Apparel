import { estimateHours, EstimationError } from './estimateHours';
import { isPressKind, PRINTED_RELABEL_KIND } from '$lib/schedule/stationKinds';
import type { BacklogItem, CapacitySlot } from './types';

/**
 * Daily staffing (client decisions, 2026-09-28): who works which station each day.
 * Deterministic engine code — Claude never picks the crew itself.
 *
 * Rules:
 * - One person works one station for the whole day, so every job on a (station, day)
 *   shares that day's crew, and more people there shrink each job's crew-divisible
 *   time (estimateHours' `crewSize`).
 * - Only people certified on a station may work it, and nobody who is out that day.
 * - A person a human pinned to a station for a day (via Claude or the board's People
 *   panel) stays there.
 * - Screen-print presses (2026-10-14; refined 2026-10-15) run with a **lead** —
 *   first choice is a worker marked **main** (worker-level flag; may lead any press
 *   they're certified on). When no main is available, a worker marked **operator**
 *   (middle tier) opens the press as a fallback lead. Everyone else certified on
 *   the press is a **catch** who assists the lead. A press with no lead that day
 *   is closed, and nobody is on it — there's no catch without a lead, so anyone
 *   pinned there goes elsewhere. A running press gets its ideal catches (1 for
 *   shirts, 2 when the press's work is mostly hoodies — the BULKY weight class)
 *   before leftovers go anywhere, and no more than that: spare people go to other
 *   stations or stay free (a human can still pin extras onto a press). Any catch
 *   halves the whole press job (estimateHours); a second catch doesn't halve it
 *   again. Main-capable people are kept off catch and non-press work while someone
 *   else can do it, so they stay free to open a press; operators are preserved
 *   similarly below mains.
 * - Every other station with work waiting gets at least one person — the station whose
 *   certified people are scarcest is filled first (re-counted after each placement; a
 *   press first on a tie, so a lone lead opens the press instead of leaving its catches
 *   idle), and it takes the least-flexible (fewest-certifications) person, keeping
 *   flexible people free for elsewhere.
 * - Someone already crewing committed (approved / started) work that day comes in as
 *   pinned to that station (withCommittedCrew), so a new plan never puts them on a
 *   second station that day.
 * - Everyone left over goes where one more person saves the most time: the station
 *   with the largest crew-divisible workload per person (a station whose time barely
 *   shrinks with more people, like embroidery's machine sewing, draws few extras).
 * - No max crew on any station except a press (the floor is organic — client decision).
 * - A station with nobody on it that day has no capacity that day.
 *
 * With no roster at all (nobody entered in Settings → People) this returns the
 * capacity unchanged, so scheduling works exactly as before: one unnamed person per
 * job, every station open.
 *
 * Known simplification: workload is the whole backlog's, spread evenly over the
 * window's days, not re-planned day by day as jobs get placed. Good enough to aim
 * people at the busy stations; revisit if it staffs obviously wrong in practice. The
 * board's People panel re-plans one day from the jobs actually on it
 * (planStaffingForLoads with draftDayLoads).
 *
 * Called from fetchStaffedCapacity() (schedule/buildBacklogAndCapacity.ts) before every
 * engine run: automatic draft, propose_schedule and simulate_change.
 */

/** Ideal catches on a running press (client, 2026-10-14): shirts one, hoodies two. */
export const CATCHES_FOR_SHIRTS = 1;
export const CATCHES_FOR_HOODIES = 2;

/** One person on the roster, as the planner needs them. */
export interface StaffingWorker {
	id: string;
	/** Active stations this person is certified on. */
	stationIds: readonly string[];
	/** Worker-level press role (2026-10-15, replacing the earlier per-press
	 *  mainStationIds): a main may lead any press they're certified on; an
	 *  operator is a fallback lead the planner picks when no main is available.
	 *  If both are true, main wins (main > operator > catch). */
	isMain: boolean;
	isOperator: boolean;
}

/** Everything about people the planner needs, keyed by staffingKey() for per-day facts. */
export interface StaffingInputs {
	workers: readonly StaffingWorker[];
	/** `${workerId}|YYYY-MM-DD` for every day a person is out. */
	unavailable: ReadonlySet<string>;
	/** `${workerId}|YYYY-MM-DD` → stationId, for people a human pinned to a station. */
	pins: ReadonlyMap<string, string>;
}

/** The `${workerId}|YYYY-MM-DD` key for StaffingInputs' sets/maps. A Date is read as
 *  its UTC calendar day, matching how the engine keys capacity days. */
export function staffingKey(workerId: string, date: Date | string): string {
	return `${workerId}|${typeof date === 'string' ? date : date.toISOString().slice(0, 10)}`;
}

/**
 * `inputs` plus everyone crewing committed work, pinned to that work's station for its
 * day, so a new plan keeps them there (one person, one station a day). A human pin for
 * the same person and day wins. A press crew with no lead (no MAIN or OPERATOR) isn't a
 * crew (there's no catch without a lead), so it holds nobody.
 */
export function withCommittedCrew(
	inputs: StaffingInputs,
	rows: readonly { stationId: string; stationKind: string; date: Date; crew: readonly { workerId: string; role: 'MAIN' | 'OPERATOR' | 'CATCH' }[] }[]
): StaffingInputs {
	const pins = new Map(inputs.pins);
	for (const row of rows) {
		if (isPressKind(row.stationKind) && !row.crew.some((m) => m.role === 'MAIN' || m.role === 'OPERATOR')) continue;
		for (const { workerId } of row.crew) {
			const key = staffingKey(workerId, row.date);
			if (!pins.has(key)) pins.set(key, row.stationId);
		}
	}
	return { ...inputs, pins };
}

/** Waiting work on one station, in one-person hours. */
export interface StationLoad {
	total: number;
	/** The part of it that a bigger crew speeds up. */
	divisible: number;
	/** The part of it on BULKY (hoodie-weight) garments — sets a press's ideal catches. */
	bulky: number;
}

/** Adds one job's one-person estimate to `loads` under `stationId`. */
export function addLoad(loads: Map<string, StationLoad>, stationId: string, item: Pick<BacklogItem, 'weightClass'>, total: number, divisible: number) {
	const load = loads.get(stationId) ?? { total: 0, divisible: 0, bulky: 0 };
	load.total += total;
	load.divisible += divisible;
	if (item.weightClass === 'BULKY') load.bulky += total;
	loads.set(stationId, load);
}

/** Waiting work per station: a kind's work is split evenly over its stations; an OTHER
 *  job counts only toward the one station it's assigned to. Unestimable jobs are skipped. */
function stationLoads(backlog: readonly BacklogItem[], capacity: readonly CapacitySlot[]): Map<string, StationLoad> {
	const stationsByKind = new Map<string, Set<string>>();
	for (const slot of capacity) {
		const set = stationsByKind.get(slot.stationKind) ?? new Set<string>();
		set.add(slot.stationId);
		stationsByKind.set(slot.stationKind, set);
	}

	const loads = new Map<string, StationLoad>();
	for (const item of backlog) {
		let estimate;
		try {
			estimate = estimateHours(item);
		} catch (error) {
			if (error instanceof EstimationError) continue;
			throw error;
		}
		const divisible = estimate.crewDivisibleHours ?? 0;
		if (estimate.stationId) {
			addLoad(loads, estimate.stationId, item, estimate.hours, divisible);
			continue;
		}
		const stations = [...(stationsByKind.get(estimate.station) ?? [])];
		for (const stationId of stations) addLoad(loads, stationId, item, estimate.hours / stations.length, divisible / stations.length);
	}
	return loads;
}

/** How many catches a running press should get, from the share of its work that's hoodies. */
export function idealCatches(load: StationLoad | undefined): number {
	if (!load || load.total <= 0) return CATCHES_FOR_SHIRTS;
	return load.bulky > load.total / 2 ? CATCHES_FOR_HOODIES : CATCHES_FOR_SHIRTS;
}

/**
 * Assigns people to stations for each day in `capacity`, following the rules at the top
 * of this file. Pure: no DB access, inputs are not mutated.
 *
 * @returns the capacity slots that have someone working them, each with
 *   `crewWorkerIds` set (the main first on a press, then by id) and, on a press,
 *   `mainWorkerId`. Slots nobody is on
 *   (or a press with no main) are dropped — that station is closed that day. With an
 *   empty roster, a copy of `capacity` unchanged.
 */
export function planStaffing(backlog: readonly BacklogItem[], capacity: readonly CapacitySlot[], inputs: StaffingInputs): CapacitySlot[] {
	return planStaffingForLoads(stationLoads(backlog, capacity), capacity, inputs);
}

/**
 * planStaffingForLoads(): planStaffing() with the waiting work per station already
 * worked out — used by the board to re-plan one day from the jobs actually placed on it.
 * Same rules and result.
 */
export function planStaffingForLoads(loads: ReadonlyMap<string, StationLoad>, capacity: readonly CapacitySlot[], inputs: StaffingInputs): CapacitySlot[] {
	if (inputs.workers.length === 0) return capacity.map((slot) => ({ ...slot }));

	const hasWork = (stationId: string) => (loads.get(stationId)?.total ?? 0) > 0;
	const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
	// Least flexible first, so flexible people stay free for where they're needed most.
	const workersInOrder = [...inputs.workers].sort((a, b) => a.stationIds.length - b.stationIds.length || byId(a, b));
	const canLead = (worker: StaffingWorker) => worker.isMain || worker.isOperator;

	// Relabel-needs-press rule (CLAUDE.md Change 2 / 2026-10-14): Relabel is done BY the
	// press operator between press runs, so a candidate for a Printed Relabel station
	// must also be certified on at least one Screen Print (press) station. The engine
	// enforces this at crew-selection time; set_worker_station and the People form
	// enforce it on the write path.
	const stationKindById = new Map<string, string>();
	const pressStationIds = new Set<string>();
	for (const slot of capacity) {
		stationKindById.set(slot.stationId, slot.stationKind);
		if (isPressKind(slot.stationKind)) pressStationIds.add(slot.stationId);
	}
	const pressQualified = new Set<string>(
		inputs.workers.filter((w) => w.stationIds.some((id) => pressStationIds.has(id))).map((w) => w.id)
	);
	const workerAllowedForStation = (workerId: string, stationId: string) =>
		stationKindById.get(stationId) === PRINTED_RELABEL_KIND ? pressQualified.has(workerId) : true;

	const slotsByDay = new Map<string, CapacitySlot[]>();
	for (const slot of capacity) {
		const day = slot.date.toISOString().slice(0, 10);
		const list = slotsByDay.get(day) ?? [];
		list.push(slot);
		slotsByDay.set(day, list);
	}

	const result: CapacitySlot[] = [];
	for (const [day, slots] of slotsByDay) {
		const stationIdsToday = new Set(slots.map((slot) => slot.stationId));
		const isPress = new Map(slots.map((slot) => [slot.stationId, isPressKind(slot.stationKind)]));
		const crew = new Map<string, string[]>(slots.map((slot) => [slot.stationId, []]));
		// Per-press lead and lead role (2026-10-15). A main wins over an operator later,
		// so an operator placed as fallback lead gets upgraded when a main shows up — but
		// that case doesn't arise in the current ordering (mains lead first).
		const lead = new Map<string, { workerId: string; role: 'MAIN' | 'OPERATOR' }>();
		const free = new Set<string>();

		// A station is open once it has its lead: a lead on a press, anyone elsewhere.
		const isOpen = (stationId: string) => (isPress.get(stationId) ? lead.has(stationId) : crew.get(stationId)!.length > 0);
		const place = (worker: StaffingWorker, stationId: string) => {
			crew.get(stationId)!.push(worker.id);
			if (isPress.get(stationId) && !lead.has(stationId)) {
				if (worker.isMain) lead.set(stationId, { workerId: worker.id, role: 'MAIN' });
				else if (worker.isOperator) lead.set(stationId, { workerId: worker.id, role: 'OPERATOR' });
			}
			free.delete(worker.id);
		};

		// 1. Pinned people stay where a human put them; people who are out are skipped.
		//    A pinned main or operator on a press without a lead becomes its lead. A pin
		//    to a Printed Relabel station is only honored if the worker is press-qualified
		//    (set_worker_station already refuses the pin, but a later certification change
		//    could break the rule — fail safe here too).
		for (const worker of workersInOrder) {
			if (inputs.unavailable.has(staffingKey(worker.id, day))) continue;
			const pinned = inputs.pins.get(staffingKey(worker.id, day));
			if (pinned) {
				if (stationIdsToday.has(pinned) && workerAllowedForStation(worker.id, pinned)) place(worker, pinned);
				continue; // pinned somewhere not scheduled today (e.g. the manual press): not free either
			}
			free.add(worker.id);
		}

		// Free people who could lead `stationId`: on a press, mains first then operators
		// (main > operator > catch); off-press, anyone certified, catches first so mains
		// and operators stay free for presses.
		const eligibleLeads = (stationId: string) => {
			if (isPress.get(stationId)) {
				const certified = workersInOrder.filter((w) => free.has(w.id) && w.stationIds.includes(stationId));
				const mains = certified.filter((w) => w.isMain);
				const operators = certified.filter((w) => !w.isMain && w.isOperator);
				return [...mains, ...operators];
			}
			const people = workersInOrder.filter((w) => free.has(w.id) && w.stationIds.includes(stationId) && workerAllowedForStation(w.id, stationId));
			return [...people.filter((w) => !canLead(w)), ...people.filter(canLead)];
		};
		// Free people certified on `stationId`, non-leads first (for catches and extras),
		// so mains and operators stay available for presses that still need a lead.
		const eligibleCrew = (stationId: string) => {
			const people = workersInOrder.filter((w) => free.has(w.id) && w.stationIds.includes(stationId) && workerAllowedForStation(w.id, stationId));
			return [...people.filter((w) => !canLead(w)), ...people.filter(canLead)];
		};

		// 2a. **Mains-first pre-pass across presses (2026-10-15 — Main priority).**
		//     Before anything else, place every free main as the lead on a press they're
		//     certified on, scarcest-main press first (fewest certified mains, then
		//     heaviest load). A main may lead MORE THAN ONE press on the same day
		//     (2026-10-15 — the main physically moves between presses rather than the
		//     planner backing off to an operator). The main is still removed from the
		//     free pool for everything else that day (catches, non-press stations), so
		//     they aren't double-counted as catch too. If a main is leading more than
		//     one press, the plan says so in `reasoning` further up.
		const mainsUsed = new Set<string>();
		// A main already pinned to a press by step 1 is still available to lead another
		// press through the shared-main path below, so seed `mainsUsed` from the pins.
		for (const [, info] of lead) if (info.role === 'MAIN') mainsUsed.add(info.workerId);
		const openPressesForMains = () => {
			const needsLead = new Set(
				[...stationIdsToday].filter((id) => isPress.get(id) && hasWork(id) && !isOpen(id))
			);
			while (needsLead.size) {
				const ranked = [...needsLead]
					.map((id) => ({
						id,
						count: workersInOrder.filter((w) => (free.has(w.id) || mainsUsed.has(w.id)) && w.isMain && w.stationIds.includes(id)).length
					}))
					.sort(
						(a, b) =>
							a.count - b.count ||
							(loads.get(b.id)?.total ?? 0) - (loads.get(a.id)?.total ?? 0) ||
							a.id.localeCompare(b.id)
					);
				const { id: stationId } = ranked.find((r) => r.count > 0) ?? ranked[0];
				needsLead.delete(stationId);
				// A main that's already leading another press today may lead this one too —
				// `mainsUsed` keeps them eligible after the first placement. Prefer an
				// unused main first so load spreads across mains; only reuse an already-
				// leading main when no fresh one is certified on this press.
				const unused = workersInOrder.find((w) => free.has(w.id) && w.isMain && !mainsUsed.has(w.id) && w.stationIds.includes(stationId));
				const sharedMain = unused ? null : workersInOrder.find((w) => mainsUsed.has(w.id) && w.stationIds.includes(stationId));
				const person = unused ?? sharedMain;
				if (!person) continue;
				crew.get(stationId)!.push(person.id);
				lead.set(stationId, { workerId: person.id, role: 'MAIN' });
				mainsUsed.add(person.id);
			}
			// Mains that led at least one press today are consumed — not available as
			// catch, non-press crew, or leftovers.
			for (const id of mainsUsed) free.delete(id);
		};
		openPressesForMains();

		// 2b. Operator fallback — any press still without a lead gets its operator now.
		const openPressesForLeadKind = (filter: (worker: StaffingWorker) => boolean) => {
			const needsLead = new Set(
				[...stationIdsToday].filter((id) => isPress.get(id) && hasWork(id) && !isOpen(id))
			);
			while (needsLead.size) {
				const ranked = [...needsLead]
					.map((id) => ({
						id,
						count: workersInOrder.filter((w) => free.has(w.id) && filter(w) && w.stationIds.includes(id)).length
					}))
					.sort(
						(a, b) =>
							a.count - b.count ||
							(loads.get(b.id)?.total ?? 0) - (loads.get(a.id)?.total ?? 0) ||
							a.id.localeCompare(b.id)
					);
				const { id: stationId } = ranked.find((r) => r.count > 0) ?? ranked[0];
				needsLead.delete(stationId);
				const person = workersInOrder.find((w) => free.has(w.id) && filter(w) && w.stationIds.includes(stationId));
				if (person) place(person, stationId);
			}
		};
		openPressesForLeadKind((w) => !w.isMain && w.isOperator);

		// 2c. Non-press stations get their lead with the same scarcest-first rule as
		//     before. Presses already have (or couldn't get) their lead, so they're
		//     excluded here.
		const openStations = () => {
			const needsLead = new Set(
				[...stationIdsToday].filter((id) => !isPress.get(id) && hasWork(id) && !isOpen(id))
			);
			while (needsLead.size) {
				const ranked = [...needsLead]
					.map((id) => ({ id, count: eligibleLeads(id).length }))
					.sort(
						(a, b) =>
							a.count - b.count ||
							(loads.get(b.id)?.total ?? 0) - (loads.get(a.id)?.total ?? 0) ||
							a.id.localeCompare(b.id)
					);
				const { id: stationId } = ranked.find((r) => r.count > 0) ?? ranked[0];
				needsLead.delete(stationId);
				const person = eligibleLeads(stationId)[0];
				if (person) place(person, stationId); // else nobody who can lead it is in today — it stays closed
			}
		};
		openStations();

		// A catch only assists a lead (client, 2026-10-14; 2026-10-15 for operator-lead):
		// anyone pinned to a press that got no lead can't work there, so they go back to
		// the free pool — and may open a station that's still closed.
		let released = false;
		for (const stationId of stationIdsToday) {
			if (!isPress.get(stationId) || lead.has(stationId) || crew.get(stationId)!.length === 0) continue;
			for (const workerId of crew.get(stationId)!) free.add(workerId);
			crew.set(stationId, []);
			released = true;
		}
		if (released) openStations();

		// 3. Running presses get their ideal catches one round at a time, busiest press
		//    first — every press gets its first catch before any gets a second.
		const presses = [...stationIdsToday]
			.filter((id) => isPress.get(id) && lead.has(id) && hasWork(id))
			.sort((a, b) => (loads.get(b)?.total ?? 0) - (loads.get(a)?.total ?? 0) || a.localeCompare(b));
		for (let round = 1; round <= CATCHES_FOR_HOODIES; round++) {
			for (const stationId of presses) {
				if (round > idealCatches(loads.get(stationId)) || crew.get(stationId)!.length > round) continue;
				const person = eligibleCrew(stationId)[0];
				if (person) place(person, stationId);
			}
		}

		// 4. Everyone else goes where one more person saves the most time. Leads (mains
		//    and operators) are placed last so a non-lead fills each spot first.
		const leftovers = [...workersInOrder.filter((w) => !canLead(w)), ...workersInOrder.filter(canLead)];
		for (const worker of leftovers) {
			if (!free.has(worker.id)) continue;
			let best: string | null = null;
			let bestSaving = 0;
			for (const stationId of worker.stationIds) {
				if (!stationIdsToday.has(stationId) || !hasWork(stationId) || !isOpen(stationId)) continue; // step 2 already tried to open it
				if (!workerAllowedForStation(worker.id, stationId)) continue;
				const n = crew.get(stationId)!.length;
				if (isPress.get(stationId) && n >= 1 + idealCatches(loads.get(stationId))) continue; // a press's crew is its lead + ideal catches
				const saving = (loads.get(stationId)?.divisible ?? 0) / (n * (n + 1)); // time saved by the (n+1)th person
				if (saving > bestSaving || (saving === bestSaving && best !== null && stationId < best)) {
					best = stationId;
					bestSaving = saving;
				}
			}
			if (best) place(worker, best);
		}

		// 5. A station nobody can lead has no capacity today. Crew is listed lead first.
		for (const slot of slots) {
			if (!isOpen(slot.stationId)) continue;
			const slotLead = lead.get(slot.stationId);
			const leadId = slotLead?.workerId;
			const others = crew.get(slot.stationId)!.filter((id) => id !== leadId).sort();
			result.push({
				...slot,
				crewWorkerIds: leadId ? [leadId, ...others] : others,
				...(leadId ? { leadWorkerId: leadId, leadRole: slotLead!.role } : {})
			});
		}
	}
	return result;
}
