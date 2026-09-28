import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Daily staffing, the part people change by talking to Claude (2026-09-28): who is out
 * on which days, and pinning a person to a station for a day. The deterministic
 * staffing plan (engine/planStaffing.ts) reads both the next time a schedule is
 * proposed. Nothing here changes an approved schedule by itself — re-planning and
 * approving the result is a separate, human-approved step (non-negotiable: nothing
 * commits without a human).
 *
 * People and stations are matched by name, the way someone says them in chat.
 */

// A McpUserError so its message (written for the user) reaches Claude as-is.
export class StaffingError extends McpUserError {}

const MAX_RANGE_DAYS = 62;

const isoDate = z.iso.date();

export const getStaffingSchema = z.object({ from: isoDate, to: isoDate });

export const setWorkerAvailabilitySchema = z.object({
	workerName: z.string().trim().min(1),
	from: isoDate,
	to: isoDate,
	available: z.boolean(),
	reason: z.string().trim().max(200).optional()
});

export const setWorkerStationSchema = z.object({
	workerName: z.string().trim().min(1),
	date: isoDate,
	// null/omitted clears the pin, leaving the day to the staffing plan.
	stationName: z.string().trim().min(1).nullable().optional()
});

function days(from: string, to: string): Date[] {
	const start = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	if (end < start) throw new StaffingError(`"to" (${to}) is before "from" (${from}).`);
	const out: Date[] = [];
	for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(new Date(d));
	if (out.length > MAX_RANGE_DAYS) throw new StaffingError(`That's ${out.length} days — keep it to ${MAX_RANGE_DAYS} or fewer at a time.`);
	return out;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** An active person by name: exact (case-insensitive), else a unique partial match. */
async function findWorker(name: string) {
	const workers = await prisma.worker.findMany({
		where: { archivedAt: null },
		select: { id: true, name: true, certifications: { where: { station: { archivedAt: null } }, select: { stationId: true } } }
	});
	const lower = name.toLowerCase();
	const exact = workers.filter((w) => w.name.toLowerCase() === lower);
	const matches = exact.length ? exact : workers.filter((w) => w.name.toLowerCase().includes(lower));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new StaffingError(`No one called "${name}" is on the roster (Settings → People).`);
	throw new StaffingError(`"${name}" matches more than one person: ${matches.map((w) => w.name).join(', ')}. Say which one.`);
}

/** An active station by its label (case-insensitive), else a unique partial match. */
async function findStation(name: string) {
	const stations = await prisma.station.findMany({ where: { archivedAt: null }, select: { id: true, label: true } });
	const lower = name.toLowerCase();
	const exact = stations.filter((s) => s.label.toLowerCase() === lower);
	const matches = exact.length ? exact : stations.filter((s) => s.label.toLowerCase().includes(lower));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new StaffingError(`No active station called "${name}" (Settings → Stations).`);
	throw new StaffingError(`"${name}" matches more than one station: ${matches.map((s) => s.label).join(', ')}. Say which one.`);
}

/** Who works where: the roster, days out, pins, and the crews on the approved schedule. */
export async function getStaffing(input: z.infer<typeof getStaffingSchema>) {
	const range = days(input.from, input.to);
	const from = range[0];
	const to = range[range.length - 1];
	const [workers, out, pins, assignments] = await Promise.all([
		prisma.worker.findMany({
			where: { archivedAt: null },
			orderBy: { name: 'asc' },
			select: { name: true, notes: true, certifications: { where: { station: { archivedAt: null } }, select: { station: { select: { label: true } } } } }
		}),
		prisma.workerUnavailability.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, reason: true, worker: { select: { name: true } } } }),
		prisma.staffingPin.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, worker: { select: { name: true } }, station: { select: { label: true } } } }),
		prisma.scheduleAssignment.findMany({
			where: { date: { gte: from, lte: to }, status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] } },
			select: { date: true, station: { select: { label: true } }, crew: { select: { worker: { select: { name: true } } } } }
		})
	]);

	const crews = new Map<string, Set<string>>();
	for (const a of assignments) {
		const key = `${iso(a.date)}|${a.station.label}`;
		const set = crews.get(key) ?? new Set<string>();
		for (const member of a.crew) set.add(member.worker.name);
		crews.set(key, set);
	}

	return {
		roster: workers.map((w) => ({ name: w.name, notes: w.notes, certifiedOn: w.certifications.map((c) => c.station.label) })),
		out: out.map((o) => ({ date: iso(o.date), name: o.worker.name, reason: o.reason })),
		pinned: pins.map((p) => ({ date: iso(p.date), name: p.worker.name, station: p.station.label })),
		approvedCrews: [...crews.entries()]
			.map(([key, names]) => {
				const [date, station] = key.split('|');
				return { date, station, crew: [...names].sort() };
			})
			.sort((a, b) => a.date.localeCompare(b.date) || a.station.localeCompare(b.station))
	};
}

