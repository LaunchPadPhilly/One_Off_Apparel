import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { isPressKind, PRINTED_RELABEL_KIND } from '$lib/schedule/stationKinds';
import { pressSafeCrew } from '$lib/schedule/people';
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
 *
 * Backs the get_staffing, set_worker_availability and set_worker_station MCP tools
 * (registered in mcp/tools.ts).
 */

/**
 * Any staffing problem the user can fix (unknown name, not certified, range too long…).
 * A McpUserError so its message (written for the user) reaches Claude as-is.
 */
export class StaffingError extends McpUserError {}

// Longest from–to range (in days) one call may cover.
const MAX_RANGE_DAYS = 62;

const isoDate = z.iso.date();

/** Input for get_staffing: an inclusive "YYYY-MM-DD" range. */
export const getStaffingSchema = z.object({ from: isoDate, to: isoDate });

/** Input for set_worker_availability: `available: false` marks the person out on every day in the range. */
export const setWorkerAvailabilitySchema = z.object({
	workerName: z.string().trim().min(1),
	from: isoDate,
	to: isoDate,
	available: z.boolean(),
	reason: z.string().trim().max(200).optional()
});

/** Input for set_worker_station: pin a person to a station (by label) for one day. */
export const setWorkerStationSchema = z.object({
	workerName: z.string().trim().min(1),
	date: isoDate,
	// null/omitted clears the pin, leaving the day to the staffing plan.
	stationName: z.string().trim().min(1).nullable().optional()
});

/** Every day from `from` to `to` inclusive, as midnight-UTC Dates. Throws a StaffingError if the range is backwards or too long. */
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

/** An active person by name: exact (case-insensitive), else a unique partial match. Throws a StaffingError on no match or an ambiguous one. */
async function findWorker(name: string) {
	const workers = await prisma.worker.findMany({
		where: { archivedAt: null },
		select: { id: true, name: true, isMain: true, isOperator: true, certifications: { where: { station: { archivedAt: null } }, select: { stationId: true } } }
	});
	const lower = name.toLowerCase();
	const exact = workers.filter((w) => w.name.toLowerCase() === lower);
	const matches = exact.length ? exact : workers.filter((w) => w.name.toLowerCase().includes(lower));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new StaffingError(`No one called "${name}" is on the roster (Settings → People).`);
	throw new StaffingError(`"${name}" matches more than one person: ${matches.map((w) => w.name).join(', ')}. Say which one.`);
}

/** An active station by its label (case-insensitive), else a unique partial match. Throws a StaffingError on no match or an ambiguous one. */
async function findStation(name: string) {
	const stations = await prisma.station.findMany({ where: { archivedAt: null }, select: { id: true, label: true, kind: true } });
	const lower = name.toLowerCase();
	const exact = stations.filter((s) => s.label.toLowerCase() === lower);
	const matches = exact.length ? exact : stations.filter((s) => s.label.toLowerCase().includes(lower));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new StaffingError(`No active station called "${name}" (Settings → Stations).`);
	throw new StaffingError(`"${name}" matches more than one station: ${matches.map((s) => s.label).join(', ')}. Say which one.`);
}

/**
 * Who works where: the roster, days out, pins, and the crews on the approved schedule
 * (APPROVED / IN_PROGRESS only). Read-only. Throws a StaffingError for a bad range.
 */
