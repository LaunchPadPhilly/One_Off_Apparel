import { prisma } from '$lib/server/prisma';
import { buildBoardData } from './boardData';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import { CommitScheduleError } from './commitSchedule';
import { findDraftProblems, problemContextFromBoard, type DraftProblem, type ProblemPlacement } from '$lib/schedule/draftProblems';

/**
 * Server side of the draft problem check ($lib/schedule/draftProblems.ts, 2026-10-16):
 * the same checker the board runs in the browser, fed from the same board data
 * (buildBoardData), so the Approve gate, Claude's draft tools and the board's
 * highlights always agree.
 */

/** @param db - `prisma`, or the transaction an edit is running in (to check it before it's saved). */
export async function loadDraftProblems(draftId: string, db: Prisma.TransactionClient = prisma): Promise<DraftProblem[]> {
	const draft = await db.scheduleDraft.findUnique({ where: { id: draftId } });
	if (!draft) return [];
	const board = await buildBoardData({ kind: 'draft', draft }, db);
	const placements: ProblemPlacement[] = board.assignments.map((a) => ({
		id: a.id,
		lineItemId: a.lineItemId,
		orderId: a.orderId,
		date: a.date,
		stationName: a.stationName,
		startMin: a.startMinuteOfDay,
		durationMin: Math.max(15, Math.round(a.estimatedHours * 60)),
		status: a.status,
		crew: a.crew.map((m) => ({ id: m.id, name: m.name, role: m.role })),
		noLead: a.noLead
	}));
	return findDraftProblems(problemContextFromBoard(board, placements));
}

function refusal(blocking: DraftProblem[]): string {
	const shown = blocking.slice(0, 5).map((p) => `• ${p.message}`);
	const more = blocking.length > 5 ? `\n…and ${blocking.length - 5} more.` : '';
	return `This schedule can't be approved yet — ${blocking.length} problem${blocking.length === 1 ? '' : 's'} to fix first (shown in red on the board):\n${shown.join('\n')}${more}`;
}

/**
 * The approval gate's feasibility half: refuses (CommitScheduleError) while the draft
 * has a red problem touching a proposed job. `assignmentIds` narrows it to the jobs
 * being approved (commit_schedule with assignmentIds).
 */
export async function assertDraftApprovable(draftId: string, assignmentIds?: readonly string[]): Promise<void> {
	const problems = await loadDraftProblems(draftId);
	const only = assignmentIds ? new Set(assignmentIds) : null;
	const blocking = problems.filter((p) => p.blocking && (!only || p.placementIds.some((id) => only.has(id))));
	if (blocking.length) throw new CommitScheduleError(refusal(blocking));
}

/** assertDraftApprovable for a hand-picked set of assignments, across whatever drafts they're in. */
export async function assertAssignmentsApprovable(assignmentIds: readonly string[]): Promise<void> {
	const rows = await prisma.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } }, select: { scheduleDraftId: true } });
	const draftIds = [...new Set(rows.map((r) => r.scheduleDraftId).filter((id): id is string => id !== null))];
	for (const draftId of draftIds) await assertDraftApprovable(draftId, assignmentIds);
}
