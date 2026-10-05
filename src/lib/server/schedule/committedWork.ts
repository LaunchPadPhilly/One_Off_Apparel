/**
 * Re-planning around the committed schedule (2026-10-05). Before this, every engine run
 * re-placed the whole backlog from scratch: approved jobs stayed in the backlog (their
 * line items are still NEEDS_REVIEW) and their hours were never taken out of capacity,
 * so a second proposal double-booked the floor.
 *
 * This file builds the inputs for one engine run so that:
 *   - Started work (IN_PROGRESS / COMPLETE) never moves.
 *   - Approved, not-started work inside the `release` window is "released": its line
 *     items go back into the backlog and may land somewhere else. This is how a rush
 *     order bumps not-started jobs, and how someone being out moves their days' jobs
 *     (client decisions 2026-10-05).
 *   - Every other approved job stays where it is. Its hours come out of its slot's
 *     capacity, and a finisher waiting on it is placed after it ends.
 *
 * Nothing here writes to the database. Approving the new plan (commitSchedule.ts) is
 * what replaces the released jobs' old rows.
 */
import { prisma } from '$lib/server/prisma';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { BacklogItem, CapacitySlot, ExternalDependencyState } from '$lib/server/engine/types';
import { SHIFT_END_MIN, SHIFT_START_MIN, wallClockEnd } from '$lib/schedule/shift';
import { fetchBacklog, fetchStaffedCapacity } from './buildBacklogAndCapacity';
import type { DateRange } from './types';

/** An approved, not-started job this run is allowed to move. */
export interface ReleasedAssignment {
	assignmentId: string;
	lineItemId: string;
	stationId: string;
	date: Date;
	startMinuteOfDay: number | null;
}

/** Everything one engine run needs, plus what it released (for the change summary). */
export interface SchedulingRun {
	backlog: BacklogItem[];
	externalDependencies: Map<string, ExternalDependencyState>;
	capacity: CapacitySlot[];
	released: ReleasedAssignment[];
}

/** Committed statuses: on the real schedule, as opposed to a PROPOSED draft row. */
const COMMITTED = [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS, ScheduleAssignmentStatus.COMPLETE];

function dayKey(stationId: string, date: Date): string {
	return `${stationId}__${date.toISOString().slice(0, 10)}`;
}

function inRange(date: Date, range: DateRange): boolean {
	const day = date.toISOString().slice(0, 10);
	return day >= range.from && day <= range.to;
}

/** When a committed row ends on its day. Rows with no clock time count from shift open. */
function rowEnd(row: { startMinuteOfDay: number | null; estimatedHours: number }): number {
	const start = row.startMinuteOfDay ?? SHIFT_START_MIN;
	return Math.min(wallClockEnd(start, row.estimatedHours * 60), SHIFT_END_MIN);
}

/**
 * Builds the backlog, dependency states and capacity for one engine run over `range`,
 * keeping committed work in place except approved, not-started jobs dated inside
 * `release` (pass null to move nothing — only new work is placed, around the rest).
 */
export async function buildSchedulingRun(range: DateRange, release: DateRange | null): Promise<SchedulingRun> {
	const { backlog: fullBacklog, externalDependencies } = await fetchBacklog();

	// Every line item these jobs wait on, so a dependency that's already scheduled can
	// give its end time instead of blocking its finisher.
	const relevantIds = new Set<string>();
	for (const item of fullBacklog) {
		relevantIds.add(item.id);
		for (const id of item.dependsOnIds ?? []) relevantIds.add(id);
	}

	const committedRows = await prisma.scheduleAssignment.findMany({
		where: {
			status: { in: COMMITTED },
			OR: [{ lineItemId: { in: [...relevantIds] } }, { date: { gte: new Date(range.from), lte: new Date(range.to) } }]
		},
		select: { id: true, lineItemId: true, stationId: true, date: true, startMinuteOfDay: true, estimatedHours: true, status: true, startedAt: true }
	});

	const released: ReleasedAssignment[] = [];
	const fixedRows: typeof committedRows = [];
	for (const row of committedRows) {
		const movable = row.status === ScheduleAssignmentStatus.APPROVED && row.startedAt === null && release !== null && inRange(row.date, release);
		if (movable) released.push({ assignmentId: row.id, lineItemId: row.lineItemId, stationId: row.stationId, date: row.date, startMinuteOfDay: row.startMinuteOfDay });
		else fixedRows.push(row);
	}

	// A line item with any row that stays put is already handled — it isn't re-placed.
	const fixedLineItemIds = new Set(fixedRows.map((row) => row.lineItemId));
	const backlog = fullBacklog.filter((item) => !fixedLineItemIds.has(item.id));
	const backlogIds = new Set(backlog.map((item) => item.id));

	// Dependencies that are now outside the backlog because they're on the schedule:
	// finished ones impose nothing; the rest pass their end time to their dependents.
	for (const item of backlog) {
		for (const id of item.dependsOnIds ?? []) {
			if (backlogIds.has(id) || !fixedLineItemIds.has(id)) continue;
			const rows = fixedRows.filter((row) => row.lineItemId === id);
			if (rows.every((row) => row.status === ScheduleAssignmentStatus.COMPLETE)) {
				externalDependencies.set(id, 'complete');
				continue;
			}
			let latest = { dayMs: 0, minute: 0 };
			for (const row of rows) {
				const end = { dayMs: row.date.getTime(), minute: rowEnd(row) };
				if (end.dayMs > latest.dayMs || (end.dayMs === latest.dayMs && end.minute > latest.minute)) latest = end;
			}
			externalDependencies.set(id, { endsAt: latest });
		}
	}

	// Take the fixed work's hours out of each station's day, and start the day's free
	// time after it.
	const fixedBySlot = new Map<string, { hours: number; busyUntil: number; count: number }>();
	for (const row of fixedRows) {
		if (!inRange(row.date, range)) continue;
		const key = dayKey(row.stationId, row.date);
		const entry = fixedBySlot.get(key) ?? { hours: 0, busyUntil: SHIFT_START_MIN, count: 0 };
		entry.hours += row.estimatedHours;
		entry.busyUntil = Math.max(entry.busyUntil, rowEnd(row));
		entry.count += 1;
		fixedBySlot.set(key, entry);
	}
	const staffed = await fetchStaffedCapacity(range, backlog);
	const capacity = staffed.map((slot) => {
		const fixed = fixedBySlot.get(dayKey(slot.stationId, slot.date));
		if (!fixed) return slot;
		return { ...slot, availableHrs: Math.max(0, slot.availableHrs - fixed.hours), busyUntilMin: fixed.busyUntil, committedJobCount: fixed.count };
	});

	// Only report a job as released if this run can actually re-place it (it's still in
	// the backlog, with no other row of it staying put).
	return { backlog, externalDependencies, capacity, released: released.filter((row) => backlogIds.has(row.lineItemId)) };
}
