import { z } from 'zod';
import { McpUserError } from '$lib/server/mcp/handler';
import { estimateHours, EstimationError } from '$lib/server/engine/estimateHours';
import { isPressKind, PRINTED_RELABEL_KIND } from '$lib/schedule/stationKinds';
import { dayLabel } from '$lib/schedule/draftProblems';
import { repackDraftDays, DraftPlacementError, type PlacementChange, type RepackMode } from './draftDependencies';
import { restaffDaysJobsMovedTo } from './restaffDraftDay';
import { runDraftEdit, type DraftEditOutcome } from './draftEdit';
import { findWorker } from './staffing';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { Prisma } from '../../../../prisma/generated/prisma/client';

/**
 * Sets exactly who works one station on one day **inside one draft** (2026-10-16) — the
 * chat side of dragging people on the board's People panel, for requests like "only one
 * person on Press 1 Tuesday" or "swap Jo for Mitch on embroidery". The draft's proposed
 * jobs on that station/day get that crew, and their hours are re-estimated for the new
 * crew size (estimateHours — the deterministic formulas; a smaller crew can make a job
 * longer, which pushes the jobs after it).
 *
 * Refused (the person must fix the roster first): someone not certified on the station,
 * someone marked out that day, a non-press person on Printed Relabel. Allowed and
 * flagged by draftProblems.ts: a press crew with no main/operator, a person also on
 * another station that day. In `makeRoom` mode that person is taken off the other
 * station's proposed jobs in this draft instead (reported in `changes`), and a job pushed
 * past the end of the day moves to the next working day.
 *
 * Unlike set_worker_station this pins nobody shop-wide; only this draft changes.
 */

export class SetDraftCrewError extends McpUserError {}

export const setDraftCrewSchema = z.object({
	draftId: z.string().min(1),
	date: z.iso.date(),
	// Station's internal name (get_draft's stationName) or its label ("Press 1").
	stationName: z.string().trim().min(1),
	// Everyone who should be on it, by name; [] leaves it with nobody (flagged).
	workerNames: z.array(z.string().trim().min(1)).max(12)
});

export interface SetDraftCrewResult {
	station: string;
	date: string;
	crew: { name: string; role: string }[];
	jobs: { assignmentId: string; job: string; hoursBefore: number; hoursAfter: number }[];
	changes: PlacementChange[];
	/** Plain notes on what else had to change (people moved off other stations). */
	notes: string[];
}

type Tx = Prisma.TransactionClient;

async function findStationByNameOrLabel(tx: Tx, value: string) {
	const stations = await tx.station.findMany({ where: { archivedAt: null }, select: { id: true, name: true, label: true, kind: true } });
	const lower = value.toLowerCase();
	const exact = stations.filter((s) => s.name.toLowerCase() === lower || s.label.toLowerCase() === lower);
	const matches = exact.length ? exact : stations.filter((s) => s.label.toLowerCase().includes(lower));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new SetDraftCrewError(`No active station called "${value}". Try list_stations.`);
	throw new SetDraftCrewError(`"${value}" matches more than one station: ${matches.map((s) => s.label).join(', ')}. Say which one.`);
}

/** Re-crews the proposed jobs of one station/day and re-estimates them. Returns the stations whose jobs changed length. */
async function applyCrew(tx: Tx, draftId: string, stationId: string, day: Date, crew: { workerId: string; role: 'MAIN' | 'OPERATOR' | 'CATCH' }[]) {
	const jobs = await tx.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId, stationId, date: day, status: ScheduleAssignmentStatus.PROPOSED },
		include: { lineItem: { include: { order: { select: { hoopsOrderId: true } } } } }
	});
	const out: SetDraftCrewResult['jobs'] = [];
	for (const job of jobs) {
		let hours = job.estimatedHours;
		try {
			hours = estimateHours(job.lineItem, Math.max(1, crew.length)).hours;
		} catch (error) {
			if (!(error instanceof EstimationError)) throw error;
		}
		await tx.assignmentCrew.deleteMany({ where: { assignmentId: job.id } });
		if (crew.length) await tx.assignmentCrew.createMany({ data: crew.map((m) => ({ assignmentId: job.id, workerId: m.workerId, role: m.role })) });
		if (hours !== job.estimatedHours) await tx.scheduleAssignment.update({ where: { id: job.id }, data: { estimatedHours: hours } });
		out.push({ assignmentId: job.id, job: `${job.lineItem.order.hoopsOrderId} · ${job.lineItem.design || 'job'}`, hoursBefore: job.estimatedHours, hoursAfter: hours });
	}
	return out;
}

