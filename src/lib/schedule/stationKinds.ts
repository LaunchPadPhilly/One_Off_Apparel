/**
 * The fixed catalog of station *kinds* — which estimate_hours formula a station runs
 * (2026-09-25, config settings). Admins create, rename and archive the stations
 * themselves (e.g. two "Screen Print Auto" presses and one "Screen Print Manual"), but
 * every station must be one of these kinds, because each kind maps to real formula
 * code in estimateHours.ts. Adding a kind is a code change, not a settings change.
 *
 * `key` is the value estimateHours() returns as `station` and expectedStationFor()
 * returns — historically the one-and-only station's `name`, which is why the screen
 * print key still reads "screen_print_auto" even though a manual press shares it (same
 * time assumption per the client, 2026-09-25). `Station.kind` stores this key;
 * `Station.name` is now only a unique internal identifier and `Station.label` is what
 * people see.
 *
 * `category` decides where the draft board draws the station: production rows on top,
 * finishing rows under the collapsible "Finishing" group.
 */
export const STATION_KINDS = [
	{ key: 'screen_print_auto', label: 'Screen print', category: 'production' },
	{ key: 'embroidery', label: 'Embroidery', category: 'production' },
	{ key: 'dtf', label: 'DTF', category: 'production' },
	{ key: 'dtg', label: 'DTG', category: 'production' },
	{ key: 'matte_finish', label: 'Matte finish', category: 'finishing' },
	{ key: 'fold_bag', label: 'Fold & bag', category: 'finishing' },
	{ key: 'hang_tags', label: 'Hang tags', category: 'finishing' },
	{ key: 'printed_relabel', label: 'Printed relabel', category: 'finishing' },
	{ key: 'wovens', label: 'Wovens', category: 'finishing' },
	// 2026-09-28: for jobs the system doesn't model yet (e.g. a patch press). An OTHER
	// line item is placed only on the station a reviewer assigned it to, with
	// reviewer-entered hours — see estimateHours.ts's estimateOtherHours.
	{ key: 'other', label: 'Other (hours entered per job)', category: 'production' }
] as const;

export type StationKind = (typeof STATION_KINDS)[number]['key'];

const byKey = new Map<string, (typeof STATION_KINDS)[number]>(STATION_KINDS.map((kind) => [kind.key, kind]));

export function isStationKind(value: unknown): value is StationKind {
	return typeof value === 'string' && byKey.has(value);
}

export function isFinishingKind(kind: string | null | undefined): boolean {
	return kind ? byKey.get(kind)?.category === 'finishing' : false;
}

/** A human label for a kind key; falls back to title-casing an unknown key. */
export function stationKindLabel(kind: string): string {
	return byKey.get(kind)?.label ?? kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
