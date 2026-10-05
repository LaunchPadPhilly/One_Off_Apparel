import { z } from 'zod';
import { prisma } from '$lib/server/prisma';

/**
 * The shop-floor roster (config settings, 2026-09-25): people by name, each with the
 * stations they're certified to run. Floor staff don't log in, so a Worker is
 * deliberately not linked to User. "Delete" is an archive, same as stations, so a
 * person's past crew assignments (AssignmentCrew) keep their history.
 *
 * Certifications are what the daily staffing plan (engine/planStaffing.ts, fed by
 * schedule/buildBacklogAndCapacity.ts) and the set_worker_station MCP tool read to
 * enforce "only certified people on a station" (2026-09-28).
 *
 * Called from the admin-only People screen (src/routes/settings/+page.server.ts,
 * `?screen=people`), which calls `requireAdminApi` before anything here — these
 * functions do no permission check of their own. Every change writes a DomainAuditLog row
 * in the same transaction.
 */

/** A refusal whose message is written for the admin; the settings page shows it as-is. */
export class WorkerConfigError extends Error {}

/** Form input for a new person: name, optional notes (blank → null), certified station ids. */
export const workerSchema = z.object({
	name: z.string().trim().min(1, 'Name is required.').max(80, 'Name must be 80 characters or fewer.'),
	notes: z
		.string()
		.trim()
		.max(500, 'Notes must be 500 characters or fewer.')
		.transform((value) => value || null),
	stationIds: z.array(z.string().min(1)).max(200)
});

/** Same as workerSchema plus the id of the person being edited. */
export const updateWorkerSchema = workerSchema.extend({ id: z.string().min(1) });

/** Every person, active first then archived, each A–Z, with their certified station ids
 *  (archived stations included). */
export async function listWorkers() {
	const workers = await prisma.worker.findMany({
		orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
		include: { certifications: { select: { stationId: true } } }
	});
	return workers.map((worker) => ({
		id: worker.id,
		name: worker.name,
		notes: worker.notes,
		archivedAt: worker.archivedAt,
		stationIds: worker.certifications.map((cert) => cert.stationId)
	}));
}

/** Only active stations can be certified on — a hand-crafted POST naming an archived
 *  or unknown station id is refused rather than silently stored. */
async function assertActiveStations(tx: Pick<typeof prisma, 'station'>, stationIds: string[]) {
	if (stationIds.length === 0) return;
	const found = await tx.station.count({ where: { id: { in: stationIds }, archivedAt: null } });
	if (found !== new Set(stationIds).size) throw new WorkerConfigError('One of the selected stations no longer exists — reload and try again.');
}

/** Adds a person with their certifications; returns the new row. Throws
 *  WorkerConfigError if any station id isn't an active station. */
export async function createWorker(input: z.infer<typeof workerSchema>, actor: string) {
	const stationIds = [...new Set(input.stationIds)];
	return prisma.$transaction(async (tx) => {
		await assertActiveStations(tx, stationIds);
		const worker = await tx.worker.create({
			data: { name: input.name, notes: input.notes, certifications: { create: stationIds.map((stationId) => ({ stationId })) } }
		});
		await tx.domainAuditLog.create({
			data: { entity: 'Worker', entityId: worker.id, action: 'worker_created', actor, diff: { name: input.name, stationIds } }
		});
		return worker;
	});
}

/**
 * Replaces the person's certifications with exactly the active stations ticked.
 * Certifications on *archived* stations aren't shown in the form, so they're left
 * alone — restoring that station restores the certification with it. Throws
 * WorkerConfigError if the person is missing or a station id isn't an active station.
 */
export async function updateWorker(input: z.infer<typeof updateWorkerSchema>, actor: string) {
	const stationIds = [...new Set(input.stationIds)];
	return prisma.$transaction(async (tx) => {
		const existing = await tx.worker.findUnique({ where: { id: input.id }, include: { certifications: { include: { station: { select: { archivedAt: true } } } } } });
		if (!existing) throw new WorkerConfigError('Person not found.');
		await assertActiveStations(tx, stationIds);

		const before = existing.certifications.filter((cert) => !cert.station.archivedAt).map((cert) => cert.stationId);
		const removed = before.filter((id) => !stationIds.includes(id));
		const added = stationIds.filter((id) => !before.includes(id));

		await tx.worker.update({ where: { id: input.id }, data: { name: input.name, notes: input.notes } });
		if (removed.length > 0) await tx.workerCertification.deleteMany({ where: { workerId: input.id, stationId: { in: removed } } });
		if (added.length > 0) await tx.workerCertification.createMany({ data: added.map((stationId) => ({ workerId: input.id, stationId })) });

		await tx.domainAuditLog.create({
			data: {
				entity: 'Worker',
				entityId: input.id,
				action: 'worker_updated',
				actor,
				diff: { from: { name: existing.name, notes: existing.notes }, to: { name: input.name, notes: input.notes }, certificationsAdded: added, certificationsRemoved: removed }
			}
		});
	});
}

/** Archives ("deletes") or restores a person. No-op if already in that state. Throws
 *  WorkerConfigError if the person doesn't exist. */
export async function setWorkerArchived(id: string, archived: boolean, actor: string) {
	return prisma.$transaction(async (tx) => {
		const worker = await tx.worker.findUnique({ where: { id } });
		if (!worker) throw new WorkerConfigError('Person not found.');
		if (Boolean(worker.archivedAt) === archived) return;
		await tx.worker.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
		await tx.domainAuditLog.create({
			data: { entity: 'Worker', entityId: id, action: archived ? 'worker_archived' : 'worker_restored', actor, diff: { name: worker.name } }
		});
	});
}
