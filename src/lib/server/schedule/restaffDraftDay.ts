import { prisma } from '$lib/server/prisma';
import { estimateHours, EstimationError } from '$lib/server/engine/estimateHours';
import { addLoad, planStaffingForLoads, type StationLoad } from '$lib/server/engine/planStaffing';
import { fetchStaffingInputs } from '$lib/server/schedule/buildBacklogAndCapacity';
import { pinWorker, StaffingError } from '$lib/server/schedule/staffing';
import { DraftPlacementError, repackDraftDays, type PlacementPosition } from '$lib/server/schedule/draftDependencies';
import { isPressKind } from '$lib/schedule/stationKinds';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { CapacitySlot } from '$lib/server/engine/types';

/**
 * The draft board's People panel (2026-10-14): drag a person onto a station row to pin
 * them there for that day (or clear their pin), then re-plan that day's crews for this
 * draft with the same deterministic planner every engine run uses
 * (planStaffingForLoads) — fed by the jobs actually on that day, not the window-wide
 * backlog spread. Claude never picks the crew.
 *
 * Only PROPOSED jobs are re-crewed: their crew is replaced and their hours re-estimated
 * for the new crew size, and a job that got longer pushes the jobs after it (refused if
 * that would run past the end of the day). APPROVED jobs keep the crew and hours they
 * were approved with — changing those is a new plan and a new approval.
 *
 * The pin itself is shop-wide (StaffingPin), so every later engine run honours it too;
 * other drafts aren't re-crewed until they're re-planned.
 */

export class RestaffError extends Error {}

export interface RestaffResult {
	/** Every placement whose position changed, for the board to reconcile. */
	peers: PlacementPosition[];
	pushedCount: number;
	/** One line for the board, e.g. which press is closed for lack of a main. */
	notice: string;
}

export async function pinAndRestaffDraftDay(
	input: { draftId: string; workerId: string; date: string; stationId: string | null },
	actor: string
): Promise<RestaffResult> {
	const day = new Date(`${input.date}T00:00:00Z`);
	if (Number.isNaN(day.getTime())) throw new RestaffError('Bad date.');
	const staffing = await fetchStaffingInputs({ from: input.date, to: input.date });

	try {
		return await prisma.$transaction(async (tx) => {
			await pinWorker(tx, { workerId: input.workerId, date: input.date, stationId: input.stationId }, actor);

			const [stations, assignments, pins] = await Promise.all([
				tx.station.findMany({ where: { archivedAt: null }, select: { id: true, name: true, label: true, kind: true } }),
				tx.scheduleAssignment.findMany({
					where: { scheduleDraftId: input.draftId, date: day, status: { in: [ScheduleAssignmentStatus.PROPOSED, ScheduleAssignmentStatus.APPROVED] } },
					include: { lineItem: true }
				}),
				// Re-read inside the transaction so the pin just saved counts.
				tx.staffingPin.findMany({ where: { date: day }, select: { workerId: true, stationId: true } })
			]);

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
			const plan = planStaffingForLoads(loads, slots, {
				...staffing,
				pins: new Map(pins.map((p) => [`${p.workerId}|${input.date}`, p.stationId]))
			});
			const planByStation = new Map(plan.map((slot) => [slot.stationId, slot]));
			if (staffing.workers.length === 0) return { peers: [], pushedCount: 0, notice: 'No one is on the roster yet (Settings → People).' };

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
				? await repackDraftDays(tx, input.draftId, { kind: 'restaff', dayMs: day.getTime(), stationIds: [...changedStations] })
				: { peers: [], pushedCount: 0 };

			// Say plainly which stations with work have nobody who can run them.
			const stationById = new Map(stations.map((s) => [s.id, s]));
			const closed = [...new Set(assignments.map((a) => a.stationId))]
				.filter((id) => !planByStation.has(id))
				.map((id) => stationById.get(id))
				.filter((s): s is NonNullable<typeof s> => Boolean(s))
				.map((s) => (isPressKind(s.kind) ? `${s.label} (no main printer in)` : `${s.label} (no one certified in)`));
			const approvedKept = assignments.filter((a) => a.status === ScheduleAssignmentStatus.APPROVED).length;
			const notice = [
				`Crews re-planned for ${input.date}.`,
				closed.length ? `Nobody can run ${closed.join(', ')} — those jobs have no crew.` : '',
				approvedKept ? `${approvedKept} approved job${approvedKept === 1 ? '' : 's'} kept ${approvedKept === 1 ? 'its' : 'their'} approved crew.` : ''
			]
				.filter(Boolean)
				.join(' ');
			return { peers, pushedCount, notice };
		});
	} catch (error) {
		if (error instanceof StaffingError || error instanceof DraftPlacementError) throw new RestaffError(error.message);
		throw error;
	}
}
