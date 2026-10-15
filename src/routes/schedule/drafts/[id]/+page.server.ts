import { error, fail, redirect } from '@sveltejs/kit';
import { hasGrantedScope, isAdmin, requireScopePage } from '$lib/server/auth/guards';
import { deleteDraft, getDraft, renameDraft, renameDraftSchema } from '$lib/server/schedule/draft';
import { commitDraft, CommitScheduleError } from '$lib/server/schedule/commitSchedule';
import { checkFinisherPlacement, DraftPlacementError, repackDraftDays } from '$lib/server/schedule/draftDependencies';
import { moveDraftAssignment, MoveDraftAssignmentError } from '$lib/server/schedule/moveDraftAssignment';
import { pinAndRestaffDraftDay, replanDraftCrews, RestaffError } from '$lib/server/schedule/restaffDraftDay';
import { prisma } from '$lib/server/prisma';
import { buildBoardData } from '$lib/server/schedule/boardData';
import { unapproveSchedule, UnapproveScheduleError } from '$lib/server/schedule/unapproveSchedule';
import { estimateForDisplay } from '$lib/server/engine/estimateForDisplay';
import { fetchOrderGaps } from '$lib/server/hoops/orderReadiness';
import { expectedStationFor, stationDisplayLabel } from '$lib/schedule/expectedStation';
import {
	OrderStatus,
	ScheduleAssignmentStatus
} from '../../../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

function iso(d: Date): string {
	return d.toISOString().slice(0, 10);
}

