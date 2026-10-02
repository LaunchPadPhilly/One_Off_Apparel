import { prisma } from '$lib/server/prisma';
import type { CapConstruction, FoldBagGarment, WeightClass } from '../../../../prisma/generated/prisma/enums';

/**
 * Editable formula constants for estimate_hours (2026-09-28). The pure engine
 * (`estimateHours.ts`) reads its per-station rates and factors from `currentFormulas()`
 * instead of hardcoded consts, so an admin can shave 15 minutes off a step in Settings
 * → Formulas without a code change.
 *
 * Contract from CLAUDE.md's config-settings roadmap:
 *   "Already-approved assignments keep the hours they were approved with; only new plans
 *    use new numbers."
 * That's enforced structurally: ScheduleAssignment.estimatedHours is stored at placement
 * time and never recomputed. Every live-computed estimate (orderGaps, estimateForDisplay,
 * proposeSchedule) reads the CURRENT formulas each time, so a change here shows up on
 * the Orders page and the drafts board on the next page load.
 *
 * Storage: one singleton FormulaSettings row (id="current") holds a JSON blob of
 * overrides; anything not overridden falls back to DEFAULT_FORMULAS below. An empty row
 * (or none at all) means "use every default" — no seeding required. See the model
 * comment in prisma/schema.prisma.
 *
 * Multi-instance caveat: this module caches the current formulas in memory, refreshed
 * on startup and after every save. In a multi-container ECS setup, other containers
 * won't see a save immediately — they'll pick it up on their next TTL refresh (or the
 * next deploy). Formula changes are rare enough that a ~30-second window is acceptable.
 */

interface EmbroideryRatePlan {
	setupBoxingDivisor: number;
	hoopingFactor: number;
	loadUnloadFactor: number;
	cleanupFactor: number;
	sewRateDivisor: number;
}

export interface FormulaSettings {
	screenPrint: {
		initialUnits: Record<WeightClass, number>;
		// The rate table is keyed on a two-regime bucket (fewer than 5 screens vs 5+).
		// Two very different sets of numbers; not a single knob.
		ratePerHour: {
			SCREENS_LT_5: Record<WeightClass, number>;
			SCREENS_GT_4: Record<WeightClass, number>;
		};
		setupMinutesPerScreen: number;
		setupMinutesPerInkColor: number;
		setupFixedMinutes: number;
	};
	embroidery: {
		threadChangeMinPerColor: number;
		flat: Record<WeightClass, EmbroideryRatePlan>;
		cap: Record<CapConstruction, EmbroideryRatePlan>;
	};
	finishing: {
		relabelUnitsPerHour: Record<WeightClass, number>;
		hangTagUnitsPerHour: Record<WeightClass, number>;
		foldBagUnitsPerHour: Record<FoldBagGarment, number>;
		matteFlatMinutesNumerator: number;
		matteFlatRate: Record<WeightClass, number>;
		matteSpecialtyMinutesPerUnit: number;
		wovensUnitsPerHour: number;
	};
}

/**
 * Built-in defaults — every one of these comes from the client's "Consolidated IT"
 * spreadsheet (see estimateHours.ts's per-function doc for citations by tab). This is
 * what every install ships with; only an admin edit in Settings changes them.
 */
