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
import { DEFAULT_FORMULAS, currentFormulas, saveFormulas, type FormulaSettings } from '$lib/server/engine/formulaSettings';
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
		shopConfig: isAdmin(locals.user) ? await loadShopConfig() : null,
		// Formula settings (Formulas tab, 2026-09-28) — admin-only editable per-station
		// rates and factors. Both current (with any DB overrides applied) and pristine
		// defaults are sent so the form can render each field with a "default: N" hint,
		// so an admin sees where the baseline is before overriding it.
		formulaConfig: isAdmin(locals.user)
			? { current: currentFormulas(), defaults: DEFAULT_FORMULAS }
			: null
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
	},

	// --- Formulas tab (2026-09-28) ---
	// One-shot save: reads every editable formula constant off the form, validates as a
	// positive number, and writes them as one merged FormulaSettings object. Blank
	// inputs fall back to whatever was already stored (never coerced to 0), so an admin
	// only saving one field doesn't accidentally zero out the rest.
	saveFormulas: async ({ request, locals }) => {
		const actor = requireAdminApi(locals.user).email;
		const data = await request.formData();
		return runFormulasSave(async () => {
			const next = parseFormulaFields(data, currentFormulas());
			await saveFormulas(next, actor);
			return 'Formulas saved. New estimates will use the updated numbers.';
		});
	}
};

async function runFormulasSave(run: () => Promise<string | null>) {
	try {
		const notice = await run();
		return { screen: 'formulas' as const, success: true as const, notice };
	} catch (err) {
		if (err instanceof ConfigInputError) return fail(400, { screen: 'formulas' as const, message: err.message });
		throw err;
	}
}

/**
 * Reads every formula field off `data`, using dotted names like
 * "sp.ratePerHour.LT_5.THIN" that map to nested FormulaSettings fields. A blank input
 * falls back to the CURRENT value (not the default), so partial saves don't overwrite
 * unrelated fields. Invalid input (non-numeric, negative, zero for rate-like fields)
 * throws ConfigInputError so runFormulasSave returns a form message instead of a 500.
 */