export async function getStaffing(input: z.infer<typeof getStaffingSchema>) {
	const range = days(input.from, input.to);
	const from = range[0];
	const to = range[range.length - 1];
	const [workers, out, pins, assignments] = await Promise.all([
		prisma.worker.findMany({
			where: { archivedAt: null },
			orderBy: { name: 'asc' },
			select: {
				name: true,
				notes: true,
				isMain: true,
				isOperator: true,
				certifications: { where: { station: { archivedAt: null } }, select: { station: { select: { label: true, kind: true } } } }
			}
		}),
		prisma.workerUnavailability.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, reason: true, worker: { select: { name: true } } } }),
		prisma.staffingPin.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, worker: { select: { name: true } }, station: { select: { label: true } } } }),
		prisma.scheduleAssignment.findMany({
			where: { date: { gte: from, lte: to }, status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] } },
			select: { date: true, station: { select: { label: true, kind: true } }, crew: { select: { role: true, worker: { select: { name: true } } } } }
		})
	]);

	// One crew per (day, station), merged across that station's jobs that day — "|" keys
	// are split back apart below. Role ranks MAIN > OPERATOR > CATCH when a worker shows
	// up more than once on the same (day, station) with different roles.
	const roleRank = (role: 'MAIN' | 'OPERATOR' | 'CATCH') => (role === 'MAIN' ? 2 : role === 'OPERATOR' ? 1 : 0);
	const crews = new Map<string, { isPress: boolean; members: Map<string, { name: string; role: 'MAIN' | 'OPERATOR' | 'CATCH' }> }>();
	for (const a of assignments) {
		const key = `${iso(a.date)}|${a.station.label}`;
		const entry = crews.get(key) ?? { isPress: isPressKind(a.station.kind), members: new Map() };
		for (const member of a.crew) {
			const name = member.worker.name;
			const prev = entry.members.get(name);
			const role = !prev || roleRank(member.role) > roleRank(prev.role) ? member.role : prev.role;
			entry.members.set(name, { name, role });
		}
		crews.set(key, entry);
	}

	return {
		// Worker-level press role (2026-10-15): "main" lets them lead any press they're
		// certified on; "operator" is a fallback lead; otherwise they're a catch on any
		// press they're certified on.
		roster: workers.map((w) => ({
			name: w.name,
			notes: w.notes,
			pressRole: w.isMain ? 'main' : w.isOperator ? 'operator' : 'catch',
			certifiedOn: w.certifications.map((c) => c.station.label)
		})),
		out: out.map((o) => ({ date: iso(o.date), name: o.worker.name, reason: o.reason })),
		pinned: pins.map((p) => ({ date: iso(p.date), name: p.worker.name, station: p.station.label })),
		approvedCrews: [...crews.entries()]
			.map(([key, { isPress, members }]) => {
				const [date, station] = key.split('|');
				// A press crew is its lead first (MAIN then OPERATOR), then catches. There's no
				// catch without a lead (client, 2026-10-14): a press crew with no lead is
				// reported empty, with a note.
				const members2 = [...members.values()].map((m) => ({ name: m.name, isMain: m.role === 'MAIN' || m.role === 'OPERATOR' }));
				const sorted = pressSafeCrew(members2, isPress);
				const lead = isPress ? (sorted[0] ?? null) : null;
				const leadMember = lead ? members.get(lead.name) : null;
				return {
					date,
					station,
					...(isPress ? { lead: lead?.name ?? null, leadRole: leadMember?.role.toLowerCase() ?? null } : {}),
					...(isPress ? { catches: sorted.slice(1).map((m) => m.name) } : {}),
					crew: sorted.map((m) => m.name),
					...(isPress && !lead ? { note: 'No lead (main or operator) on this press, so nobody can run it — re-plan this day.' } : {})
				};
			})
			.sort((a, b) => a.date.localeCompare(b.date) || a.station.localeCompare(b.station))
	};
}

/**
 * Mark someone out (or back in) for a range of days. Marking out also clears any pin
 * they had on those days. Returns the approved jobs they're currently crewing on those
 * days — the ones a re-plan would need to cover. Doesn't change those jobs itself.
 *
 * @throws StaffingError for an unknown/ambiguous name or a bad range
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

/**
 * Pin someone to a station for one day (they must be certified and not out), or clear
 * the pin when no station is given.
 *
 * @throws StaffingError for an unknown/ambiguous name or station, a missing
 *   certification, or a person marked out that day
 */
