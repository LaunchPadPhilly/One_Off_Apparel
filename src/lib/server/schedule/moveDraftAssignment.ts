/**
 * Shared implementation of "move one proposed assignment inside a draft" used by both
 * the board's `moveAssignment` form action (routes/schedule/drafts/[id]/+page.server.ts)
 * and the `move_assignment` MCP tool (lib/server/mcp/tools.ts). Keeping the two callers
 * on one function means Claude's move and a drag-and-drop move go through the exact same
 * validation and cascade — a station a drag refuses, the chat refuses too, with the same
 * message.
 *
 * Only PROPOSED rows inside the named draft can be moved, and only onto a station of the
 * right kind — those are refused (MoveDraftAssignmentError, a McpUserError so Claude sees
 * the reason). Everything else a move can break — an overlap, running past the end of
 * the shift, a finisher before its print, a late job — is allowed and flagged
 * (draftProblems.ts; client decision 2026-10-16), or, in `makeRoom` mode, the rest of
 * the station gives way (draftDependencies.ts' RepackMode). See draftEdit.ts for dry
 * runs and the "what else moved" list.
 */
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { expectedStationFor, stationDisplayLabel } from '$lib/schedule/expectedStation';
import { dayLabel, clockLabel } from '$lib/schedule/draftProblems';
import { DraftPlacementError, repackDraftDays, type PlacementChange, type RepackMode } from './draftDependencies';
import { restaffDaysJobsMovedTo } from './restaffDraftDay';
import { runDraftEdit, type DraftEditOptions, type DraftEditOutcome } from './draftEdit';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { PlacementPosition } from './draftDependencies';

/**
 * Any refusal the mover surfaces to a caller — distinct from an unexpected programming
 * error so the form action and the MCP tool can translate it into a user-facing message
 * instead of a 500. One class so both callers handle it the same way.
 */
export class MoveDraftAssignmentError extends McpUserError {
	constructor(message: string) {
		super(message);
		this.name = 'MoveDraftAssignmentError';
	}
}

export interface MoveDraftAssignmentInput {
	draftId: string;
	assignmentId: string;
	stationName: string;
	date: string;
	/** Minute-of-day for the new start. When omitted, the assignment's current startMinuteOfDay is kept. */
	startMinuteOfDay?: number;
}

export interface MoveDraftAssignmentResult {
	id: string;
	peers: PlacementPosition[];
	pushedCount: number;
	changes: PlacementChange[];
}

export interface MoveDraftAssignmentOptions extends Partial<DraftEditOptions> {
	mode?: RepackMode;
}

/**
 * Row-restriction: an embroidery item can only land on an embroidery station, a
 * finishing step only on its own kind of finishing station, and so on. Same rule the
 * board's dim-the-wrong-row drag-over guard applies — mirrored here so the MCP tool and
 * a stale browser POST both go through the same check.
 *
 * An OTHER job (a type the system doesn't model yet, e.g. Patch Install) is only allowed
 * on the one station a reviewer assigned it to.
 */
function stationMismatchMessage(
	item: {
		itemType: string;
		assignedStationId: string | null;
		decorationType?: string | null;
		finishingStep?: string | null;
	},
	station: { id: string; label: string; kind: string }
): string | null {
	if (item.itemType === 'OTHER') {
		if (!item.assignedStationId) return 'Assign this job a station on its order page first.';
		return item.assignedStationId === station.id
			? null
			: `This job is assigned to a different station, not ${station.label}. Change it on the order page if that's wrong.`;
	}
	const expected = expectedStationFor(item);
	if (!expected || expected === station.kind) return null;
	return `This job belongs on a ${stationDisplayLabel(expected)} station, not ${station.label} (kind: ${stationDisplayLabel(station.kind)}). If that destination should accept this job, its kind is set wrong — fix it in Settings → Stations (archive + re-create with the correct kind).`;
}

