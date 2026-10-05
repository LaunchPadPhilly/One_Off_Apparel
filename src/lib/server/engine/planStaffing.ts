import { estimateHours, EstimationError } from './estimateHours';
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
 * - A person a human pinned to a station for a day (via Claude) stays there.
 * - Every station with work waiting gets at least one person — the station whose
 *   certified people are scarcest is filled first, and it takes the least-flexible
 *   (fewest-certifications) person, keeping flexible people free for elsewhere.
 * - Everyone left over goes where one more person saves the most time: the station
 *   with the largest crew-divisible workload per person (a station whose time barely
 *   shrinks with more people, like embroidery's machine sewing, draws few extras).
 * - No max crew per station (the floor is organic — client decision).
 * - A station with nobody on it that day has no capacity that day.
 *
 * With no roster at all (nobody entered in Settings → People) this returns the
 * capacity unchanged, so scheduling works exactly as before: one unnamed person per
 * job, every station open.
 *
 * Known simplification: workload is the whole backlog's, spread evenly over the
 * window's days, not re-planned day by day as jobs get placed. Good enough to aim
 * people at the busy stations; revisit if it staffs obviously wrong in practice.
 *
 * Called from fetchStaffedCapacity() (schedule/buildBacklogAndCapacity.ts) before every
 * engine run: automatic draft, propose_schedule and simulate_change.
 */

/** One person on the roster, as the planner needs them. */
export interface StaffingWorker {
	id: string;
	/** Active stations this person is certified on. */
	stationIds: readonly string[];
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

interface StationLoad {
	/** One-person hours of work waiting for this station. */
	total: number;
	/** The part of it that a bigger crew speeds up. */
	divisible: number;
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
	const add = (stationId: string, total: number, divisible: number) => {
		const load = loads.get(stationId) ?? { total: 0, divisible: 0 };
		load.total += total;
		load.divisible += divisible;
		loads.set(stationId, load);
	};

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
			add(estimate.stationId, estimate.hours, divisible);
			continue;
		}
		const stations = [...(stationsByKind.get(estimate.station) ?? [])];
		for (const stationId of stations) add(stationId, estimate.hours / stations.length, divisible / stations.length);
	}
	return loads;
}

/**
 * Assigns people to stations for each day in `capacity`, following the rules at the top
 * of this file. Pure: no DB access, inputs are not mutated.
 *
 * @returns the capacity slots that have someone working them, each with
 *   `crewWorkerIds` set (sorted). Slots nobody is on are dropped — that station is
 *   closed that day. With an empty roster, a copy of `capacity` unchanged.
 */
export function planStaffing(backlog: readonly BacklogItem[], capacity: readonly CapacitySlot[], inputs: StaffingInputs): CapacitySlot[] {
	if (inputs.workers.length === 0) return capacity.map((slot) => ({ ...slot }));

	const loads = stationLoads(backlog, capacity);
	const hasWork = (stationId: string) => (loads.get(stationId)?.total ?? 0) > 0;
	const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
	// Least flexible first, so flexible people stay free for where they're needed most.
	const workersInOrder = [...inputs.workers].sort((a, b) => a.stationIds.length - b.stationIds.length || byId(a, b));

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
		const crew = new Map<string, string[]>(slots.map((slot) => [slot.stationId, []]));
		const free = new Set<string>();

		// 1. Pinned people stay where a human put them; people who are out are skipped.
		for (const worker of workersInOrder) {
			if (inputs.unavailable.has(staffingKey(worker.id, day))) continue;
			const pinned = inputs.pins.get(staffingKey(worker.id, day));
			if (pinned) {
				if (stationIdsToday.has(pinned)) crew.get(pinned)!.push(worker.id);
				continue; // pinned somewhere not scheduled today (e.g. the manual press): not free either
			}
			free.add(worker.id);
		}
		const eligible = (stationId: string) => workersInOrder.filter((w) => free.has(w.id) && w.stationIds.includes(stationId));

		// 2. Every station with work gets at least one person, scarcest station first.
		const needsSomeone = [...stationIdsToday].filter((id) => hasWork(id) && crew.get(id)!.length === 0);
		needsSomeone.sort(
			(a, b) => eligible(a).length - eligible(b).length || (loads.get(b)?.total ?? 0) - (loads.get(a)?.total ?? 0) || a.localeCompare(b)
		);
		for (const stationId of needsSomeone) {
			const person = eligible(stationId)[0];
			if (!person) continue; // nobody certified is in today — this station stays closed
			crew.get(stationId)!.push(person.id);
			free.delete(person.id);
		}

		// 3. Everyone else goes where one more person saves the most time.
		for (const worker of workersInOrder) {
			if (!free.has(worker.id)) continue;
			let best: string | null = null;
			let bestSaving = 0;
			for (const stationId of worker.stationIds) {
				if (!stationIdsToday.has(stationId) || !hasWork(stationId)) continue;
				const n = crew.get(stationId)!.length;
				if (n === 0) continue; // step 2 already tried; no certified lead is in today
				const saving = (loads.get(stationId)?.divisible ?? 0) / (n * (n + 1)); // time saved by the (n+1)th person
				if (saving > bestSaving || (saving === bestSaving && best !== null && stationId < best)) {
					best = stationId;
					bestSaving = saving;
				}
			}
			if (best) {
				crew.get(best)!.push(worker.id);
				free.delete(worker.id);
			}
		}

		// 4. A station with nobody on it has no capacity today.
		for (const slot of slots) {
			const people = crew.get(slot.stationId)!;
			if (people.length > 0) result.push({ ...slot, crewWorkerIds: [...people].sort() });
		}
	}
	return result;
}