export async function setWorkerStation(input: z.infer<typeof setWorkerStationSchema>, actor: string) {
	const worker = await findWorker(input.workerName);
	const station = input.stationName ? await findStation(input.stationName) : null;
	await prisma.$transaction((tx) => pinWorker(tx, { workerId: worker.id, date: input.date, stationId: station?.id ?? null }, actor));
	// A catch only assists a lead (main or operator) (client, 2026-10-14; 2026-10-15 for
	// operator-as-lead), so say what happens without one when the pinned person is a catch.
	const catchOnly = station && isPressKind(station.kind) && !worker.isMain && !worker.isOperator;
	return {
		name: worker.name,
		date: input.date,
		station: station?.label ?? null,
		...(catchOnly
			? { note: `${worker.name} can only catch on ${station.label}, so they work there only if a main or operator is on it that day; otherwise the plan puts them elsewhere.` }
			: {})
	};
}

type Tx = Pick<typeof prisma, 'worker' | 'station' | 'workerUnavailability' | 'staffingPin' | 'domainAuditLog'>;

/**
 * Pins a person (by id) to a station (by id) for one day, or clears their pin for that
 * day when `stationId` is null — the board's People panel (2026-10-14) and
 * setWorkerStation share it. Runs inside the caller's transaction.
 *
 * @throws StaffingError for an archived/unknown person or station, a missing
 *   certification, or a person marked out that day
 */
export async function pinWorker(tx: Tx, input: { workerId: string; date: string; stationId: string | null }, actor: string) {
	const worker = await tx.worker.findFirst({
		where: { id: input.workerId, archivedAt: null },
		// `station.kind` is pulled through for the Relabel-needs-press rule below.
		select: { id: true, name: true, certifications: { where: { station: { archivedAt: null } }, select: { stationId: true, station: { select: { kind: true } } } } }
	});
	if (!worker) throw new StaffingError('That person is no longer on the roster (Settings → People).');
	const date = new Date(`${input.date}T00:00:00Z`);

	if (!input.stationId) {
		await tx.staffingPin.deleteMany({ where: { workerId: worker.id, date } });
		await tx.domainAuditLog.create({ data: { entity: 'Worker', entityId: worker.id, action: 'worker_station_unpinned', actor, diff: { name: worker.name, date: input.date } } });
		return;
	}

	const station = await tx.station.findFirst({ where: { id: input.stationId, archivedAt: null }, select: { id: true, label: true, kind: true } });
	if (!station) throw new StaffingError('That station no longer exists (Settings → Stations).');
	if (!worker.certifications.some((c) => c.stationId === station.id)) {
		throw new StaffingError(`${worker.name} isn't certified on ${station.label}. Add the certification in Settings → People first if they should be.`);
	}
	// Relabel is done BY the press operator between press runs — a worker pinned to a
	// Printed Relabel station must also be certified on at least one Screen Print (press)
	// station. Enforced here (set_worker_station and the board's People panel), in
	// createWorker/updateWorker, and in planStaffing so chat, UI and engine all agree.
	if (station.kind === PRINTED_RELABEL_KIND && !worker.certifications.some((c) => isPressKind(c.station.kind))) {
		throw new StaffingError(`${worker.name} isn't certified on a Screen Print station, so they can't run Printed Relabel — relabel is handled by the press operator between runs. Certify ${worker.name} on a Screen Print station first.`);
	}
	const out = await tx.workerUnavailability.findUnique({ where: { workerId_date: { workerId: worker.id, date } } });
	if (out) throw new StaffingError(`${worker.name} is marked out on ${input.date}. Mark them available first.`);

	await tx.staffingPin.upsert({
		where: { workerId_date: { workerId: worker.id, date } },
		create: { workerId: worker.id, date, stationId: station.id, createdBy: actor },
		update: { stationId: station.id, createdBy: actor }
	});
	await tx.domainAuditLog.create({
		data: { entity: 'Worker', entityId: worker.id, action: 'worker_station_pinned', actor, diff: { name: worker.name, date: input.date, station: station.label } }
	});
}