/**
 * Mark someone out (or back in) for a range of days. Marking out also clears any pin
 * they had on those days. Returns the approved jobs they're currently crewing on those
 * days — the ones a re-plan would need to cover.
 */
export async function setWorkerAvailability(input: z.infer<typeof setWorkerAvailabilitySchema>, actor: string) {
	const worker = await findWorker(input.workerName);
	const range = days(input.from, input.to);

	await prisma.$transaction(async (tx) => {
		if (input.available) {
			await tx.workerUnavailability.deleteMany({ where: { workerId: worker.id, date: { in: range } } });
		} else {
			for (const date of range) {
				await tx.workerUnavailability.upsert({
					where: { workerId_date: { workerId: worker.id, date } },
					create: { workerId: worker.id, date, reason: input.reason ?? null, createdBy: actor },
					update: { reason: input.reason ?? null, createdBy: actor }
				});
			}
			await tx.staffingPin.deleteMany({ where: { workerId: worker.id, date: { in: range } } });
		}
		await tx.domainAuditLog.create({
			data: {
				entity: 'Worker',
				entityId: worker.id,
				action: input.available ? 'worker_marked_available' : 'worker_marked_out',
				actor,
				diff: { name: worker.name, from: input.from, to: input.to, reason: input.reason ?? null }
			}
		});
	});

	const affected = input.available
		? []
		: await prisma.scheduleAssignment.findMany({
				where: {
					date: { in: range },
					status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] },
					crew: { some: { workerId: worker.id } }
				},
				select: { id: true, date: true, status: true, station: { select: { label: true } }, lineItem: { select: { design: true, order: { select: { hoopsOrderId: true } } } } },
				orderBy: [{ date: 'asc' }]
			});

	return {
		name: worker.name,
		available: input.available,
		days: range.map(iso),
		approvedJobsTheyWereOn: affected.map((a) => ({
			assignmentId: a.id,
			date: iso(a.date),
			station: a.station.label,
			hoopsOrderId: a.lineItem.order.hoopsOrderId,
			design: a.lineItem.design,
			status: a.status
		}))
	};
}

/** Pin someone to a station for one day (they must be certified and not out), or clear it. */
export async function setWorkerStation(input: z.infer<typeof setWorkerStationSchema>, actor: string) {
	const worker = await findWorker(input.workerName);
	const date = new Date(`${input.date}T00:00:00Z`);

	if (!input.stationName) {
		await prisma.$transaction([
			prisma.staffingPin.deleteMany({ where: { workerId: worker.id, date } }),
			prisma.domainAuditLog.create({ data: { entity: 'Worker', entityId: worker.id, action: 'worker_station_unpinned', actor, diff: { name: worker.name, date: input.date } } })
		]);
		return { name: worker.name, date: input.date, station: null };
	}

	const station = await findStation(input.stationName);
	if (!worker.certifications.some((c) => c.stationId === station.id)) {
		throw new StaffingError(`${worker.name} isn't certified on ${station.label}. Add the certification in Settings → People first if they should be.`);
	}
	const out = await prisma.workerUnavailability.findUnique({ where: { workerId_date: { workerId: worker.id, date } } });
	if (out) throw new StaffingError(`${worker.name} is marked out on ${input.date}. Mark them available first.`);

	await prisma.$transaction([
		prisma.staffingPin.upsert({
			where: { workerId_date: { workerId: worker.id, date } },
			create: { workerId: worker.id, date, stationId: station.id, createdBy: actor },
			update: { stationId: station.id, createdBy: actor }
		}),
		prisma.domainAuditLog.create({
			data: { entity: 'Worker', entityId: worker.id, action: 'worker_station_pinned', actor, diff: { name: worker.name, date: input.date, station: station.label } }
		})
	]);
	return { name: worker.name, date: input.date, station: station.label };
}
