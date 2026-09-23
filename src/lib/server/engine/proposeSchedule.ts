import { SHIFT_END_MIN, SHIFT_START_MIN, wallClockEnd, workingMinutesUntilShiftEnd } from '$lib/schedule/shift';
import { estimateHours, EstimationError } from './estimateHours';
import type { AtRiskFlag, BacklogItem, CapacitySlot, ExternalDependencyState, ProposedAssignment, ProposeScheduleResult } from './types';

// Shared-setup family a job belongs to, for the ATCS-style batching preference:
// "same ink color / screen count / decoration type" per CLAUDE.md. Finishing jobs
// batch by finishingStep alone (they have no ink/screen count).
function batchFamilyKey(item: BacklogItem, stationName: string): string {
	if (item.decorationType) {
		return [stationName, item.decorationType, item.inkColorCount ?? 0, item.screens ?? 0].join('|');
	}
	return [stationName, item.finishingStep ?? ''].join('|');
}

function slotKey(stationId: string, date: Date): string {
	return `${stationId}__${date.toISOString().slice(0, 10)}`;
}

/** A wall-clock moment: which day (UTC midnight, ms) and which minute of that day. */
interface TimePoint {
	dayMs: number;
	minute: number;
}

function laterOf(a: TimePoint, b: TimePoint): TimePoint {
	if (a.dayMs !== b.dayMs) return a.dayMs > b.dayMs ? a : b;
	return a.minute >= b.minute ? a : b;
}

/** Prefix every dependency-caused at-risk reason starts with — explainAtRisk.ts keys
 *  its "waiting on another job" category off it, same pattern as estimateHours.ts's
 *  error prefixes. */
export const DEPENDENCY_REASON_PREFIX = 'dependency: ';

interface SlotState {
	slot: CapacitySlot;
	// Next free wall-clock minute on this station's day (jobs pack back-to-back).
	cursor: number;
	placedCount: number;
	families: Set<string>;
}

/**
 * Builds a proposed schedule. Never writes to the live schedule — only
 * commit_schedule, called after human approval, does that (see CLAUDE.md).
 *
 * Due date (backlog item's `dueDate`, i.e. the order's internal_due_date) is the
 * hard floor: jobs are placed earliest-due-date first, and only into a slot on or
 * before their due date. Within that constraint, a slot that already holds a
 * same-setup job is preferred over an earlier-but-unbatched one, so similar jobs
 * run back-to-back on one station's day (the published ATCS — Apparent Tardiness
 * Cost with Setups — heuristic that sequence_order exists for).
 *
 * DEPENDENCIES (2026-09-23 decision, replacing the old "blocked items never reach the
 * engine" rule): finishing rows are now scheduled ahead of time, and each one is
 * placed so it starts no earlier than the wall-clock END of every job it depends on
 * (`dependsOnIds`) — same day is fine, right after the print ends, no cure/dry buffer
 * (decided 2026-09-23). A job's dependencies are always placed before it. If a
 * dependency can't be placed (at risk, or not in this backlog and not already
 * complete), the dependent is flagged at risk too, with a reason saying so — never
 * placed before its print. This is enforced with real start/end times, which is why
 * the engine now returns `startMinuteOfDay` itself. `sequenceOrder` is STILL only
 * batch order within one station's day; cross-job ordering comes from dependsOnIds
 * and wall-clock times, never from sequenceOrder (CLAUDE.md's naming rule stands).
 * The floor-side lock is unchanged: a BLOCKED finisher can be on the schedule but
 * can't be Started until check_completion unlocks it (startAssignment.ts).
 *
 * An order whose due date has already passed never reaches this function at all —
 * fetchBacklog() excludes it entirely (2026-09-22 decision). A job that genuinely
 * can't get an on-time slot within the given capacity is flagged at risk, full stop.
 *
 * This is a simplified ATCS: it does not implement the heuristic's due-date/setup
 * lookahead weighting (those need tuning parameters this repo has no source for),
 * only its core idea of preferring a batch-mate's slot. Revisit once there's real
 * capacity data to tune against.
 */