function parseDate(iso: string): Date {
	return new Date(`${iso}T00:00:00Z`);
}

export async function moveDraftAssignment(
	input: MoveDraftAssignmentInput,
	actor: string,
	options: MoveDraftAssignmentOptions = {}
): Promise<DraftEditOutcome<MoveDraftAssignmentResult>> {
	const existing = await prisma.scheduleAssignment.findUnique({
		where: { id: input.assignmentId },
		select: {
			scheduleDraftId: true,
			status: true,
			stationId: true,
			date: true,
			lineItemId: true,
			estimatedHours: true,
			startMinuteOfDay: true,
			lineItem: {
				select: {
					design: true,
					itemType: true,
					decorationType: true,
					finishingStep: true,
					assignedStationId: true
				}
			}
		}
	});

	if (!existing || existing.scheduleDraftId !== input.draftId) {
		throw new MoveDraftAssignmentError('Assignment not in this draft');
	}
	if (existing.status !== ScheduleAssignmentStatus.PROPOSED) {
		throw new MoveDraftAssignmentError(
			"This job is already approved, so it can’t be changed here. Propose a new plan to move it."
		);
	}

	const station = await prisma.station.findFirst({
		where: { name: input.stationName, archivedAt: null },
		select: { id: true, name: true, label: true, kind: true }
	});
	if (!station) {
		throw new MoveDraftAssignmentError(
			'That station no longer exists (it may have been archived in Settings → Stations).'
		);
	}

	const mismatch = stationMismatchMessage(existing.lineItem, station);
	if (mismatch) throw new MoveDraftAssignmentError(mismatch);

	const date = parseDate(input.date);
	if (Number.isNaN(date.getTime())) throw new MoveDraftAssignmentError('Bad date — use YYYY-MM-DD.');
	const targetStartMin = input.startMinuteOfDay ?? existing.startMinuteOfDay ?? 8 * 60;
	const summary = () => `Moved "${existing.lineItem.design || 'a job'}" to ${station.label}, ${dayLabel(input.date)} ${clockLabel(targetStartMin)}`;

	try {
		return await runDraftEdit(input.draftId, actor, summary, { via: options.via ?? 'board', dryRun: options.dryRun, withProblems: options.withProblems }, async (tx) => {
			// The row's station / date / startMinuteOfDay are deliberately NOT updated
			// here (2026-10-15 fix): repackDraftDays loads the draft, applies the move in
			// memory via the cascade helpers, and writes the new position in its final
			// pass (it also restores the old position from the mutation, 2026-10-16).
			// Only `proposedBy` is touched so the record names who moved it.
			await tx.scheduleAssignment.update({
				where: { id: input.assignmentId },
				data: { proposedBy: actor }
			});

			// Crew was planned for the (station, day) the job left; a cross-slot move
			// drops it so planStaffing re-picks it for the new slot. Same-slot moves keep
			// their crew (matches the form action's behavior).
			const changedSlot =
				existing.stationId !== station.id || existing.date.getTime() !== date.getTime();
			if (changedSlot) {
				await tx.assignmentCrew.deleteMany({ where: { assignmentId: input.assignmentId } });
			}

			const { peers, pushedCount, changes } = await repackDraftDays(
				tx,
				input.draftId,
				{
					kind: 'move',
					assignmentId: input.assignmentId,
					oldStationId: existing.stationId,
					oldDayMs: existing.date.getTime(),
					oldStartMin: existing.startMinuteOfDay ?? 8 * 60,
					newStationId: station.id,
					newDayMs: date.getTime(),
					targetStartMin
				},
				options.mode ?? 'flag'
			);
			if (options.mode === 'makeRoom') await restaffDaysJobsMovedTo(tx, input.draftId, changes);
			return { id: input.assignmentId, peers, pushedCount, changes };
		});
	} catch (err) {
		if (err instanceof DraftPlacementError) throw new MoveDraftAssignmentError(err.message);
		throw err;
	}
}
