import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { scopeToWireFormat } from '$lib/server/mcp/scopes';
import { isAdmin, requireAdminApi } from '$lib/server/auth/guards';
import {
	StationConfigError,
	archiveStation,
	createStation,
	createStationSchema,
	listStations,
	moveStation,
	restoreStation,
	stationKindOptions,
	updateStation,
	updateStationSchema
} from '$lib/server/config/stations';
import { WorkerConfigError, createWorker, listWorkers, setWorkerArchived, updateWorker, updateWorkerSchema, workerSchema } from '$lib/server/config/workers';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/api/auth/google/login?redirectTo=${encodeURIComponent(url.pathname)}`);
	}

	const [activeTokenCount, connectedClients] = await Promise.all([
		prisma.mcpAccessToken.count({
			where: { userId: locals.user.id, revokedAt: null, expiresAt: { gt: new Date() } }
		}),
		prisma.mcpAccessToken.findMany({
			where: { userId: locals.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
			distinct: ['clientId'],
			include: { client: { select: { clientName: true, clientId: true } } }
		})
	]);

	return {
		scopes: locals.user.mcpScopes
			.filter((grant) => grant.revokedAt === null)
			.map((grant) => scopeToWireFormat(grant.scope)),
		activeTokenCount,
		connectedClients: connectedClients.map((token) => ({
			clientId: token.client.clientId,
			clientName: token.client.clientName ?? token.client.clientId
		})),
		// Shop config (Stations / People tabs, 2026-09-25) — admins only; null hides
		// the tabs. The actions below re-check admin on every write.
		shopConfig: isAdmin(locals.user) ? await loadShopConfig() : null
	};
};

async function loadShopConfig() {
	const [stations, workers] = await Promise.all([listStations(), listWorkers()]);
	return { stationKindOptions, stations, workers };
}

export const actions: Actions = {
	// --- Stations tab ---
	createStation: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('stations', async () => {
			const input = parseOrFail(createStationSchema, {
				label: data.get('label'),
				kind: data.get('kind'),
				autoSchedule: data.get('autoSchedule') === 'on'
			});
			const station = await createStation(input, actor);
			return `Added ${station.label}.`;
		});
	},

	updateStation: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('stations', async () => {
			const input = parseOrFail(updateStationSchema, {
				id: data.get('id'),
				label: data.get('label'),
				autoSchedule: data.get('autoSchedule') === 'on'
			});
			const station = await updateStation(input, actor);
			return `Saved ${station.label}.`;
		});
	},

	moveStation: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		const direction = data.get('direction');
		if (direction !== 'up' && direction !== 'down') throw error(400, 'direction must be up or down');
		return runConfig('stations', async () => {
			await moveStation(requireId(data), direction, actor);
			return null;
		});
	},

	archiveStation: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('stations', async () => {
			await archiveStation(requireId(data), actor);
			return 'Station removed. It stays in Reports and history, and can be restored below.';
		});
	},

	restoreStation: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('stations', async () => {
			await restoreStation(requireId(data), actor);
			return 'Station restored.';
		});
	},

	// --- People tab ---
	createWorker: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('people', async () => {
			const input = parseOrFail(workerSchema, {
				name: data.get('name'),
				notes: data.get('notes') ?? '',
				stationIds: data.getAll('stationId')
			});
			await createWorker(input, actor);
			return `Added ${input.name}.`;
		});
	},

	updateWorker: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('people', async () => {
			const input = parseOrFail(updateWorkerSchema, {
				id: data.get('id'),
				name: data.get('name'),
				notes: data.get('notes') ?? '',
				stationIds: data.getAll('stationId')
			});
			await updateWorker(input, actor);
			return `Saved ${input.name}.`;
		});
	},

	archiveWorker: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('people', async () => {
			await setWorkerArchived(requireId(data), true, actor);
			return 'Person removed. They can be restored below.';
		});
	},

	restoreWorker: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runConfig('people', async () => {
			await setWorkerArchived(requireId(data), false, actor);
			return 'Person restored.';
		});
	}
};

class ConfigInputError extends Error {}

function parseOrFail<T>(schema: z.ZodType<T>, raw: unknown): T {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw new ConfigInputError(parsed.error.issues[0]?.message ?? 'Invalid input.');
	return parsed.data;
}

/** Runs one Stations/People action; an expected refusal (bad input, name clash,
 *  station still has work on it) comes back as a message on that tab, anything
 *  else is a real error. */
async function runConfig(screen: 'stations' | 'people', run: () => Promise<string | null>) {
	try {
		const notice = await run();
		return { screen, success: true as const, notice };
	} catch (err) {
		if (err instanceof ConfigInputError || err instanceof StationConfigError || err instanceof WorkerConfigError) {
			return fail(400, { screen, message: err.message });
		}
		throw err;
	}
}

function requireId(data: FormData) {
	const id = data.get('id');
	if (typeof id !== 'string' || !id) throw error(400, 'id is required');
	return id;
}