export async function setDraftCrew(
	input: z.infer<typeof setDraftCrewSchema>,
	actor: string,
	options: { mode?: RepackMode; dryRun?: boolean } = {}
): Promise<DraftEditOutcome<SetDraftCrewResult>> {
	const workers: Awaited<ReturnType<typeof findWorker>>[] = [];
	for (const name of input.workerNames) workers.push(await findWorker(name));
	if (new Set(workers.map((w) => w.id)).size !== workers.length) throw new SetDraftCrewError('The same person is listed twice.');
	const day = new Date(`${input.date}T00:00:00Z`);
	const mode = options.mode ?? 'flag';

	const summary = (r: SetDraftCrewResult) =>
		`Crew on ${r.station} ${dayLabel(r.date)}: ${r.crew.length ? r.crew.map((m) => `${m.name} (${m.role})`).join(', ') : 'nobody'}`;

	try {
		return await runDraftEdit(input.draftId, actor, summary, { via: 'claude', dryRun: options.dryRun, withProblems: true }, async (tx) => {
			const station = await findStationByNameOrLabel(tx, input.stationName);
			const press = isPressKind(station.kind);
			const certified = await tx.workerCertification.findMany({
				where: { workerId: { in: workers.map((w) => w.id) } },
				select: { workerId: true, stationId: true, station: { select: { kind: true } } }
			});
			const out = await tx.workerUnavailability.findMany({ where: { date: day, workerId: { in: workers.map((w) => w.id) } }, select: { workerId: true } });
			for (const w of workers) {
				const mine = certified.filter((c) => c.workerId === w.id);
				if (!mine.some((c) => c.stationId === station.id)) {
					throw new SetDraftCrewError(`${w.name} isn't certified on ${station.label}. Add the certification in Settings → People first if they should be.`);
				}
				if (station.kind === PRINTED_RELABEL_KIND && !mine.some((c) => isPressKind(c.station.kind))) {
					throw new SetDraftCrewError(`${w.name} can't run Printed Relabel — it's done by press people between runs, and ${w.name} isn't certified on a Screen Print station.`);
				}
				if (out.some((o) => o.workerId === w.id)) {
					throw new SetDraftCrewError(`${w.name} is marked out on ${dayLabel(input.date)}. Mark them back in first (set_worker_availability) if that's wrong.`);
				}
			}

			const hasJobs = await tx.scheduleAssignment.count({ where: { scheduleDraftId: input.draftId, stationId: station.id, date: day, status: ScheduleAssignmentStatus.PROPOSED } });
			if (hasJobs === 0) throw new SetDraftCrewError(`This draft has no proposed jobs on ${station.label} on ${dayLabel(input.date)}, so there's no crew to set.`);

			// Lead first on a press: the first main, else the first operator; everyone else catches.
			const lead = press ? (workers.find((w) => w.isMain) ?? workers.find((w) => w.isOperator) ?? null) : null;
			const crew = workers.map((w) => ({
				workerId: w.id,
				role: (w === lead ? (w.isMain ? 'MAIN' : 'OPERATOR') : 'CATCH') as 'MAIN' | 'OPERATOR' | 'CATCH'
			}));
			crew.sort((a, b) => Number(b.role !== 'CATCH') - Number(a.role !== 'CATCH'));

			const notes: string[] = [];
			const changedStations = new Set<string>();
			// makeRoom: a person can't be on two stations — take them off this draft's other proposed jobs that day.
			if (mode === 'makeRoom' && workers.length) {
				const elsewhere = await tx.assignmentCrew.findMany({
					where: {
						workerId: { in: workers.map((w) => w.id) },
						assignment: { scheduleDraftId: input.draftId, date: day, status: ScheduleAssignmentStatus.PROPOSED, NOT: { stationId: station.id } }
					},
					select: { workerId: true, assignment: { select: { stationId: true, station: { select: { label: true } } } } }
				});
				const byStation = new Map<string, { label: string; workerIds: Set<string> }>();
				for (const row of elsewhere) {
					const entry = byStation.get(row.assignment.stationId) ?? { label: row.assignment.station.label, workerIds: new Set() };
					entry.workerIds.add(row.workerId);
					byStation.set(row.assignment.stationId, entry);
				}
				for (const [otherStationId, entry] of byStation) {
					const current = await tx.assignmentCrew.findMany({
						where: { assignment: { scheduleDraftId: input.draftId, stationId: otherStationId, date: day, status: ScheduleAssignmentStatus.PROPOSED } },
						select: { workerId: true, role: true },
						distinct: ['workerId']
					});
					const remaining = current.filter((m) => !entry.workerIds.has(m.workerId));
					await applyCrew(tx, input.draftId, otherStationId, day, remaining);
					changedStations.add(otherStationId);
					const names = workers.filter((w) => entry.workerIds.has(w.id)).map((w) => w.name);
					notes.push(`Took ${names.join(' and ')} off ${entry.label} that day${remaining.length ? '' : ' — it has nobody now'}.`);
				}
			}

			const jobs = await applyCrew(tx, input.draftId, station.id, day, crew);
			changedStations.add(station.id);
			const { changes } = await repackDraftDays(tx, input.draftId, { kind: 'restaff', dayMs: day.getTime(), stationIds: [...changedStations] }, mode);
			if (mode === 'makeRoom') await restaffDaysJobsMovedTo(tx, input.draftId, changes);

			const nameById = new Map(workers.map((w) => [w.id, w.name]));
			return {
				station: station.label,
				date: input.date,
				crew: crew.map((m) => ({ name: nameById.get(m.workerId) ?? '', role: press ? m.role.toLowerCase() : 'crew' })),
				jobs,
				changes,
				notes
			};
		});
	} catch (error) {
		if (error instanceof DraftPlacementError) throw new SetDraftCrewError(error.message);
		throw error;
	}
}
