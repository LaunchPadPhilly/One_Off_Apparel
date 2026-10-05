import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { STATION_KINDS, isStationKind } from '$lib/schedule/stationKinds';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Admin-managed stations (config settings, 2026-09-25) — the rows on the schedule
 * board. Admins add a station (a second auto press, the manual press), rename it,
 * reorder it, choose whether the automatic engine may place jobs on it, and "delete"
 * it. Delete is an archive (`archivedAt`), never a hard delete: Actuals and past
 * ScheduleAssignments reference the station (onDelete: Restrict), and Reports reads
 * them. Archived stations drop out of the board, the engine's capacity and worker
 * certification pickers; Restore brings one back unchanged.
 *
 * `kind` (which estimate_hours formula the station runs) is fixed at creation — a job
 * already placed on a station was placed there *because* of its kind, so changing it
 * would silently invalidate the board's row restriction. Archive and re-create instead.
 *
 * Called from the admin-only Stations screen (src/routes/settings/+page.server.ts,
 * `?screen=stations`), which calls `requireAdminApi` before anything here — these
 * functions do no permission check of their own. Every change writes a DomainAuditLog row
 * in the same transaction.
 */

/** A refusal whose message is written for the admin (e.g. a duplicate name); the
 *  settings page shows it as-is. */
export class StationConfigError extends Error {}

/** Assignment statuses that mean "this station still has live work on it". */
const OPEN_ASSIGNMENT_STATUSES = [ScheduleAssignmentStatus.PROPOSED, ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS];

const labelSchema = z.string().trim().min(1, 'Name is required.').max(60, 'Name must be 60 characters or fewer.');

/** Form input for a new station. `kind` must be one of STATION_KINDS. */
export const createStationSchema = z.object({
	label: labelSchema,
	kind: z.string().refine(isStationKind, 'Pick what kind of station this is.'),
	autoSchedule: z.boolean()
});

/** Form input for editing a station. No `kind` — it's fixed at creation (see above). */
export const updateStationSchema = z.object({
	id: z.string().min(1),
	label: labelSchema,
	autoSchedule: z.boolean()
});

/** Every station, archived included, in board order, with how many active people are
 *  certified on it and how many open (proposed/approved/in-progress) jobs it has. */
export async function listStations() {
	const [stations, openCounts] = await Promise.all([
		prisma.station.findMany({
			orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
			include: { _count: { select: { certifications: { where: { worker: { archivedAt: null } } } } } }
		}),
		prisma.scheduleAssignment.groupBy({
			by: ['stationId'],
			where: { status: { in: OPEN_ASSIGNMENT_STATUSES } },
			_count: { _all: true }
		})
	]);
	const openByStation = new Map(openCounts.map((row) => [row.stationId, row._count._all]));
	return stations.map((station) => ({
		id: station.id,
		label: station.label,
		kind: station.kind,
		autoSchedule: station.autoSchedule,
		archivedAt: station.archivedAt,
		certifiedCount: station._count.certifications,
		openAssignmentCount: openByStation.get(station.id) ?? 0
	}));
}

/** The "kind" dropdown's options for the create form. */
export const stationKindOptions = STATION_KINDS.map((kind) => ({ value: kind.key, label: kind.label, category: kind.category }));

/** Case-insensitive: two active stations both called "Screen Print Auto" would make
 *  the board ambiguous. Archived stations don't count, so a name can be reused. */
async function assertLabelFree(tx: Pick<typeof prisma, 'station'>, label: string, exceptId?: string) {
	const clash = await tx.station.findFirst({
		where: { label: { equals: label, mode: 'insensitive' }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
		select: { id: true }
	});
	if (clash) throw new StationConfigError(`There's already an active station called "${label}".`);
}

/** "Screen Print & Wash" → "screen_print_and_wash"; falls back to "station" if nothing is left. */
function slugify(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/&/g, 'and')
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'station'
	);
}

/** Adds a station and returns the new row. Throws StationConfigError if an active
 *  station already has that label. */
export async function createStation(input: z.infer<typeof createStationSchema>, actor: string) {
	return prisma.$transaction(async (tx) => {
		await assertLabelFree(tx, input.label);

		// `name` is the internal, never-edited identifier the board keys rows by —
		// derived once from the first label, suffixed until unique.
		const base = slugify(input.label);
		let name = base;
		for (let n = 2; await tx.station.findUnique({ where: { name }, select: { id: true } }); n++) name = `${base}_${n}`;

		// New stations go right after the last station of the same kind (so a second
		// auto press sits next to the first), else at the end.
		const [lastOfKind, last] = await Promise.all([
			tx.station.findFirst({ where: { kind: input.kind }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } }),
			tx.station.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } })
		]);
		const sortOrder = lastOfKind ? lastOfKind.sortOrder + 1 : (last?.sortOrder ?? 0) + 10;

		const station = await tx.station.create({
			data: { name, label: input.label, kind: input.kind, autoSchedule: input.autoSchedule, sortOrder, type: 'production' }
		});
		await tx.domainAuditLog.create({
			data: { entity: 'Station', entityId: station.id, action: 'station_created', actor, diff: { label: input.label, kind: input.kind, autoSchedule: input.autoSchedule } }
		});
		return station;
	});
}

