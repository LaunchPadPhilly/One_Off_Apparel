import { prisma } from '$lib/server/prisma';
import { estimateHours, EstimationError } from '$lib/server/engine/estimateHours';
import { addLoad, planStaffingForLoads, withCommittedCrew, type StationLoad } from '$lib/server/engine/planStaffing';
import { fetchStaffingInputs } from '$lib/server/schedule/buildBacklogAndCapacity';
import { pinWorker, StaffingError } from '$lib/server/schedule/staffing';
import { DraftPlacementError, repackDraftDays, type PlacementPosition } from '$lib/server/schedule/draftDependencies';
import { isPressKind } from '$lib/schedule/stationKinds';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { CapacitySlot } from '$lib/server/engine/types';
import type { StaffingInputs } from '$lib/server/engine/planStaffing';

/**
 * The draft board's People panel (2026-10-14): re-plan a day's crews for one draft with
 * the same deterministic planner every engine run uses (planStaffingForLoads) — fed by
 * the jobs actually on that day, not the window-wide backlog spread. Claude never picks
 * the crew. Two ways in:
 * - pinAndRestaffDraftDay: someone dragged a person onto a station row (pin them there
 *   for that day, or clear their pin), then that day is re-planned.
 * - replanDraftCrews: "Re-plan crews" — every day with proposed jobs is re-planned
 *   against today's roster, certifications and pins (e.g. a draft made before the
 *   roster or the main/catch rules existed).
 *
 * Only PROPOSED jobs are re-crewed: their crew is replaced and their hours re-estimated
 * for the new crew, and a job that got longer pushes the jobs after it (refused if that
 * would run past the end of the day). APPROVED jobs keep the crew and hours they were
 * approved with — changing those is a new plan and a new approval — and the people on
 * any committed job that day (this draft or another) stay on its station, so nobody is
 * planned onto two stations in one day.
 *
 * Pins are shop-wide (StaffingPin), so every later engine run honours them too; other
 * drafts aren't re-crewed until they're re-planned.
 */

export class RestaffError extends Error {}

export interface RestaffResult {
	/** Every placement whose position changed, for the board to reconcile. */
	peers: PlacementPosition[];
	pushedCount: number;
	/** One line for the board, e.g. which press is closed for lack of a main. */
	notice: string;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

interface DayOutcome {
	peers: PlacementPosition[];
	pushedCount: number;
	/** Stations with jobs that day that nobody can run, as display text. */
	closed: string[];
	approvedKept: number;
}

/** Re-plans one day of one draft inside the caller's transaction (see the file comment). */
async function restaffDay(tx: Tx, draftId: string, isoDay: string, staffing: StaffingInputs): Promise<DayOutcome> {
	const day = new Date(`${isoDay}T00:00:00Z`);
	const [stations, assignments, pins, committed] = await Promise.all([
		tx.station.findMany({ where: { archivedAt: null }, select: { id: true, name: true, label: true, kind: true } }),
		tx.scheduleAssignment.findMany({
			where: { scheduleDraftId: draftId, date: day, status: { in: [ScheduleAssignmentStatus.PROPOSED, ScheduleAssignmentStatus.APPROVED] } },
			include: { lineItem: true }
		}),
		// Read inside the transaction so a pin saved just before counts.
		tx.staffingPin.findMany({ where: { date: day }, select: { workerId: true, stationId: true } }),
		// Committed work that day in any draft: its crew stays on its station.
		tx.scheduleAssignment.findMany({
			where: {
				date: day,
				status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS, ScheduleAssignmentStatus.COMPLETE] }
			},
			select: { lineItemId: true, stationId: true, date: true, status: true, startedAt: true, crew: { select: { workerId: true } } }
		})
	]);
	if (staffing.workers.length === 0) return { peers: [], pushedCount: 0, closed: [], approvedKept: 0 };

	// Waiting work per station = the one-person hours of the jobs on it that day.
	const loads = new Map<string, StationLoad>();
	for (const a of assignments) {
		try {
			const one = estimateHours(a.lineItem);
			addLoad(loads, a.stationId, a.lineItem, one.hours, one.crewDivisibleHours ?? 0);
		} catch (error) {
			if (!(error instanceof EstimationError)) throw error;
			addLoad(loads, a.stationId, a.lineItem, a.estimatedHours, 0);
		}
	}
	const slots: CapacitySlot[] = stations.map((s) => ({ stationId: s.id, stationName: s.name, stationKind: s.kind, date: day, availableHrs: 0 }));
	// An approved, not-started job this draft re-places is replaced on approval
	// (commitSchedule.ts), so its old crew isn't held there.
	const proposedLineItemIds = new Set(assignments.filter((a) => a.status === ScheduleAssignmentStatus.PROPOSED).map((a) => a.lineItemId));
	const staying = committed.filter((row) => !(row.status === ScheduleAssignmentStatus.APPROVED && row.startedAt === null && proposedLineItemIds.has(row.lineItemId)));
	const humanPins = new Map(pins.map((p) => [`${p.workerId}|${isoDay}`, p.stationId]));
	const plan = planStaffingForLoads(loads, slots, withCommittedCrew({ ...staffing, pins: humanPins }, staying));
	const planByStation = new Map(plan.map((slot) => [slot.stationId, slot]));

	// Re-crew and re-estimate every proposed job.
	const changedStations = new Set<string>();
	for (const a of assignments) {
		if (a.status !== ScheduleAssignmentStatus.PROPOSED) continue;
		const slot = planByStation.get(a.stationId);
		const crewIds = slot?.crewWorkerIds ?? [];
		let hours = a.estimatedHours;
		try {
			hours = estimateHours(a.lineItem, Math.max(1, crewIds.length)).hours;
		} catch (error) {
			if (!(error instanceof EstimationError)) throw error;
		}
		await tx.assignmentCrew.deleteMany({ where: { assignmentId: a.id } });
		if (crewIds.length) {
			await tx.assignmentCrew.createMany({ data: crewIds.map((workerId) => ({ assignmentId: a.id, workerId, isMain: workerId === slot?.mainWorkerId })) });
		}
		if (hours !== a.estimatedHours) {
			await tx.scheduleAssignment.update({ where: { id: a.id }, data: { estimatedHours: hours } });
			changedStations.add(a.stationId);
		}
	}

	const { peers, pushedCount } = changedStations.size
		? await repackDraftDays(tx, draftId, { kind: 'restaff', dayMs: day.getTime(), stationIds: [...changedStations] })
		: { peers: [], pushedCount: 0 };

	const stationById = new Map(stations.map((s) => [s.id, s]));
	const closed = [...new Set(assignments.map((a) => a.stationId))]
		.filter((id) => !planByStation.has(id))
		.map((id) => stationById.get(id))
		.filter((s): s is NonNullable<typeof s> => Boolean(s))
		.map((s) => (isPressKind(s.kind) ? `${s.label} (no main printer in)` : `${s.label} (no one certified in)`));
	const approvedKept = assignments.filter((a) => a.status === ScheduleAssignmentStatus.APPROVED).length;
	return { peers, pushedCount, closed, approvedKept };
}