// Mirrors buildBacklogAndCapacity.ts's own startOfToday() — an order whose due date
// has already passed is excluded from this candidate list the same way it's excluded
// from the automatic engine's backlog (2026-09-22 decision): not offered manually
// either, not just left unplaced.
function startOfToday(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Stations are admin-managed (/settings?screen=stations, 2026-09-25): a drop may only
// target an existing, non-archived one. This used to upsert-on-write, which would
// have silently recreated a station an admin archived.
function findActiveStation(name: string) {
	return prisma.station.findFirst({ where: { name, archivedAt: null }, select: { id: true, name: true, label: true, kind: true } });
}

// Same rule the board's drag-over guard applies: a job may only land on a station of
// the kind its type maps to. `expectedStationFor` returns null for an as-yet-
// uncategorized type; we don't restrict those.
// An OTHER job (a type the system doesn't model, e.g. Patch Install — 2026-09-28) may
// only go on the one station a reviewer assigned it to.
function stationMismatchMessage(
	item: Parameters<typeof expectedStationFor>[0] & { assignedStationId: string | null },
	station: { id: string; label: string; kind: string }
): string | null {
	if (item.itemType === 'OTHER') {
		if (!item.assignedStationId) return 'Assign this job a station on its order page first.';
		return item.assignedStationId === station.id ? null : `This job is assigned to a different station, not ${station.label}. Change it on the order page if that's wrong.`;
	}
	const expected = expectedStationFor(item);
	if (!expected || expected === station.kind) return null;
	return `This job belongs on a ${stationDisplayLabel(expected)} station, not ${station.label}.`;
}

/**
 * Server-authoritative gap-preserving cascade + dependency-hold settling lives in
 * $lib/server/schedule/draftDependencies.ts (repackDraftDays). The client applies
 * the same math from $lib/schedule/repackDay.ts optimistically; the server re-runs
 * it inside a transaction so a hand-crafted POST or a client on a stale layout
 * can't slip through, and layers finisher-hold enforcement on top (a print moving
 * later re-settles the finishers waiting on it). Scope stays this draft only —
 * committed rows and other drafts' rows are never touched.
 */

/**
 * The draft detail view: the Orders tray (confirmed orders not yet placed) and the
 * day-by-day timeline of this draft's placements. The shape is shared with the live
 * schedule on /schedule (buildBoardData), so an approved draft and the live schedule
 * look the same.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);
	const draft = await getDraft(params.id);
	if (!draft) throw error(404, 'Schedule draft not found');

	// One-time feedback from "Create automatic schedule" (see proposeIntoNewDraft.ts /
	// the ?placed=&atRisk= redirect on /schedule) — not stored anywhere, just read off
	// the URL for this one page view so a brand-new, possibly-empty-looking draft
	// explains itself instead of silently showing nothing.
	const autoProposeFeedback = url.searchParams.has('placed')
		? { placed: Number(url.searchParams.get('placed')), atRisk: Number(url.searchParams.get('atRisk')) }
		: null;

	return {
		...(await buildBoardData({ kind: 'draft', draft })),
		autoProposeFeedback,
		// Renaming a draft is admin-only (2026-10-13); the action re-checks this.
		canRename: isAdmin(locals.user),
		canEdit: hasGrantedScope(locals.user, 'SCHEDULE_WRITE')
	};
};

// ─── Server actions: place / move / remove / rename ────────────────────────

function parseInt10(value: FormDataEntryValue | null): number | null {
	if (typeof value !== 'string' || !value) return null;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : null;
}

function parseFloat10(value: FormDataEntryValue | null): number | null {
	if (typeof value !== 'string' || !value) return null;
	const n = Number.parseFloat(value);
	return Number.isFinite(n) ? n : null;
}

function toDate(value: FormDataEntryValue | null): Date | null {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const d = new Date(`${value}T00:00:00Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

export const actions: Actions = {
	placeAssignment: async ({ request, params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const lineItemId = form.get('lineItemId');
		const stationName = form.get('stationName');
		const date = toDate(form.get('date'));
		const hours = parseFloat10(form.get('hours'));
		// `startMinuteOfDay` is the exact wall-clock minute the client wants this new
		// item to start at, from the drop position (2026-09-28 rewrite — gap-preserving
		// cascade). Any peer that would be overlapped is pushed later, and every peer
		// behind IT shifts by the same delta so their gaps stay intact.
		const startMinuteOfDay = parseInt10(form.get('startMinuteOfDay'));

		if (typeof lineItemId !== 'string' || !lineItemId) return fail(400, { message: 'lineItemId required' });
		if (typeof stationName !== 'string' || !stationName) return fail(400, { message: 'stationName required' });
		if (!date) return fail(400, { message: 'date required (YYYY-MM-DD)' });
		if (hours === null || hours <= 0 || hours > 24)
			return fail(400, { message: 'hours out of range' });
		if (startMinuteOfDay === null) return fail(400, { message: 'startMinuteOfDay required' });

		// Server-side enforcement of the same CONFIRMED-only + not-yet-overdue rules the
		// candidate sidebar already filters by (see load() above) — that filter only
		// controls what's shown, not what this endpoint accepts, so a NEEDS_REVIEW
		// order's line item, or one whose due date has already passed, must be rejected
		// here too, not just kept out of the UI's drag source.
		const lineItem = await prisma.lineItem.findUnique({
			where: { id: lineItemId },
			select: {
				orderId: true,
				itemType: true,
				assignedStationId: true,
				decorationType: true,
				finishingStep: true,
				order: { select: { status: true, deadline: true } }
			}
		});
		if (!lineItem) return fail(404, { message: 'Line item not found' });
		if (lineItem.order.status !== OrderStatus.CONFIRMED) {
			return fail(400, { message: `This line item's order is ${lineItem.order.status}, not CONFIRMED — it can't be placed yet.` });
		}
		if (!lineItem.order.deadline) {
			return fail(400, { message: "This order has no deadline yet — set it on the order page before scheduling." });
		}
		if (lineItem.order.deadline.getTime() < startOfToday().getTime()) {
			return fail(400, { message: "This order's deadline has already passed — it can't be scheduled until the deadline is corrected." });
		}
		// Same rule the sidebar applies (2026-10-13): an order with open items ("Needs
		// re-review") or a job the engine can't estimate isn't schedulable yet.
		const gaps = (await fetchOrderGaps([lineItem.orderId])).get(lineItem.orderId);
		if (gaps && gaps.blockingCount > 0) {
			return fail(400, { message: 'This order needs re-review — fix its open items on the order page before scheduling it.' });
		}
		const fullItem = await prisma.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
		const itemEstimate = estimateForDisplay(fullItem);
		if (!itemEstimate.ok) {
			return fail(400, { message: `This job can't be scheduled yet: ${itemEstimate.reason}` });
		}

		const station = await findActiveStation(stationName);
		if (!station) return fail(400, { message: 'That station no longer exists (it may have been archived in Settings → Stations). Reload the board.' });

		// Row restriction: an embroidery item can only land on an embroidery station, a
		// finishing step only on its own kind of finishing station, and so on. Same rule
		// the draft-board sidebar and drag-over guard enforce, mirrored here so a stale
		// browser tab or a hand-crafted POST can't slip past it.
		const mismatch = stationMismatchMessage(lineItem, station);
		if (mismatch) return fail(400, { message: mismatch });

		// A finisher has to start after the job(s) it waits on end — refused, not snapped
		// (2026-09-23 decision). See draftDependencies.ts.
		const dependencyProblem = await checkFinisherPlacement(prisma, params.id, lineItemId, date, Math.max(15, Math.round(hours * 60)));
		if (dependencyProblem) return fail(400, { message: dependencyProblem });

		// One transaction so the create + cascade + settle sequence can't leave a
		// half-shifted day if any step fails mid-way through.
		const durationMin = Math.max(15, Math.round(hours * 60));
		// A finisher that can't be settled is refused with a message, nothing saved.
		let result;
		try {
			result = await prisma.$transaction(async (tx) => {
				const created = await tx.scheduleAssignment.create({
					data: {
						lineItemId,
						stationId: station.id,
						date,
						// Rewritten by cascadeInsert inside repackDraftDays; sequenceOrder gets
						// renumbered from the sorted result.
						sequenceOrder: 0,
						startMinuteOfDay: startMinuteOfDay,
						estimatedHours: hours,
						status: ScheduleAssignmentStatus.PROPOSED,
						proposedBy: user.email,
						scheduleDraftId: params.id
					}
				});
				const { peers, pushedCount } = await repackDraftDays(tx, params.id, {
					kind: 'insert',
					assignmentId: created.id,
					stationId: station.id,
					dayMs: date.getTime(),
					targetStartMin: startMinuteOfDay,
					durationMin
				});
				return { id: created.id, peers, pushedCount };
			});
		} catch (err) {
			if (err instanceof DraftPlacementError) return fail(409, { message: err.message });
			throw err;
		}
		return { success: true as const, id: result.id, peers: result.peers, pushedCount: result.pushedCount };
	},

	moveAssignment: async ({ request, params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const id = form.get('id');
		const stationName = form.get('stationName');
		const dateValue = form.get('date');
		const startMinuteOfDay = parseInt10(form.get('startMinuteOfDay'));

		if (typeof id !== 'string' || !id) return fail(400, { message: 'id required' });
		if (typeof stationName !== 'string' || !stationName) return fail(400, { message: 'stationName required' });
		if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue))
			return fail(400, { message: 'date required (YYYY-MM-DD)' });
		if (startMinuteOfDay === null) return fail(400, { message: 'startMinuteOfDay required' });

		try {
			const result = await moveDraftAssignment(
				{
					draftId: params.id,
					assignmentId: id,
					stationName,
					date: dateValue,
					startMinuteOfDay
				},
				user.email
			);
			return { success: true as const, peers: result.peers, pushedCount: result.pushedCount };
		} catch (err) {
			if (err instanceof MoveDraftAssignmentError) {
				// 409 keeps parity with the previous responses for post-check refusals; the
				// shape mismatch messages still go through here too — the client cares about
				// the message, not the status code.
				return fail(409, { message: err.message });
			}
			throw err;
		}
	},

	removeAssignment: async ({ request, params, locals, url }) => {
		requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const id = form.get('id');
		if (typeof id !== 'string' || !id) return fail(400, { message: 'id required' });

		// Only allow removal of assignments belonging to this draft.
		const existing = await prisma.scheduleAssignment.findUnique({
			where: { id },
			select: { scheduleDraftId: true, status: true, stationId: true, date: true }
		});
		if (!existing || existing.scheduleDraftId !== params.id)
			return fail(404, { message: 'Assignment not in this draft' });
		// An approved job is on the live schedule; changing it here would skip the
		// approval gate. Changes go through a new proposed plan instead.
		if (existing.status !== ScheduleAssignmentStatus.PROPOSED)
			return fail(409, { message: 'This job is already approved, so it can’t be changed here. Propose a new plan to move it.' });

		// A finisher that can't be settled is refused with a message, nothing saved.
		let result;
		try {
			result = await prisma.$transaction(async (tx) => {
				const removed = await tx.scheduleAssignment.findUnique({ where: { id }, select: { estimatedHours: true, startMinuteOfDay: true } });
				await tx.scheduleAssignment.delete({ where: { id } });
				return repackDraftDays(tx, params.id, {
					kind: 'remove',
					oldStationId: existing.stationId,
					oldDayMs: existing.date.getTime(),
					removedStartMin: removed?.startMinuteOfDay ?? 0,
					removedDurationMin: Math.max(15, Math.round((removed?.estimatedHours ?? 0) * 60))
				});
			});
		} catch (err) {
			if (err instanceof DraftPlacementError) return fail(409, { message: err.message });
			throw err;
		}
		return { success: true as const, peers: result.peers, pushedCount: result.pushedCount };
	},

	// People panel (2026-10-14): drop a person on a station row to pin them there for
	// that day (no stationName = clear their pin), then re-plan that day's crews for
	// this draft's proposed jobs. See restaffDraftDay.ts.
	pinWorker: async ({ request, params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const workerId = form.get('workerId');
		const date = toDate(form.get('date'));
		const stationName = form.get('stationName');
		if (typeof workerId !== 'string' || !workerId) return fail(400, { message: 'workerId required' });
		if (!date) return fail(400, { message: 'date required (YYYY-MM-DD)' });

		const draft = await getDraft(params.id);
		if (!draft) throw error(404, 'Schedule draft not found');
		let stationId: string | null = null;
		if (typeof stationName === 'string' && stationName) {
			const station = await findActiveStation(stationName);
			if (!station) return fail(400, { message: 'That station no longer exists.' });
			stationId = station.id;
		}
		try {
			const result = await pinAndRestaffDraftDay({ draftId: params.id, workerId, date: iso(date), stationId }, user.email);
			return { success: true as const, peers: result.peers, pushedCount: result.pushedCount, notice: result.notice };
		} catch (err) {
			if (err instanceof RestaffError) return fail(409, { message: err.message });
			throw err;
		}
	},

	// "Re-plan crews" (2026-10-14): re-staff every day with proposed jobs against the
	// current roster, certifications, pins and main/catch rules.
	replanCrews: async ({ params, locals, url }) => {
		requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const draft = await getDraft(params.id);
		if (!draft) throw error(404, 'Schedule draft not found');
		const result = await replanDraftCrews(params.id);
		return { success: true as const, notice: result.notice };
	},

	updateOrderDisplay: async ({ request, locals, url }) => {
		requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const orderId = form.get('orderId');
		const displayTitle = form.get('displayTitle');
		const colorHex = form.get('colorHex');

		if (typeof orderId !== 'string' || !orderId) return fail(400, { message: 'orderId required' });

		const nextTitle =
			typeof displayTitle === 'string' && displayTitle.trim().length > 0
				? displayTitle.trim().slice(0, 200)
				: null;
		const nextColor =
			typeof colorHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(colorHex) ? colorHex : null;

		await prisma.order.update({
			where: { id: orderId },
			data: { displayTitle: nextTitle, colorHex: nextColor }
		});
		return { success: true as const };
	},

	// The second human approval gate, from the board (2026-10-05): approves every
	// proposed job in this draft — the same commitDraft() the commit_schedule MCP tool
	// uses, so moved jobs replace their old slots exactly as they do from chat.
	approveDraft: async ({ params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const draft = await getDraft(params.id);
		if (!draft) throw error(404, 'Schedule draft not found');
		try {
			const result = await commitDraft(params.id, user.email);
			return { approved: true as const, approvedCount: result.assignments.length, replacedCount: result.replacedCount };
		} catch (err) {
			if (err instanceof CommitScheduleError) return fail(409, { message: err.message });
			throw err;
		}
	},

	// "Make changes" on a finalized (approved) draft (2026-10-15): its approved jobs that
	// haven't started go back to proposed, so they can be dragged again and re-approved.
	// Started and finished jobs stay as they are. Same path as the unapprove_schedule
	// MCP tool; the draft returns to DRAFT.
	reopenDraft: async ({ params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const draft = await getDraft(params.id);
		if (!draft) throw error(404, 'Schedule draft not found');
		const approved = await prisma.scheduleAssignment.findMany({
			where: { scheduleDraftId: params.id, status: ScheduleAssignmentStatus.APPROVED },
			select: { id: true }
		});
		if (approved.length === 0) return fail(409, { message: 'Nothing on this schedule can be changed — every job has already started or finished.' });
		try {
			await unapproveSchedule(approved.map((a) => a.id), user.email);
		} catch (err) {
			if (err instanceof UnapproveScheduleError) return fail(409, { message: err.message });
			throw err;
		}
		return { reopened: true as const, reopenedCount: approved.length };
	},

	// Rename a draft — admins only (2026-10-13). Checked here on the server, not just by
	// hiding the button, so a non-admin can't rename by posting the form directly.
	renameDraft: async ({ request, params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		if (!isAdmin(user)) return fail(403, { message: 'Only admins can rename a schedule.' });
		const draft = await getDraft(params.id);
		if (!draft) throw error(404, 'Schedule draft not found');
		const form = await request.formData();
		const parsed = renameDraftSchema.safeParse({ name: form.get('name') });
		if (!parsed.success) return fail(400, { message: parsed.error.issues[0]?.message ?? 'Invalid name' });
		await renameDraft(params.id, parsed.data.name, user.email);
		return { renamed: true as const };
	},

	deleteDraft: async ({ params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const draft = await getDraft(params.id);
		if (!draft) throw error(404, 'Schedule draft not found');
		// Hard delete — the draft's still-proposed assignments go with it; any
		// committed rows (APPROVED / IN_PROGRESS / COMPLETE) survive with a null
		// scheduleDraftId via the FK's onDelete: SetNull. See deleteDraft in
		// $lib/server/schedule/draft.ts for the transaction + audit entry.
		await deleteDraft(params.id, user.email);
		throw redirect(303, '/schedule');
	}
};
