import { z } from 'zod';
import { McpUserError } from '$lib/server/mcp/handler';
import { isWeekendDay } from '$lib/schedule/defaultCapacity';
import { SHIFT_START_MIN, skipBreak, wallClockEnd } from '$lib/schedule/shift';
import { repackDraftDays, DraftPlacementError, type PlacementChange, type RepackMode } from './draftDependencies';
import { restaffDaysJobsMovedTo } from './restaffDraftDay';
import { runDraftEdit, type DraftEditOutcome } from './draftEdit';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Whole-draft adjustments from chat (2026-10-16), editing the draft in place:
 * - `days`: move every selected proposed job N working days later (negative = earlier),
 *   keeping its station and start time ("push the schedule back a day").
 * - `bufferMinutes`: leave at least that many minutes between back-to-back jobs on each
 *   station's day ("give a 15-minute buffer between jobs").
 * Narrow it with from/to (dates the jobs are on now) and stationName. Afterwards each
 * touched day is settled the same way a crew change is: jobs that now overlap are pushed
 * just past the one before; anything past the end of the shift is flagged (flag mode) or
 * moved to the next working day (makeRoom). Finishing steps whose print moved later
 * follow it.
 */

export class ShiftDraftError extends McpUserError {}

export const shiftDraftSchema = z.object({
	draftId: z.string().min(1),
	days: z.number().int().min(-20).max(20).optional(),
	bufferMinutes: z.number().int().min(0).max(120).optional(),
	from: z.iso.date().optional(),
	to: z.iso.date().optional(),
	// Station's internal name or label; omit for every station.
	stationName: z.string().trim().min(1).optional()
});

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `dayMs` moved by `n` working days (weekends skipped). */
function addWorkingDays(dayMs: number, n: number): number {
	let day = dayMs;
	const step = n >= 0 ? 1 : -1;
	for (let left = Math.abs(n); left > 0; ) {
		day += step * DAY_MS;
		if (!isWeekendDay(iso(day))) left--;
	}
	return day;
}

export interface ShiftDraftResult {
	moved: number;
	changes: PlacementChange[];
}

export async function shiftDraft(
	input: z.infer<typeof shiftDraftSchema>,
	actor: string,
	options: { mode?: RepackMode; dryRun?: boolean } = {}
): Promise<DraftEditOutcome<ShiftDraftResult>> {
	const days = input.days ?? 0;
	const buffer = input.bufferMinutes ?? 0;
	if (days === 0 && buffer === 0) throw new ShiftDraftError('Say how many working days to move (days) or how many minutes to leave between jobs (bufferMinutes).');
	const mode = options.mode ?? 'flag';

	const summary = (r: ShiftDraftResult) =>
		[days ? `Moved ${r.moved} job${r.moved === 1 ? '' : 's'} ${Math.abs(days)} working day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}` : '', buffer ? `left ${buffer} min between jobs` : '']
			.filter(Boolean)
			.join(' and ');

	try {
		return await runDraftEdit(input.draftId, actor, summary, { via: 'claude', dryRun: options.dryRun, withProblems: true }, async (tx) => {
			let stationId: string | undefined;
			if (input.stationName) {
				const lower = input.stationName.toLowerCase();
				const stations = await tx.station.findMany({ where: { archivedAt: null }, select: { id: true, name: true, label: true } });
				const match = stations.filter((s) => s.name.toLowerCase() === lower || s.label.toLowerCase() === lower);
				if (match.length !== 1) throw new ShiftDraftError(`No single active station called "${input.stationName}". Try list_stations.`);
				stationId = match[0].id;
			}
			const rows = await tx.scheduleAssignment.findMany({
				where: {
					scheduleDraftId: input.draftId,
					status: ScheduleAssignmentStatus.PROPOSED,
					...(stationId ? { stationId } : {}),
					...(input.from || input.to
						? { date: { ...(input.from ? { gte: new Date(`${input.from}T00:00:00Z`) } : {}), ...(input.to ? { lte: new Date(`${input.to}T00:00:00Z`) } : {}) } }
						: {})
				},
				select: { id: true, lineItemId: true, stationId: true, date: true, startMinuteOfDay: true, estimatedHours: true },
				orderBy: [{ date: 'asc' }, { startMinuteOfDay: 'asc' }]
			});
			if (rows.length === 0) throw new ShiftDraftError('No proposed jobs in this draft match that — nothing to change.');

			const requested: PlacementChange[] = [];
			const touched = new Map<number, Set<string>>();
			const touch = (dayMs: number, sid: string) => (touched.get(dayMs) ?? touched.set(dayMs, new Set()).get(dayMs)!).add(sid);
			const byDay = new Map<string, typeof rows>();
			for (const row of rows) {
				const key = `${row.stationId}|${row.date.getTime()}`;
				(byDay.get(key) ?? byDay.set(key, []).get(key)!).push(row);
			}
			for (const group of byDay.values()) {
				let previousEnd: number | null = null;
				for (const row of group) {
					const fromDay = row.date.getTime();
					const fromStart = row.startMinuteOfDay ?? SHIFT_START_MIN;
					const duration = Math.max(15, Math.round(row.estimatedHours * 60));
					let start = fromStart;
					if (buffer && previousEnd !== null) start = Math.max(start, skipBreak(previousEnd + buffer));
					previousEnd = wallClockEnd(start, duration);
					const toDay = days ? addWorkingDays(fromDay, days) : fromDay;
					if (toDay === fromDay && start === fromStart) continue;
					await tx.scheduleAssignment.update({ where: { id: row.id }, data: { date: new Date(toDay), startMinuteOfDay: start } });
					requested.push({ id: row.id, lineItemId: row.lineItemId, from: { stationId: row.stationId, date: iso(fromDay), startMin: fromStart }, to: { stationId: row.stationId, date: iso(toDay), startMin: start } });
					touch(toDay, row.stationId);
				}
			}

			// Settle each touched day (overlaps pushed later, past-the-shift flagged or spilled).
			const knock: PlacementChange[] = [];
			for (const [dayMs, stations] of [...touched].sort((a, b) => a[0] - b[0])) {
				const { changes } = await repackDraftDays(tx, input.draftId, { kind: 'restaff', dayMs, stationIds: [...stations] }, mode);
				knock.push(...changes);
			}
			// Jobs moved to other days need that day's people (who's in, who's free) —
			// always for a days shift, and for any job make-room spilled.
			await restaffDaysJobsMovedTo(tx, input.draftId, [...(days ? requested : []), ...(mode === 'makeRoom' ? knock : [])]);
			const movedIds = new Set(requested.map((c) => c.id));
			return { moved: requested.length, changes: knock.filter((c) => !movedIds.has(c.id)) };
		});
	} catch (error) {
		if (error instanceof DraftPlacementError) throw new ShiftDraftError(error.message);
		throw error;
	}
}