function parseFormulaFields(data: FormData, current: FormulaSettings): FormulaSettings {
	function readPositive(name: string, fallback: number, allowZero = false): number {
		const raw = data.get(name);
		if (typeof raw !== 'string' || raw.trim() === '') return fallback;
		const n = Number(raw);
		if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
			throw new ConfigInputError(`"${name}" must be a positive number${allowZero ? ' (or zero)' : ''}.`);
		}
		return n;
	}
	return {
		screenPrint: {
			initialUnits: {
				THIN: readPositive('sp.initialUnits.THIN', current.screenPrint.initialUnits.THIN),
				POLY: readPositive('sp.initialUnits.POLY', current.screenPrint.initialUnits.POLY),
				BULKY: readPositive('sp.initialUnits.BULKY', current.screenPrint.initialUnits.BULKY)
			},
			ratePerHour: {
				SCREENS_LT_5: {
					THIN: readPositive('sp.ratePerHour.LT_5.THIN', current.screenPrint.ratePerHour.SCREENS_LT_5.THIN),
					POLY: readPositive('sp.ratePerHour.LT_5.POLY', current.screenPrint.ratePerHour.SCREENS_LT_5.POLY),
					BULKY: readPositive('sp.ratePerHour.LT_5.BULKY', current.screenPrint.ratePerHour.SCREENS_LT_5.BULKY)
				},
				SCREENS_GT_4: {
					THIN: readPositive('sp.ratePerHour.GT_4.THIN', current.screenPrint.ratePerHour.SCREENS_GT_4.THIN),
					POLY: readPositive('sp.ratePerHour.GT_4.POLY', current.screenPrint.ratePerHour.SCREENS_GT_4.POLY),
					BULKY: readPositive('sp.ratePerHour.GT_4.BULKY', current.screenPrint.ratePerHour.SCREENS_GT_4.BULKY)
				}
			},
			setupMinutesPerScreen: readPositive('sp.setupMinutesPerScreen', current.screenPrint.setupMinutesPerScreen, true),
			setupMinutesPerInkColor: readPositive('sp.setupMinutesPerInkColor', current.screenPrint.setupMinutesPerInkColor, true),
			setupFixedMinutes: readPositive('sp.setupFixedMinutes', current.screenPrint.setupFixedMinutes, true)
		},
		embroidery: {
			threadChangeMinPerColor: readPositive('emb.threadChangeMinPerColor', current.embroidery.threadChangeMinPerColor, true),
			flat: {
				THIN: readEmbroideryPlan(data, 'emb.flat.THIN', current.embroidery.flat.THIN, readPositive),
				POLY: readEmbroideryPlan(data, 'emb.flat.POLY', current.embroidery.flat.POLY, readPositive),
				BULKY: readEmbroideryPlan(data, 'emb.flat.BULKY', current.embroidery.flat.BULKY, readPositive)
			},
			cap: {
				STRUCTURED: readEmbroideryPlan(data, 'emb.cap.STRUCTURED', current.embroidery.cap.STRUCTURED, readPositive),
				UNSTRUCTURED: readEmbroideryPlan(data, 'emb.cap.UNSTRUCTURED', current.embroidery.cap.UNSTRUCTURED, readPositive)
			}
		},
		finishing: {
			relabelUnitsPerHour: {
				THIN: readPositive('fin.relabelUnitsPerHour.THIN', current.finishing.relabelUnitsPerHour.THIN),
				POLY: readPositive('fin.relabelUnitsPerHour.POLY', current.finishing.relabelUnitsPerHour.POLY),
				BULKY: readPositive('fin.relabelUnitsPerHour.BULKY', current.finishing.relabelUnitsPerHour.BULKY)
			},
			hangTagUnitsPerHour: {
				THIN: readPositive('fin.hangTagUnitsPerHour.THIN', current.finishing.hangTagUnitsPerHour.THIN),
				POLY: readPositive('fin.hangTagUnitsPerHour.POLY', current.finishing.hangTagUnitsPerHour.POLY),
				BULKY: readPositive('fin.hangTagUnitsPerHour.BULKY', current.finishing.hangTagUnitsPerHour.BULKY)
			},
			foldBagUnitsPerHour: {
				SS_TEE: readPositive('fin.foldBagUnitsPerHour.SS_TEE', current.finishing.foldBagUnitsPerHour.SS_TEE),
				OTHER: readPositive('fin.foldBagUnitsPerHour.OTHER', current.finishing.foldBagUnitsPerHour.OTHER)
			},
			matteFlatMinutesNumerator: readPositive('fin.matteFlatMinutesNumerator', current.finishing.matteFlatMinutesNumerator),
			matteFlatRate: {
				THIN: readPositive('fin.matteFlatRate.THIN', current.finishing.matteFlatRate.THIN),
				POLY: readPositive('fin.matteFlatRate.POLY', current.finishing.matteFlatRate.POLY),
				BULKY: readPositive('fin.matteFlatRate.BULKY', current.finishing.matteFlatRate.BULKY)
			},
			matteSpecialtyMinutesPerUnit: readPositive('fin.matteSpecialtyMinutesPerUnit', current.finishing.matteSpecialtyMinutesPerUnit),
			wovensUnitsPerHour: readPositive('fin.wovensUnitsPerHour', current.finishing.wovensUnitsPerHour)
		}
	};
}

function readEmbroideryPlan(
	data: FormData,
	prefix: string,
	current: { setupBoxingDivisor: number; hoopingFactor: number; loadUnloadFactor: number; cleanupFactor: number; sewRateDivisor: number },
	readPositive: (name: string, fallback: number, allowZero?: boolean) => number
) {
	return {
		setupBoxingDivisor: readPositive(`${prefix}.setupBoxingDivisor`, current.setupBoxingDivisor),
		hoopingFactor: readPositive(`${prefix}.hoopingFactor`, current.hoopingFactor, true),
		loadUnloadFactor: readPositive(`${prefix}.loadUnloadFactor`, current.loadUnloadFactor, true),
		cleanupFactor: readPositive(`${prefix}.cleanupFactor`, current.cleanupFactor, true),
		sewRateDivisor: readPositive(`${prefix}.sewRateDivisor`, current.sewRateDivisor)
	};
}

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