export const DEFAULT_FORMULAS: FormulaSettings = {
	screenPrint: {
		initialUnits: { THIN: 100, POLY: 80, BULKY: 50 },
		ratePerHour: {
			SCREENS_LT_5: { THIN: 360, POLY: 288, BULKY: 180 },
			SCREENS_GT_4: { THIN: 180, POLY: 144, BULKY: 90 }
		},
		setupMinutesPerScreen: 5,
		setupMinutesPerInkColor: 15,
		// Two fixed 30-minute chunks in the client's table (60 min total). Kept as one
		// knob here since the spreadsheet doesn't distinguish them.
		setupFixedMinutes: 60
	},
	embroidery: {
		threadChangeMinPerColor: 5,
		flat: {
			THIN: { setupBoxingDivisor: 240, hoopingFactor: 1.5, loadUnloadFactor: 2, cleanupFactor: 4, sewRateDivisor: 850 },
			POLY: { setupBoxingDivisor: 180, hoopingFactor: 2, loadUnloadFactor: 2, cleanupFactor: 6, sewRateDivisor: 850 },
			BULKY: { setupBoxingDivisor: 120, hoopingFactor: 1.5, loadUnloadFactor: 2, cleanupFactor: 4, sewRateDivisor: 850 }
		},
		cap: {
			STRUCTURED: { setupBoxingDivisor: 240, hoopingFactor: 1, loadUnloadFactor: 1, cleanupFactor: 1.5, sewRateDivisor: 650 },
			UNSTRUCTURED: { setupBoxingDivisor: 240, hoopingFactor: 2.5, loadUnloadFactor: 1, cleanupFactor: 1.5, sewRateDivisor: 650 }
		}
	},
	finishing: {
		relabelUnitsPerHour: { THIN: 144, POLY: 144, BULKY: 72 },
		hangTagUnitsPerHour: { THIN: 300, POLY: 300, BULKY: 150 },
		foldBagUnitsPerHour: { SS_TEE: 300, OTHER: 100 },
		matteFlatMinutesNumerator: 70,
		matteFlatRate: { THIN: 200, POLY: 200, BULKY: 100 },
		matteSpecialtyMinutesPerUnit: 1,
		// Provisional — the client's Wovens chart is not final. See CLAUDE.md's Known
		// open items for the "assumed 90 units/hour" note.
		wovensUnitsPerHour: 90
	}
};

// In-memory cache. Populated at startup by initFormulaSettings() and after every save
// by saveFormulas(); every server-side estimate call reads this via currentFormulas().
let CURRENT: FormulaSettings = DEFAULT_FORMULAS;
let lastLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

/**
 * The current effective formulas — DEFAULT_FORMULAS with any per-field overrides from
 * the DB merged on top. Sync accessor; the cache is refreshed by initFormulaSettings()
 * (called from hooks.server.ts on startup) and saveFormulas() (called from the settings
 * admin action). No async / no DB roundtrip on the hot path.
 */
export function currentFormulas(): FormulaSettings {
	return CURRENT;
}

/**
 * Reads the singleton FormulaSettings row from the DB (if any) and updates the
 * in-memory cache. Called eagerly at server startup and after every admin save; also
 * kicked off lazily when a caller notices the cache is older than CACHE_TTL_MS so
 * multi-instance staleness bounded by that TTL.
 */
export async function reloadFormulas(): Promise<void> {
	try {
		const row = await prisma.formulaSettings.findUnique({ where: { id: 'current' } });
		CURRENT = row ? mergeWithDefaults(row.formulas as Partial<FormulaSettings>) : DEFAULT_FORMULAS;
		lastLoadedAt = Date.now();
	} catch {
		// If Prisma isn't reachable (test setup, migration not run yet), keep the last
		// good value — never crash a page load over formula-settings availability.
	}
}

/** Fire-and-forget refresh if the cache is older than the TTL. Never blocks. */
export function maybeRefreshFormulas(): void {
	if (Date.now() - lastLoadedAt > CACHE_TTL_MS) void reloadFormulas();
}

/**
 * Persists a new formulas payload and refreshes the cache. `next` may be a full
 * FormulaSettings or a partial override; anything missing stays at its default. The
 * save writes the merged/canonical object so the DB always contains something
 * validation-ready, not scattered partials.
 */
export async function saveFormulas(next: Partial<FormulaSettings>, actor: string): Promise<FormulaSettings> {
	const merged = mergeWithDefaults(next);
	// Prisma's Json input needs a widened type — `FormulaSettings` (with its typed
	// numeric fields) doesn't satisfy `InputJsonValue`'s string-indexed shape. Cast at
	// the boundary; `mergeWithDefaults` guarantees the payload is a plain JSON object.
	const payload = merged as unknown as import('../../../../prisma/generated/prisma/client').Prisma.InputJsonValue;
	await prisma.formulaSettings.upsert({
		where: { id: 'current' },
		update: { formulas: payload, updatedBy: actor },
		create: { id: 'current', formulas: payload, updatedBy: actor }
	});
	CURRENT = merged;
	lastLoadedAt = Date.now();
	return merged;
}

