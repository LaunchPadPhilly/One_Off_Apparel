import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { isPressKind, PRINTED_RELABEL_KIND } from '$lib/schedule/stationKinds';

/**
 * The shop-floor roster (config settings, 2026-09-25): people by name, each with the
 * stations they're certified to run. Floor staff don't log in, so a Worker is
 * deliberately not linked to User. "Delete" is an archive, same as stations, so a
 * person's past crew assignments (AssignmentCrew) keep their history.
 *
 * Press-role flags (2026-10-15, replacing an earlier per-certification isMain):
 * `isMain` and `isOperator` live on Worker and apply to every press they're
 * certified on. A main may run any press as the main printer; an operator is a
 * middle tier (can run a press as a fallback lead but the planner picks a main
 * first); everyone else certified on a press is a catch.
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

/** Form input for a new person: name, optional notes (blank → null), certified station ids,
 *  and the two worker-level press-role flags (ignored if the person is certified on no press). */
export const workerSchema = z.object({
	name: z.string().trim().min(1, 'Name is required.').max(80, 'Name must be 80 characters or fewer.'),
	notes: z
		.string()
		.trim()
		.max(500, 'Notes must be 500 characters or fewer.')
		.transform((value) => value || null),
	stationIds: z.array(z.string().min(1)).max(200),
	isMain: z.boolean().default(false),
	isOperator: z.boolean().default(false)
});

/** Same as workerSchema plus the id of the person being edited. */
export const updateWorkerSchema = workerSchema.extend({ id: z.string().min(1) });

/** Every person, active first then archived, each A–Z, with their certified station ids
 *  (archived stations included) and their worker-level press-role flags. */
export async function listWorkers() {
	const workers = await prisma.worker.findMany({
		orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
		include: { certifications: { select: { stationId: true } } }
	});
	return workers.map((worker) => ({
		id: worker.id,
		name: worker.name,
		notes: worker.notes,
		isMain: worker.isMain,
		isOperator: worker.isOperator,
		archivedAt: worker.archivedAt,
		stationIds: worker.certifications.map((cert) => cert.stationId)
	}));
}

/** Only active stations can be certified on — a hand-crafted POST naming an archived
 *  or unknown station id is refused rather than silently stored. ALSO enforces the
 *  Relabel-needs-press rule: a worker certified on a Printed Relabel station must also
 *  be certified on at least one Screen Print (press) station, because Relabel is done by
 *  the press operator between press runs. The rule is enforced here, in the staffing
 *  pin (setWorkerStation), in planStaffing's crew selection, and surfaced in the People
 *  screen — all four so the chat, UI and engine paths agree. */
async function assertActiveStations(tx: Pick<typeof prisma, 'station'>, stationIds: string[]) {
	if (stationIds.length === 0) return;
	const rows = await tx.station.findMany({ where: { id: { in: stationIds }, archivedAt: null }, select: { kind: true } });
	if (rows.length !== new Set(stationIds).size) throw new WorkerConfigError('One of the selected stations no longer exists — reload and try again.');
	const hasRelabel = rows.some((r) => r.kind === PRINTED_RELABEL_KIND);
	const hasPress = rows.some((r) => isPressKind(r.kind));
	if (hasRelabel && !hasPress) {
		throw new WorkerConfigError('Printed Relabel can only be run by a press operator — also tick a Screen Print station for this person, or untick Printed Relabel.');
	}
}

/** Adds a person with their certifications and worker-level press-role flags; returns
 *  the new row. Throws WorkerConfigError if any station id isn't an active station. */
export async function createWorker(input: z.infer<typeof workerSchema>, actor: string) {
	return prisma.$transaction(async (tx) => {
		const stationIds = [...new Set(input.stationIds)];
		await assertActiveStations(tx, stationIds);
		// A main outranks operator — if someone ticked both, main wins and operator stays
		// off (the planner never reads operator on a main, but keep the stored flag clean).
		const isMain = input.isMain;
		const isOperator = !isMain && input.isOperator;
		const worker = await tx.worker.create({
			data: {
				name: input.name,
				notes: input.notes,
				isMain,
				isOperator,
				certifications: { create: stationIds.map((stationId) => ({ stationId })) }
			}
		});
		await tx.domainAuditLog.create({
			data: { entity: 'Worker', entityId: worker.id, action: 'worker_created', actor, diff: { name: input.name, stationIds, isMain, isOperator } }
		});
		return worker;
	});
}

/**
 * Replaces the person's certifications with exactly the active stations ticked, and
 * updates their worker-level press-role flags. Certifications on *archived* stations
 * aren't shown in the form, so they're left alone — restoring that station restores
 * the certification with it. Throws WorkerConfigError if the person is missing or a
 * station id isn't an active station.
 */
export async function updateWorker(input: z.infer<typeof updateWorkerSchema>, actor: string) {
	return prisma.$transaction(async (tx) => {
		const existing = await tx.worker.findUnique({
			where: { id: input.id },
			include: { certifications: { include: { station: { select: { archivedAt: true } } } } }
		});
		if (!existing) throw new WorkerConfigError('Person not found.');
		const stationIds = [...new Set(input.stationIds)];
		await assertActiveStations(tx, stationIds);
		const isMain = input.isMain;
		const isOperator = !isMain && input.isOperator;

		const activeCerts = existing.certifications.filter((cert) => !cert.station.archivedAt);
		const before = activeCerts.map((cert) => cert.stationId);
		const removed = before.filter((id) => !stationIds.includes(id));
		const added = stationIds.filter((id) => !before.includes(id));
		const flagsChanged = existing.isMain !== isMain || existing.isOperator !== isOperator;

		await tx.worker.update({
			where: { id: input.id },
			data: { name: input.name, notes: input.notes, isMain, isOperator }
		});
		if (removed.length > 0) await tx.workerCertification.deleteMany({ where: { workerId: input.id, stationId: { in: removed } } });
		if (added.length > 0) await tx.workerCertification.createMany({ data: added.map((stationId) => ({ workerId: input.id, stationId })) });

		await tx.domainAuditLog.create({
			data: {
				entity: 'Worker',
				entityId: input.id,
				action: 'worker_updated',
				actor,
				diff: {
					from: { name: existing.name, notes: existing.notes, isMain: existing.isMain, isOperator: existing.isOperator },
					to: { name: input.name, notes: input.notes, isMain, isOperator },
					certificationsAdded: added,
					certificationsRemoved: removed,
					flagsChanged
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
