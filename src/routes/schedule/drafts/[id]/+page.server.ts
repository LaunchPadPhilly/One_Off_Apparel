import { error, fail, redirect } from '@sveltejs/kit';
import { requireScopePage } from '$lib/server/auth/guards';
import { deleteDraft, getDraft } from '$lib/server/schedule/draft';
import { commitDraft, CommitScheduleError } from '$lib/server/schedule/commitSchedule';
import { checkFinisherPlacement, repackDraftDays } from '$lib/server/schedule/draftDependencies';
import { prisma } from '$lib/server/prisma';
import { estimateForDisplay } from '$lib/server/engine/estimateForDisplay';
import { computeOrderGaps } from '$lib/server/hoops/orderGaps';
import { DEFAULT_STATION_DAY_HOURS } from '$lib/schedule/defaultCapacity';
import { expectedStationFor, stationDisplayLabel } from '$lib/schedule/expectedStation';
import {
	OrderStatus,
	ScheduleAssignmentStatus
} from '../../../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

function iso(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function groupNamesByDate(rows: readonly { date: Date; worker: { name: string } }[]): Record<string, string[]> {
	const byDate: Record<string, string[]> = {};
	for (const row of rows) (byDate[iso(row.date)] ??= []).push(row.worker.name);
	for (const names of Object.values(byDate)) names.sort();
	return byDate;
}

function addDays(iso: string, days: number): Date {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d;
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
 * The draft detail view carries the sidebar (candidate orders + line items with
 * estimated hours) and the day-by-day timeline. Placements are ScheduleAssignment
 * rows scoped to this draft (nullable FK — legacy rows and committed rows still
 * exist without one) and are read/written directly here.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);
	const draft = await getDraft(params.id);
	if (!draft) throw error(404, 'Schedule draft not found');

	const startIso = iso(draft.startDate);
	const endDate = addDays(startIso, draft.weeks * 7 - 1);
	const endIso = iso(endDate);

	// One-time feedback from "Create automatic schedule" (see proposeIntoNewDraft.ts /
	// the ?placed=&atRisk= redirect on /schedule) — not stored anywhere, just read off
	// the URL for this one page view so a brand-new, possibly-empty-looking draft
	// explains itself instead of silently showing nothing.
	const autoProposeFeedback = url.searchParams.has('placed')
		? { placed: Number(url.searchParams.get('placed')), atRisk: Number(url.searchParams.get('atRisk')) }
		: null;

	const [orders, stations, capacityRows, assignments] = await Promise.all([
		// CONFIRMED only — a NEEDS_REVIEW order hasn't passed CLAUDE.md's first human
		// approval gate (import confirmation) yet, so it has no business being placeable
		// here even manually. This intentionally does NOT also require the stricter
		// fetchBacklog() gates (blanks received, customer approval) —
		// those are enforced for the *automatic* engine path (proposeIntoNewDraft.ts);
		// a human manually planning ahead can still place a confirmed order before every
		// pre-production gate is finalized. ALSO excludes an order whose due date has
		// already passed (2026-09-22 decision) — it shouldn't even be offered as a
		// candidate here, not just left unplaced by the automatic engine; see
		// placeAssignment below for the matching server-side write-path check.
		prisma.order.findMany({
			where: { status: OrderStatus.CONFIRMED, deadline: { gte: startOfToday() } },
			include: { lineItems: { orderBy: { id: 'asc' } } },
			orderBy: [{ deadline: 'asc' }, { createdAt: 'desc' }]
		}),
		prisma.station.findMany({
			where: { archivedAt: null },
			orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
			select: { id: true, name: true, label: true, kind: true, autoSchedule: true }
		}),
		prisma.capacityCalendar.findMany({
			where: { date: { gte: draft.startDate, lte: endDate } }
		}),
		prisma.scheduleAssignment.findMany({
			where: { scheduleDraftId: draft.id },
			include: {
				lineItem: { select: { id: true, orderId: true } },
				station: { select: { id: true, name: true } },
				// The day's crew on this job (planStaffing.ts, 2026-09-28).
				crew: { select: { worker: { select: { name: true } } } }
			},
			orderBy: [{ date: 'asc' }, { startMinuteOfDay: 'asc' }, { sequenceOrder: 'asc' }]
		})
	]);
	const unavailability = await prisma.workerUnavailability.findMany({
		where: { date: { gte: draft.startDate, lte: endDate }, worker: { archivedAt: null } },
		select: { date: true, worker: { select: { name: true } } }
	});

	// One entry per (station, day) in the window; falls back to the default day
	// length when the capacity_calendar has no row for that pair. That keeps the
	// timeline usable before capacity_calendar has been seeded for a shop.
	const days: string[] = [];
	for (let i = 0; i < draft.weeks * 7; i++) {
		days.push(iso(addDays(startIso, i)));
	}
	// Row order is the admin's (sortOrder, then label). No fallback list any more —
	// the migration seeds the original stations, and an empty list means an admin
	// archived them all.
	const stationNames = stations.map((station) => station.name);
	const capacityMap = new Map<string, number>();
	for (const row of capacityRows) {
		capacityMap.set(`${row.stationId}:${iso(row.date)}`, row.availableHrs);
	}
	const stationIdByName = new Map(stations.map((station) => [station.name, station.id]));

	const capacity = days.map((day) => ({
		date: day,
		stations: stationNames.map((name) => {
			const stationId = stationIdByName.get(name);
			const hrs = stationId ? capacityMap.get(`${stationId}:${day}`) : undefined;
			return {
				name,
				availableHrs: hrs ?? DEFAULT_STATION_DAY_HOURS
			};
		})
	}));

	return {
		autoProposeFeedback,
		draft: {
			id: draft.id,
			name: draft.name,
			description: draft.description,
			startDate: startIso,
			endDate: endIso,
			weeks: draft.weeks,
			strategy: draft.strategy,
			status: draft.status,
			createdBy: draft.createdBy,
			createdAt: draft.createdAt.toISOString()
		},
		orders: orders.map((order) => ({
			id: order.id,
			hoopsOrderId: order.hoopsOrderId,
			customerName: order.customerName,
			displayTitle: order.displayTitle,
			colorHex: order.colorHex,
			// Never null: the candidate query's deadline filter excludes orders with no date.
			deadline: iso(order.deadline!),
			deadlineIsTight: order.deadlineIsTight,
			status: order.status,
			// Open items (orderGaps.ts) — a confirmed order with any is flagged "Needs
			// re-review" on its card, linking to the order page to fix it.
			blockingCount: computeOrderGaps(
				{ deadline: order.deadline, blankOrderingStatus: order.blankOrderingStatus, customerApprovalStatus: order.customerApprovalStatus, importFlags: [] },
				order.lineItems
			).blockingCount,
			lineItems: order.lineItems.map((item) => ({
				id: item.id,
				design: item.design,
				itemType: item.itemType,
				decorationType: item.decorationType,
				// For the weekly screen count.
				screens: item.screens,
				finishingStep: item.finishingStep,
				printLocation: item.printLocation,
				// OTHER rows (2026-09-28): the export's name for the job, e.g. "Patch Install".
				otherJobType: item.otherJobType,
				inkColorCount: item.inkColorCount,
				// The colors going on the piece (2026-09-28) — shown on cards and hover details.
				decorationColors: item.decorationColors,
				quantity: item.quantity,
				status: item.status,
				// For the timeline's "waits on …" tooltip on finisher blocks.
				dependsOn: item.dependsOn,
				// The live estimate (same estimateForDisplay() the Orders page already uses),
				// not the dormant LineItem.estimatedHours column this used to read — that
				// column is never written to (see CLAUDE.md), so hours and "why can't this be
				// placed" never actually showed here before this fix; they just silently
				// always came back null.
				estimate: estimateForDisplay(item)
			}))
		})),
		assignments: assignments.map((a) => ({
			id: a.id,
			lineItemId: a.lineItemId,
			orderId: a.lineItem.orderId,
			stationName: a.station.name,
			date: iso(a.date),
			startMinuteOfDay: a.startMinuteOfDay ?? 8 * 60,
			estimatedHours: a.estimatedHours,
			status: a.status,
			crew: a.crew.map((member) => member.worker.name).sort()
		})),
		stationNames,
		// name → display label / formula kind, for the board's row labels, the
		// finishing-group split and the drop restriction.
		stations: stations.map((station) => ({ name: station.name, label: station.label, kind: station.kind, autoSchedule: station.autoSchedule })),
		capacity,
		defaultStationDayHours: DEFAULT_STATION_DAY_HOURS,
		// Who's out each day of the draft (set through Claude, 2026-09-28): date → names.
		outByDate: groupNamesByDate(unavailability)
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
		const result = await prisma.$transaction(async (tx) => {
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
		return { success: true as const, id: result.id, peers: result.peers, pushedCount: result.pushedCount };
	},

	moveAssignment: async ({ request, params, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const id = form.get('id');
		const stationName = form.get('stationName');
		const date = toDate(form.get('date'));
		const startMinuteOfDay = parseInt10(form.get('startMinuteOfDay'));

		if (typeof id !== 'string' || !id) return fail(400, { message: 'id required' });
		if (typeof stationName !== 'string' || !stationName) return fail(400, { message: 'stationName required' });
		if (!date) return fail(400, { message: 'date required (YYYY-MM-DD)' });
		if (startMinuteOfDay === null) return fail(400, { message: 'startMinuteOfDay required' });

		// Belongs-to-this-draft check: prevent a client from re-parenting an
		// assignment from a different draft (or a committed one) through this
		// endpoint. A stronger authz check comes with the committed vs draft
		// separation, but this covers the current UI.
		const existing = await prisma.scheduleAssignment.findUnique({
			where: { id },
			select: {
				scheduleDraftId: true,
				status: true,
				stationId: true,
				date: true,
				lineItemId: true,
				estimatedHours: true,
				lineItem: {
					select: { itemType: true, decorationType: true, finishingStep: true, assignedStationId: true }
				}
			}
		});
		if (!existing || existing.scheduleDraftId !== params.id)
			return fail(404, { message: 'Assignment not in this draft' });
		// An approved job is on the live schedule; changing it here would skip the
		// approval gate. Changes go through a new proposed plan instead.
		if (existing.status !== ScheduleAssignmentStatus.PROPOSED)
			return fail(409, { message: 'This job is already approved, so it can’t be changed here. Propose a new plan to move it.' });

		const station = await findActiveStation(stationName);
		if (!station) return fail(400, { message: 'That station no longer exists (it may have been archived in Settings → Stations). Reload the board.' });

		// Row restriction on move — same rule as placeAssignment above. Prevents a
		// placed embroidery block from being dragged onto a finishing row (or vice
		// versa) via a hand-crafted POST.
		const mismatch = stationMismatchMessage(existing.lineItem, station);
		if (mismatch) return fail(400, { message: mismatch });

		const dependencyProblem = await checkFinisherPlacement(prisma, params.id, existing.lineItemId, date, Math.max(15, Math.round(existing.estimatedHours * 60)));
		if (dependencyProblem) return fail(400, { message: dependencyProblem });

		const result = await prisma.$transaction(async (tx) => {
			// Persist the caller's intent (station/date/startMin). The cascade helper
			// re-applies gap-preserving math server-authoritatively and rewrites this
			// row plus any peers it shifts (see draftDependencies.ts).
			await tx.scheduleAssignment.update({
				where: { id },
				data: {
					stationId: station.id,
					date,
					startMinuteOfDay: startMinuteOfDay,
					proposedBy: user.email
				}
			});

			// The planned crew was for the (station, day) it left (2026-09-28).
			const changedSlot =
				existing.stationId !== station.id || existing.date.getTime() !== date.getTime();
			if (changedSlot) await tx.assignmentCrew.deleteMany({ where: { assignmentId: id } });
			return repackDraftDays(tx, params.id, {
				kind: 'move',
				assignmentId: id,
				oldStationId: existing.stationId,
				oldDayMs: existing.date.getTime(),
				newStationId: station.id,
				newDayMs: date.getTime(),
				targetStartMin: startMinuteOfDay
			});
		});

		return { success: true as const, peers: result.peers, pushedCount: result.pushedCount };
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

		const result = await prisma.$transaction(async (tx) => {
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
		return { success: true as const, peers: result.peers, pushedCount: result.pushedCount };
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