/**
 * Deep-merges an override object onto DEFAULT_FORMULAS. Any leaf missing from the
 * override falls back to the default; any leaf present overrides. Preserves the strict
 * FormulaSettings shape (no extra keys, no missing keys) so callers can treat every
 * accessor as guaranteed non-undefined.
 */
function mergeWithDefaults(override: Partial<FormulaSettings> | null | undefined): FormulaSettings {
	const src = override ?? {};
	const sp = (src.screenPrint ?? {}) as Partial<FormulaSettings['screenPrint']>;
	const emb = (src.embroidery ?? {}) as Partial<FormulaSettings['embroidery']>;
	const fin = (src.finishing ?? {}) as Partial<FormulaSettings['finishing']>;

	return {
		screenPrint: {
			initialUnits: { ...DEFAULT_FORMULAS.screenPrint.initialUnits, ...(sp.initialUnits ?? {}) },
			ratePerHour: {
				SCREENS_LT_5: { ...DEFAULT_FORMULAS.screenPrint.ratePerHour.SCREENS_LT_5, ...(sp.ratePerHour?.SCREENS_LT_5 ?? {}) },
				SCREENS_GT_4: { ...DEFAULT_FORMULAS.screenPrint.ratePerHour.SCREENS_GT_4, ...(sp.ratePerHour?.SCREENS_GT_4 ?? {}) }
			},
			setupMinutesPerScreen: sp.setupMinutesPerScreen ?? DEFAULT_FORMULAS.screenPrint.setupMinutesPerScreen,
			setupMinutesPerInkColor: sp.setupMinutesPerInkColor ?? DEFAULT_FORMULAS.screenPrint.setupMinutesPerInkColor,
			setupFixedMinutes: sp.setupFixedMinutes ?? DEFAULT_FORMULAS.screenPrint.setupFixedMinutes
		},
		embroidery: {
			threadChangeMinPerColor: emb.threadChangeMinPerColor ?? DEFAULT_FORMULAS.embroidery.threadChangeMinPerColor,
			flat: mergePlanMap(DEFAULT_FORMULAS.embroidery.flat, emb.flat),
			cap: mergePlanMap(DEFAULT_FORMULAS.embroidery.cap, emb.cap)
		},
		finishing: {
			relabelUnitsPerHour: { ...DEFAULT_FORMULAS.finishing.relabelUnitsPerHour, ...(fin.relabelUnitsPerHour ?? {}) },
			hangTagUnitsPerHour: { ...DEFAULT_FORMULAS.finishing.hangTagUnitsPerHour, ...(fin.hangTagUnitsPerHour ?? {}) },
			foldBagUnitsPerHour: { ...DEFAULT_FORMULAS.finishing.foldBagUnitsPerHour, ...(fin.foldBagUnitsPerHour ?? {}) },
			matteFlatMinutesNumerator: fin.matteFlatMinutesNumerator ?? DEFAULT_FORMULAS.finishing.matteFlatMinutesNumerator,
			matteFlatRate: { ...DEFAULT_FORMULAS.finishing.matteFlatRate, ...(fin.matteFlatRate ?? {}) },
			matteSpecialtyMinutesPerUnit: fin.matteSpecialtyMinutesPerUnit ?? DEFAULT_FORMULAS.finishing.matteSpecialtyMinutesPerUnit,
			wovensUnitsPerHour: fin.wovensUnitsPerHour ?? DEFAULT_FORMULAS.finishing.wovensUnitsPerHour
		}
	};
}

function mergePlanMap<K extends string>(base: Record<K, EmbroideryRatePlan>, override: Partial<Record<K, Partial<EmbroideryRatePlan>>> | undefined): Record<K, EmbroideryRatePlan> {
	const out = { ...base };
	if (!override) return out;
	for (const key of Object.keys(base) as K[]) {
		const src = override[key];
		if (src) out[key] = { ...base[key], ...src };
	}
	return out;
}
