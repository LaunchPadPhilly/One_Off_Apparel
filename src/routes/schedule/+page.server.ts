import { fail, redirect } from '@sveltejs/kit';
import { hasGrantedScope, requireScopePage } from '$lib/server/auth/guards';
import { startAssignment } from '$lib/server/schedule/startAssignment';
import { stopAssignment } from '$lib/server/schedule/stopAssignment';
import { deleteDrafts, listDrafts } from '$lib/server/schedule/draft';
import { proposeIntoNewDraft } from '$lib/server/schedule/proposeIntoNewDraft';
import { buildBoardData, liveWindow } from '$lib/server/schedule/boardData';
import type { Actions, PageServerLoad } from './$types';

/**
 * The production board (2026-10-15): the live schedule — every approved, running and
 * finished job in the window, across all drafts — drawn with the same board as a draft
 * (ScheduleBoard.svelte via buildBoardData), finalized and read-only, with Start / Stop
 * on each job. Drafts are listed above it.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);

	const [board, drafts] = await Promise.all([liveWindow().then((window) => buildBoardData({ kind: 'live', ...window })), listDrafts()]);

	return {
		...board,
		autoProposeFeedback: null,
		canRename: false,
		canEdit: hasGrantedScope(locals.user, 'SCHEDULE_WRITE'),
		canCreate: hasGrantedScope(locals.user, 'SCHEDULE_WRITE'),
		drafts: drafts.map((draft) => ({
			id: draft.id,
			name: draft.name,
			startDate: draft.startDate.toISOString().slice(0, 10),
			weeks: draft.weeks,
			strategy: draft.strategy,
			status: draft.status,
			createdBy: draft.createdBy,
			createdAt: draft.createdAt.toISOString()
		}))
	};
};

export const actions: Actions = {
	// NEW: "Create automatic schedule" — a one-click alternative to the manual
	// "Create schedule" flow (/schedule/new). Runs the existing deterministic
	// propose_schedule engine (same one the propose_schedule MCP tool calls) against
	// confirmed, approval-gated orders and lands the result in a brand-new draft, ready
	// to review/edit in the usual drafts workspace. See proposeIntoNewDraft.ts.
	createAutomatic: async ({ locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		let result;
		try {
			result = await proposeIntoNewDraft(user.email);
		} catch (error) {
			return fail(500, { message: (error as Error).message });
		}
		// placed/atRisk are one-time redirect feedback, not persisted anywhere — CLAUDE.md
		// flags propose_schedule's at-risk results as never being durably stored (only a
		// live snapshot is possible today); this just tells the draft page what to show
		// immediately after creation, not a new persistence mechanism for that gap.
		throw redirect(303, `/schedule/drafts/${result.draftId}?placed=${result.placedCount}&atRisk=${result.atRiskCount}`);
	},
	// Bulk delete drafts selected via the checkboxes on the drafts list. Same audit
	// entries and same still-proposed-assignments cleanup as the per-draft delete
	// (see deleteDrafts in $lib/server/schedule/draft.ts) — this is one endpoint over
	// one transaction, not a client-side loop of the per-draft form action, so a
	// partial failure rolls back rather than leaving half the batch deleted.
	deleteDrafts: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const ids = data.getAll('draftId').filter((v): v is string => typeof v === 'string' && v.length > 0);
		if (ids.length === 0) return fail(400, { message: 'Select at least one draft to delete.' });

		let deleted: number;
		try {
			deleted = await deleteDrafts(ids, user.email);
		} catch (error) {
			return fail(500, { message: (error as Error).message });
		}
		return { deleted };
	},
	start: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentId = data.get('assignmentId');
		if (typeof assignmentId !== 'string' || !assignmentId) return fail(400, { message: 'assignmentId is required' });

		try {
			await startAssignment(assignmentId, user.email);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	},
	stop: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();
		const assignmentId = data.get('assignmentId');
		if (typeof assignmentId !== 'string' || !assignmentId) return fail(400, { message: 'assignmentId is required' });

		try {
			await stopAssignment(assignmentId, user.email);
		} catch (error) {
			return fail(400, { message: (error as Error).message });
		}
	}
};
