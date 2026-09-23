import { estimateHours, EstimationError } from './estimateHours';
import type { AtRiskFlag, BacklogItem, CapacitySlot, ProposedAssignment, ProposeScheduleResult } from './types';

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
 * An order whose due date has already passed never reaches this function at all —
 * fetchBacklog() excludes it entirely (2026-09-22 decision), so there is no "place it
 * anyway, past due" fallback here to worry about. A job that genuinely can't get an
 * on-time slot within the given capacity is flagged at risk, full stop.
 *
 * This is a simplified ATCS: it does not implement the heuristic's due-date/setup
 * lookahead weighting (those need tuning parameters this repo has no source for),
 * only its core idea of preferring a batch-mate's slot. Revisit once there's real
 * capacity data to tune against.
 *
 * Do not add dependency checking here — see CLAUDE.md: a blocked line item is
 * simply never in the backlog, and check_completion + LineItem.dependsOn already
 * own that. Reintroducing it here is the exact regression CLAUDE.md warns about.
 */
export function proposeSchedule(backlog: readonly BacklogItem[], capacity: readonly CapacitySlot[]): ProposeScheduleResult {
	const remaining = new Map<string, CapacitySlot>();
	for (const slot of capacity) {
		remaining.set(slotKey(slot.stationId, slot.date), { ...slot });
	}

	// Which batch families already have a job sitting in a given (station, date) slot.
	const familiesInSlot = new Map<string, Set<string>>();
	// Running count of jobs already placed in a slot, for sequence_order.
	const placedInSlot = new Map<string, number>();

	const assignments: ProposedAssignment[] = [];
	const atRisk: AtRiskFlag[] = [];
	const reasoning: string[] = [];

	const jobs = [...backlog].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

	for (const item of jobs) {
		let estimate;
		try {
			estimate = estimateHours(item);
		} catch (error) {
			// NEW (2026-09-21): this used to only catch MissingFormulaError specifically.
			// It now catches EstimationError instead, which is the shared parent class of
			// BOTH MissingFormulaError ("we have no formula for this station at all") and
			// MissingLineItemDataError ("the formula exists, but this one job is missing a
			// field it needs"). Either way, the effect here is the same: we can't estimate
			// this job's hours right now, so it gets flagged "at risk" and skipped, instead
			// of crashing the whole schedule proposal for every other job too.
			if (error instanceof EstimationError) {
				atRisk.push({
					lineItemId: item.id,
					requiredStation: item.decorationType ?? item.finishingStep ?? 'unknown',
					dueDate: item.dueDate,
					reason: error.message
				});
				reasoning.push(`${item.id}: AT RISK — cannot estimate hours (${error.message})`);
				continue;
			}
			// Any OTHER kind of error (a genuine bug, not "we can't estimate this yet") is
			// re-thrown as-is, rather than swallowed — we only want to treat the two
			// expected/known error types above as "just flag it and move on."
			throw error;
		}

		const family = batchFamilyKey(item, estimate.station);
		const candidates = [...remaining.values()]
			.filter((slot) => slot.stationName === estimate.station)
			.filter((slot) => slot.date.getTime() <= item.dueDate.getTime())
			.filter((slot) => slot.availableHrs >= estimate.hours)
			.sort((a, b) => {
				const aBatched = familiesInSlot.get(slotKey(a.stationId, a.date))?.has(family) ?? false;
				const bBatched = familiesInSlot.get(slotKey(b.stationId, b.date))?.has(family) ?? false;
				if (aBatched !== bBatched) return aBatched ? -1 : 1;
				return a.date.getTime() - b.date.getTime();
			});

		const bestSlot = candidates[0];
		if (!bestSlot) {
			atRisk.push({
				lineItemId: item.id,
				requiredStation: estimate.station,
				dueDate: item.dueDate,
				reason: `No open slot at "${estimate.station}" on or before ${item.dueDate.toISOString().slice(0, 10)} with ${estimate.hours.toFixed(2)}h free.`
			});
			reasoning.push(`${item.id}: AT RISK — due ${item.dueDate.toISOString().slice(0, 10)}, needs ${estimate.hours.toFixed(2)}h at "${estimate.station}", none found`);
			continue;
		}

		const key = slotKey(bestSlot.stationId, bestSlot.date);
		bestSlot.availableHrs -= estimate.hours;
		const sequenceOrder = (placedInSlot.get(key) ?? 0) + 1;
		placedInSlot.set(key, sequenceOrder);
		const families = familiesInSlot.get(key) ?? new Set<string>();
		const batched = families.has(family);
		families.add(family);
		familiesInSlot.set(key, families);

		assignments.push({
			lineItemId: item.id,
			stationId: bestSlot.stationId,
			stationName: bestSlot.stationName,
			date: bestSlot.date,
			sequenceOrder,
			estimatedHours: estimate.hours
		});
		reasoning.push(
			`${item.id}: placed at "${bestSlot.stationName}" on ${bestSlot.date.toISOString().slice(0, 10)} (slot #${sequenceOrder}, ${estimate.hours.toFixed(2)}h)` +
				(batched ? ' — batched with a same-setup job already on that slot' : '')
		);
	}

	return { assignments, atRisk, reasoning };
}