export function proposeSchedule(
	backlog: readonly BacklogItem[],
	capacity: readonly CapacitySlot[],
	externalDependencies: ReadonlyMap<string, ExternalDependencyState> = new Map()
): ProposeScheduleResult {
	const slots = new Map<string, SlotState>();
	for (const slot of capacity) {
		slots.set(slotKey(slot.stationId, slot.date), { slot: { ...slot }, cursor: SHIFT_START_MIN, placedCount: 0, families: new Set() });
	}

	const assignments: ProposedAssignment[] = [];
	const atRisk: AtRiskFlag[] = [];
	const reasoning: string[] = [];

	const inBacklog = new Set(backlog.map((item) => item.id));
	// Wall-clock end of every job placed so far — what a dependent must start after.
	const placedEnd = new Map<string, TimePoint>();
	// Jobs that couldn't be placed (at risk) — their dependents can't be placed either.
	const unplaced = new Set<string>();

	function flag(item: BacklogItem, requiredStation: string, reason: string) {
		atRisk.push({ lineItemId: item.id, requiredStation, dueDate: item.dueDate, reason });
		reasoning.push(`${item.id}: AT RISK — ${reason}`);
		unplaced.add(item.id);
	}

	// Earliest due date first; a job is only taken once every dependency in this
	// backlog has been decided (placed or flagged), so prints always go before their
	// finishers even when both share a due date.
	const pending = [...backlog].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
	const isDecided = (id: string) => placedEnd.has(id) || unplaced.has(id) || !inBacklog.has(id);

	while (pending.length > 0) {
		const index = pending.findIndex((item) => (item.dependsOnIds ?? []).every(isDecided));
		if (index === -1) {
			// Only possible with a dependency cycle in the data — flag rather than loop.
			for (const item of pending.splice(0)) {
				flag(item, item.finishingStep ?? item.decorationType ?? 'unknown', `${DEPENDENCY_REASON_PREFIX}this job's dependencies form a cycle, so it can't be ordered.`);
			}
			break;
		}
		const [item] = pending.splice(index, 1);
		const dependsOnIds = item.dependsOnIds ?? [];

		const blockedBy = dependsOnIds.filter((id) => unplaced.has(id) || (!inBacklog.has(id) && externalDependencies.get(id) !== 'complete'));
		if (blockedBy.length > 0) {
			flag(
				item,
				item.finishingStep ?? item.decorationType ?? 'unknown',
				`${DEPENDENCY_REASON_PREFIX}waits on ${blockedBy.length} other job${blockedBy.length === 1 ? '' : 's'} on this order that couldn't be scheduled, and has to come after ${blockedBy.length === 1 ? 'it' : 'them'}.`
			);
			continue;
		}

		let estimate;
		try {
			estimate = estimateHours(item);
		} catch (error) {
			// EstimationError covers both MissingFormulaError and MissingLineItemDataError:
			// either way this job can't be estimated right now, so it's flagged at risk and
			// skipped instead of crashing the whole proposal. Anything else is a real bug.
			if (error instanceof EstimationError) {
				flag(item, item.decorationType ?? item.finishingStep ?? 'unknown', error.message);
				continue;
			}
			throw error;
		}

		// The earliest moment this job may start: the latest end among its dependencies
		// placed in this run (dependencies already complete impose no constraint).
		let earliest: TimePoint | null = null;
		for (const id of dependsOnIds) {
			const end = placedEnd.get(id);
			if (end) earliest = earliest ? laterOf(earliest, end) : end;
		}

		const workingMin = estimate.hours * 60;
		const family = batchFamilyKey(item, estimate.station);
		const candidates: { state: SlotState; start: number; gapMin: number }[] = [];
		for (const state of slots.values()) {
			const { slot } = state;
			if (slot.stationName !== estimate.station) continue;
			const dayMs = slot.date.getTime();
			if (dayMs > item.dueDate.getTime()) continue;
			if (earliest && dayMs < earliest.dayMs) continue;

			let start = state.cursor;
			let gapMin = 0;
			if (earliest && dayMs === earliest.dayMs && earliest.minute > start) {
				// Wait for the print to finish — the idle stretch before this job counts
				// against the day's capacity, so later jobs don't overbook it.
				gapMin = workingMinutesUntilShiftEnd(start) - workingMinutesUntilShiftEnd(earliest.minute);
				start = earliest.minute;
			}
			if (slot.availableHrs < estimate.hours + gapMin / 60) continue;
			// A dependency-constrained job on its dependency's day must actually finish
			// within the shift; otherwise it would visually pile up at 16:30.
			if (earliest && dayMs === earliest.dayMs && workingMinutesUntilShiftEnd(start) < workingMin) continue;
			candidates.push({ state, start, gapMin });
		}
		candidates.sort((a, b) => {
			const aBatched = a.state.families.has(family);
			const bBatched = b.state.families.has(family);
			if (aBatched !== bBatched) return aBatched ? -1 : 1;
			return a.state.slot.date.getTime() - b.state.slot.date.getTime();
		});

		const best = candidates[0];
		if (!best) {
			const due = item.dueDate.toISOString().slice(0, 10);
			flag(
				item,
				estimate.station,
				earliest
					? `No open slot at "${estimate.station}" after the job it waits on finishes and on or before ${due} with ${estimate.hours.toFixed(2)}h free.`
					: `No open slot at "${estimate.station}" on or before ${due} with ${estimate.hours.toFixed(2)}h free.`
			);
			continue;
		}

		const { state, start, gapMin } = best;
		const batched = state.families.has(family);
		state.slot.availableHrs -= estimate.hours + gapMin / 60;
		state.placedCount += 1;
		state.families.add(family);
		const end = Math.min(wallClockEnd(start, workingMin), SHIFT_END_MIN);
		state.cursor = end;
		placedEnd.set(item.id, { dayMs: state.slot.date.getTime(), minute: end });

		assignments.push({
			lineItemId: item.id,
			stationId: state.slot.stationId,
			stationName: state.slot.stationName,
			date: state.slot.date,
			sequenceOrder: state.placedCount,
			startMinuteOfDay: start,
			estimatedHours: estimate.hours
		});
		reasoning.push(
			`${item.id}: placed at "${state.slot.stationName}" on ${state.slot.date.toISOString().slice(0, 10)} (slot #${state.placedCount}, ${estimate.hours.toFixed(2)}h)` +
				(batched ? ' — batched with a same-setup job already on that slot' : '') +
				(earliest ? ' — after the job it waits on' : '')
		);
	}

	return { assignments, atRisk, reasoning };
}
