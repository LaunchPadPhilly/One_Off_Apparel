import { z } from 'zod';
import { prisma } from '$lib/server/prisma';

/**
 * The shop-floor roster (config settings, 2026-09-25): people by name, each with the
 * stations they're certified to run. Floor staff don't log in, so a Worker is
 * deliberately not linked to User. "Delete" is an archive, same as stations, so a
 * person's past assignments (once assignment-to-people lands) keep their history.
 *
 * Nothing reads certifications yet — the next step (crew-based estimates and the
 * engine picking people) is what enforces "only certified people on a station".
 */

export class WorkerConfigError extends Error {}

export const workerSchema = z.object({
	name: z.string().trim().min(1, 'Name is required.').max(80, 'Name must be 80 characters or fewer.'),
	notes: z
		.string()
		.trim()
		.max(500, 'Notes must be 500 characters or fewer.')
		.transform((value) => value || null),
	stationIds: z.array(z.string().min(1)).max(200)
});

export const updateWorkerSchema = workerSchema.extend({ id: z.string().min(1) });

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
 * alone — restoring that station restores the certification with it.
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
