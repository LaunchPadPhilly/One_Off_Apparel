/**
 * Shared implementation of "move one proposed assignment inside a draft" used by both
 * the board's `moveAssignment` form action (routes/schedule/drafts/[id]/+page.server.ts)
 * and the `move_assignment` MCP tool (lib/server/mcp/tools.ts). Keeping the two callers
 * on one function means Claude's move and a drag-and-drop move go through the exact same
 * validation and cascade — a station a drag refuses, the chat refuses too, with the same
 * message.
 *
 * Only PROPOSED rows inside the named draft can be moved. Row-kind mismatch, finisher
 * dependency breaks, archived-station targets and shift-overflow all surface as
 * MoveDraftAssignmentError with a human-readable message — the UI shows it as a
 * refusal toast; the MCP tool returns it to Claude as the handler's thrown error.
 */
import { prisma } from '$lib/server/prisma';
import { expectedStationFor, stationDisplayLabel } from '$lib/schedule/expectedStation';
import { isWeekendDate } from '$lib/schedule/weekends';
import { checkFinisherPlacement, DraftPlacementError, repackDraftDays } from './draftDependencies';
import { ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { PlacementPosition } from './draftDependencies';

/**
 * Any refusal the mover surfaces to a caller — distinct from an unexpected programming
 * error so the form action and the MCP tool can translate it into a user-facing message
 * instead of a 500. One class so both callers handle it the same way.
 */
export class MoveDraftAssignmentError extends Error {
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
	actor: string
): Promise<MoveDraftAssignmentResult> {
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
	if (isWeekendDate(date)) {
		throw new MoveDraftAssignmentError("The shop doesn't operate on Saturday or Sunday — pick a weekday.");
	}
	const durationMin = Math.max(15, Math.round(existing.estimatedHours * 60));

	const dependencyProblem = await checkFinisherPlacement(
		prisma,
		input.draftId,
		existing.lineItemId,
		date,
		durationMin
	);
	if (dependencyProblem) throw new MoveDraftAssignmentError(dependencyProblem);

	const targetStartMin = input.startMinuteOfDay ?? existing.startMinuteOfDay ?? 8 * 60;

	try {
		return await prisma.$transaction(async (tx) => {
			await tx.scheduleAssignment.update({
				where: { id: input.assignmentId },
				data: {
					stationId: station.id,
					date,
					startMinuteOfDay: targetStartMin,
					proposedBy: actor
				}
			});

			// Crew was planned for the (station, day) the job left; a cross-slot move
			// drops it so planStaffing re-picks it for the new slot. Same-slot moves keep
			// their crew (matches the form action's behavior).
			const changedSlot =
				existing.stationId !== station.id || existing.date.getTime() !== date.getTime();
			if (changedSlot) {
				await tx.assignmentCrew.deleteMany({ where: { assignmentId: input.assignmentId } });
			}

			const { peers, pushedCount } = await repackDraftDays(tx, input.draftId, {
				kind: 'move',
				assignmentId: input.assignmentId,
				oldStationId: existing.stationId,
				oldDayMs: existing.date.getTime(),
				newStationId: station.id,
				newDayMs: date.getTime(),
				targetStartMin
			});
			return { id: input.assignmentId, peers, pushedCount };
		});
	} catch (err) {
		if (err instanceof DraftPlacementError) throw new MoveDraftAssignmentError(err.message);
		throw err;
	}
}
