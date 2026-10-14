/**
 * Read-side helper for the `list_stations` MCP tool (mcp/tools.ts). Diagnostic: lets
 * Claude in chat read every station's label AND its underlying `kind` — the two values
 * that must match a line item's expectedStationFor() for a drag or a move_assignment to
 * succeed. The admin board shows the label, but a kind-mismatch bug (a legacy station
 * whose kind doesn't match any STATION_KINDS entry, or an admin that picked the wrong
 * kind for a new station) is only visible in the kind field itself.
 *
 * Also marks any station whose kind isn't a known STATION_KINDS value — a strong signal
 * the station was created before the admin UI existed (the 2026-09-25 migration
 * backfilled `kind = name` for pre-existing rows, so a legacy `screen_print_manual`
 * station still has an unrecognized kind today) and that move_assignment will refuse
 * every job on it.
 */
import { prisma } from '$lib/server/prisma';
import { isStationKind, stationKindLabel } from '$lib/schedule/stationKinds';

export interface StationSummary {
	id: string;
	name: string;
	label: string;
	kind: string;
	kindLabel: string;
	kindIsRecognized: boolean;
	category: 'production' | 'finishing' | 'unknown';
	autoSchedule: boolean;
	archived: boolean;
	sortOrder: number;
}

export interface ListStationsResult {
	stations: StationSummary[];
	/** True when any active station has a kind not in STATION_KINDS — a real misconfig. */
	hasUnrecognizedKinds: boolean;
}

export async function listStationsForTool(includeArchived = false): Promise<ListStationsResult> {
	const rows = await prisma.station.findMany({
		where: includeArchived ? {} : { archivedAt: null },
		orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
		select: { id: true, name: true, label: true, kind: true, autoSchedule: true, archivedAt: true, sortOrder: true }
	});
	const stations = rows.map((r): StationSummary => {
		const recognized = isStationKind(r.kind);
		return {
			id: r.id,
			name: r.name,
			label: r.label,
			kind: r.kind,
			kindLabel: stationKindLabel(r.kind),
			kindIsRecognized: recognized,
			category: recognized ? categoryOf(r.kind) : 'unknown',
			autoSchedule: r.autoSchedule,
			archived: r.archivedAt !== null,
			sortOrder: r.sortOrder
		};
	});
	const hasUnrecognizedKinds = stations.some((s) => !s.archived && !s.kindIsRecognized);
	return { stations, hasUnrecognizedKinds };
}

function categoryOf(kind: string): 'production' | 'finishing' | 'unknown' {
	// Local-only; stationKinds exposes isFinishingKind but not category directly.
	if (['screen_print_auto', 'embroidery', 'dtf', 'dtg', 'other'].includes(kind)) return 'production';
	if (['matte_finish', 'fold_bag', 'hang_tags', 'printed_relabel', 'wovens'].includes(kind)) return 'finishing';
	return 'unknown';
}
