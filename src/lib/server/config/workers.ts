import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { isPressKind } from '$lib/schedule/stationKinds';

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
	stationIds: z.array(z.string().min(1)).max(200),
	// Presses this person may run as the main printer (2026-10-14). Ticking "Main"
	// certifies them on that press too; ignored for stations that aren't presses.
	mainStationIds: z.array(z.string().min(1)).max(200).default([])
});

/** Same as workerSchema plus the id of the person being edited. */
export const updateWorkerSchema = workerSchema.extend({ id: z.string().min(1) });

/** Every person, active first then archived, each A–Z, with their certified station ids
 *  (archived stations included). */
export async function listWorkers() {
	const workers = await prisma.worker.findMany({
		orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
		include: { certifications: { select: { stationId: true, isMain: true } } }
	});
	return workers.map((worker) => ({
		id: worker.id,
		name: worker.name,
		notes: worker.notes,
		archivedAt: worker.archivedAt,
		stationIds: worker.certifications.map((cert) => cert.stationId),
		mainStationIds: worker.certifications.filter((cert) => cert.isMain).map((cert) => cert.stationId)
	}));
}

/** Only active stations can be certified on — a hand-crafted POST naming an archived
 *  or unknown station id is refused rather than silently stored. */
async function assertActiveStations(tx: Pick<typeof prisma, 'station'>, stationIds: string[]) {
	if (stationIds.length === 0) return;
	const found = await tx.station.count({ where: { id: { in: stationIds }, archivedAt: null } });
	if (found !== new Set(stationIds).size) throw new WorkerConfigError('One of the selected stations no longer exists — reload and try again.');
}

/** The certified station ids (a "Main" tick certifies too) and, of those, the presses
 *  the person may run as main — anything ticked "Main" that isn't a press is dropped. */
async function resolveCertifications(tx: Pick<typeof prisma, 'station'>, input: { stationIds: string[]; mainStationIds: string[] }) {
	const stationIds = [...new Set([...input.stationIds, ...input.mainStationIds])];
	await assertActiveStations(tx, stationIds);
	const presses = new Set(
		(await tx.station.findMany({ where: { id: { in: input.mainStationIds } }, select: { id: true, kind: true } })).filter((s) => isPressKind(s.kind)).map((s) => s.id)
	);
	const mainStationIds = new Set(input.mainStationIds.filter((id) => presses.has(id)));
	return { stationIds, mainStationIds };
}

/** Adds a person with their certifications; returns the new row. Throws
 *  WorkerConfigError if any station id isn't an active station. */
export async function createWorker(input: z.infer<typeof workerSchema>, actor: string) {
	return prisma.$transaction(async (tx) => {
		const { stationIds, mainStationIds } = await resolveCertifications(tx, input);
		const worker = await tx.worker.create({
			data: {
				name: input.name,
				notes: input.notes,
				certifications: { create: stationIds.map((stationId) => ({ stationId, isMain: mainStationIds.has(stationId) })) }
			}
		});
		await tx.domainAuditLog.create({
			data: { entity: 'Worker', entityId: worker.id, action: 'worker_created', actor, diff: { name: input.name, stationIds, mainStationIds: [...mainStationIds] } }
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
	return prisma.$transaction(async (tx) => {
		const existing = await tx.worker.findUnique({ where: { id: input.id }, include: { certifications: { include: { station: { select: { archivedAt: true } } } } } });
		if (!existing) throw new WorkerConfigError('Person not found.');
		const { stationIds, mainStationIds } = await resolveCertifications(tx, input);

		const activeCerts = existing.certifications.filter((cert) => !cert.station.archivedAt);
		const before = activeCerts.map((cert) => cert.stationId);
		const removed = before.filter((id) => !stationIds.includes(id));
		const added = stationIds.filter((id) => !before.includes(id));
		const mainChanged = activeCerts.filter((cert) => stationIds.includes(cert.stationId) && cert.isMain !== mainStationIds.has(cert.stationId));

		await tx.worker.update({ where: { id: input.id }, data: { name: input.name, notes: input.notes } });
		if (removed.length > 0) await tx.workerCertification.deleteMany({ where: { workerId: input.id, stationId: { in: removed } } });
		if (added.length > 0) await tx.workerCertification.createMany({ data: added.map((stationId) => ({ workerId: input.id, stationId, isMain: mainStationIds.has(stationId) })) });
		for (const cert of mainChanged) {
			await tx.workerCertification.update({ where: { workerId_stationId: { workerId: input.id, stationId: cert.stationId } }, data: { isMain: mainStationIds.has(cert.stationId) } });
		}

		await tx.domainAuditLog.create({
			data: {
				entity: 'Worker',
				entityId: input.id,
				action: 'worker_updated',
				actor,
				diff: {
					from: { name: existing.name, notes: existing.notes },
					to: { name: input.name, notes: input.notes },
					certificationsAdded: added,
					certificationsRemoved: removed,
					mainChanged: mainChanged.map((cert) => ({ stationId: cert.stationId, isMain: mainStationIds.has(cert.stationId) }))
				}
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