/** Pin (or unpin) a person for a day, then re-plan that day's crews for this draft. */
export async function pinAndRestaffDraftDay(
	input: { draftId: string; workerId: string; date: string; stationId: string | null },
	actor: string
): Promise<RestaffResult> {
	if (Number.isNaN(new Date(`${input.date}T00:00:00Z`).getTime())) throw new RestaffError('Bad date.');
	const staffing = await fetchStaffingInputs({ from: input.date, to: input.date });

	try {
		return await prisma.$transaction(async (tx) => {
			await pinWorker(tx, { workerId: input.workerId, date: input.date, stationId: input.stationId }, actor);
			if (staffing.workers.length === 0) return { peers: [], pushedCount: 0, notice: 'No one is on the roster yet (Settings → People).' };
			const outcome = await restaffDay(tx, input.draftId, input.date, staffing);
			const notice = [
				`Crews re-planned for ${input.date}.`,
				outcome.closed.length ? `Nobody can run ${outcome.closed.join(', ')} — those jobs have no crew.` : '',
				outcome.approvedKept
					? `${outcome.approvedKept} approved job${outcome.approvedKept === 1 ? '' : 's'} kept ${outcome.approvedKept === 1 ? 'its' : 'their'} approved crew.`
					: ''
			]
				.filter(Boolean)
				.join(' ');
			return { peers: outcome.peers, pushedCount: outcome.pushedCount, notice };
		});
	} catch (error) {
		if (error instanceof StaffingError || error instanceof DraftPlacementError) throw new RestaffError(error.message);
		throw error;
	}
}

/**
 * Re-plans every day of a draft that has proposed jobs, one day per transaction, so one
 * day that can't fit (a job would run past the shift) doesn't block the rest — it's
 * reported and left as it was.
 */
export async function replanDraftCrews(draftId: string): Promise<{ notice: string }> {
	const days = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId, status: ScheduleAssignmentStatus.PROPOSED },
		distinct: ['date'],
		select: { date: true },
		orderBy: { date: 'asc' }
	});
	if (days.length === 0) return { notice: 'No proposed jobs to re-plan.' };
	const isoDays = days.map((d) => d.date.toISOString().slice(0, 10));
	const staffing = await fetchStaffingInputs({ from: isoDays[0], to: isoDays[isoDays.length - 1] });
	if (staffing.workers.length === 0) return { notice: 'No one is on the roster yet (Settings → People).' };

	const closed = new Set<string>();
	const failed: string[] = [];
	let pushed = 0;
	for (const isoDay of isoDays) {
		try {
			const outcome = await prisma.$transaction((tx) => restaffDay(tx, draftId, isoDay, staffing));
			outcome.closed.forEach((c) => closed.add(c));
			pushed += outcome.pushedCount;
		} catch (error) {
			if (!(error instanceof DraftPlacementError)) throw error;
			failed.push(`${isoDay}: ${error.message}`);
		}
	}
	const notice = [
		`Crews re-planned for ${isoDays.length - failed.length} of ${isoDays.length} day${isoDays.length === 1 ? '' : 's'}.`,
		closed.size ? `Nobody can run ${[...closed].join(', ')} on some days — those jobs have no crew.` : '',
		pushed ? `${pushed} finishing step${pushed === 1 ? '' : 's'} moved later to stay after their print.` : '',
		failed.length ? `Not changed — ${failed.join(' ')}` : ''
	]
		.filter(Boolean)
		.join(' ');
	return { notice };
}