/** Renames a station and/or toggles `autoSchedule`; returns the updated row. Throws
 *  StationConfigError if it doesn't exist or the new label clashes with an active one. */
export async function updateStation(input: z.infer<typeof updateStationSchema>, actor: string) {
	return prisma.$transaction(async (tx) => {
		const existing = await tx.station.findUnique({ where: { id: input.id } });
		if (!existing) throw new StationConfigError('Station not found.');
		// An archived station's label is only checked for clashes when it's restored.
		if (!existing.archivedAt) await assertLabelFree(tx, input.label, input.id);

		const updated = await tx.station.update({ where: { id: input.id }, data: { label: input.label, autoSchedule: input.autoSchedule } });
		await tx.domainAuditLog.create({
			data: {
				entity: 'Station',
				entityId: input.id,
				action: 'station_updated',
				actor,
				diff: { from: { label: existing.label, autoSchedule: existing.autoSchedule }, to: { label: input.label, autoSchedule: input.autoSchedule } }
			}
		});
		return updated;
	});
}

/** Swap with the neighbouring active station above/below — the board's row order.
 *  Already at the top/bottom → does nothing. Throws StationConfigError if `id` isn't an
 *  active station. */
export async function moveStation(id: string, direction: 'up' | 'down', actor: string) {
	return prisma.$transaction(async (tx) => {
		const stations = await tx.station.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }], select: { id: true } });
		const index = stations.findIndex((station) => station.id === id);
		if (index === -1) throw new StationConfigError('Station not found.');
		const target = direction === 'up' ? index - 1 : index + 1;
		if (target < 0 || target >= stations.length) return;

		// Renumber everything 0..N-1 in the new order so ties or gaps from older rows
		// can't make the swap a no-op.
		const reordered = stations.map((station) => station.id);
		[reordered[index], reordered[target]] = [reordered[target], reordered[index]];
		for (const [sortOrder, stationId] of reordered.entries()) {
			await tx.station.update({ where: { id: stationId }, data: { sortOrder } });
		}
		await tx.domainAuditLog.create({ data: { entity: 'Station', entityId: id, action: 'station_reordered', actor, diff: { direction } } });
	});
}

/**
 * "Delete". Refused while the station still has proposed/approved/in-progress work,
 * because that work would vanish from the board without being done or moved — the
 * admin moves or removes it first (a draft can simply be deleted). Throws
 * StationConfigError (naming the drafts involved) when refused, or if the station is
 * missing or already archived.
 */
export async function archiveStation(id: string, actor: string) {
	return prisma.$transaction(async (tx) => {
		const station = await tx.station.findUnique({ where: { id } });
		if (!station) throw new StationConfigError('Station not found.');
		if (station.archivedAt) throw new StationConfigError(`${station.label} is already archived.`);

		const open = await tx.scheduleAssignment.findMany({
			where: { stationId: id, status: { in: OPEN_ASSIGNMENT_STATUSES } },
			select: { scheduleDraft: { select: { name: true } } }
		});
		if (open.length > 0) {
			// Assignments with no draft are on the live schedule (approved / in progress, or
			// the propose_schedule MCP tool's un-drafted proposals).
			const drafts = [...new Set(open.map((row) => row.scheduleDraft?.name).filter((name): name is string => Boolean(name)))];
			const location = drafts.length > 0 ? ` (in ${drafts.map((name) => `"${name}"`).join(', ')}${open.some((row) => !row.scheduleDraft) ? ' and the live schedule' : ''})` : ' on the live schedule';
			throw new StationConfigError(
				`${station.label} still has ${open.length} scheduled job${open.length === 1 ? '' : 's'}${location}. Move or remove ${open.length === 1 ? 'it' : 'them'} first, then remove the station.`
			);
		}

		await tx.station.update({ where: { id }, data: { archivedAt: new Date() } });
		await tx.domainAuditLog.create({ data: { entity: 'Station', entityId: id, action: 'station_archived', actor, diff: { label: station.label } } });
	});
}

/** Un-archives a station (no-op if it isn't archived). Throws StationConfigError if it's
 *  missing or an active station has since taken its label. */
export async function restoreStation(id: string, actor: string) {
	return prisma.$transaction(async (tx) => {
		const station = await tx.station.findUnique({ where: { id } });
		if (!station) throw new StationConfigError('Station not found.');
		if (!station.archivedAt) return;
		await assertLabelFree(tx, station.label, id);
		await tx.station.update({ where: { id }, data: { archivedAt: null } });
		await tx.domainAuditLog.create({ data: { entity: 'Station', entityId: id, action: 'station_restored', actor, diff: { label: station.label } } });
	});
}
