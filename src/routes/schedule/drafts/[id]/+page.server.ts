import { error, fail } from '@sveltejs/kit';
import { requireScopePage } from '$lib/server/auth/guards';
import { getDraft } from '$lib/server/schedule/draft';
import { checkFinisherPlacement, pushDependentsAfter } from '$lib/server/schedule/draftDependencies';
import { prisma } from '$lib/server/prisma';
import { estimateForDisplay } from '$lib/server/engine/estimateForDisplay';
import { KNOWN_STATIONS, DEFAULT_STATION_DAY_HOURS } from '$lib/schedule/defaultCapacity';
import {
	OrderStatus,
	ScheduleAssignmentStatus
} from '../../../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

function iso(d: Date): string {
	return d.toISOString().slice(0, 10);
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

async function ensureStation(name: string) {
	// Interactive placements can name a station that has no row yet — the
	// activeStation defaults to the first `KNOWN_STATIONS` even when the
	// stations table is empty. Upsert-on-write keeps the drop path working
	// on a fresh database.
	return prisma.station.upsert({
		where: { name },
		create: { name, type: 'production' },
		update: {}
	});
}

async function nextSequenceOrder(
	stationId: string,
	date: Date,
	excludeId?: string
): Promise<number> {
	// sequenceOrder is batch order within one station's day; keep placements
	// densely packed so a later ATCS pass has clean numbers to work with.
	const highest = await prisma.scheduleAssignment.findFirst({
		where: {
			stationId,
			date,
			...(excludeId ? { id: { not: excludeId } } : {})
		},
		orderBy: { sequenceOrder: 'desc' },
		select: { sequenceOrder: true }
	});
	return (highest?.sequenceOrder ?? -1) + 1;
}

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
		// fetchBacklog() gates (blanks received, customer approval, artwork approval) —
		// those are enforced for the *automatic* engine path (proposeIntoNewDraft.ts);
		// a human manually planning ahead can still place a confirmed order before every
		// pre-production gate is finalized. ALSO excludes an order whose due date has
		// already passed (2026-09-22 decision) — it shouldn't even be offered as a
		// candidate here, not just left unplaced by the automatic engine; see
		// placeAssignment below for the matching server-side write-path check.
		prisma.order.findMany({
			where: { status: OrderStatus.CONFIRMED, internalDueDate: { gte: startOfToday() } },
			include: { lineItems: { orderBy: { id: 'asc' } } },
			orderBy: [{ internalDueDate: 'asc' }, { createdAt: 'desc' }]
		}),
		prisma.station.findMany({ orderBy: { name: 'asc' } }),
		prisma.capacityCalendar.findMany({
			where: { date: { gte: draft.startDate, lte: endDate } }
		}),
		prisma.scheduleAssignment.findMany({
			where: { scheduleDraftId: draft.id },
			include: {
				lineItem: { select: { id: true, orderId: true } },
				station: { select: { id: true, name: true } }
			},
			orderBy: [{ date: 'asc' }, { startMinuteOfDay: 'asc' }, { sequenceOrder: 'asc' }]
		})
	]);

	// One entry per (station, day) in the window; falls back to the default day
	// length when the capacity_calendar has no row for that pair. That keeps the
	// timeline usable before capacity_calendar has been seeded for a shop.
	const days: string[] = [];
	for (let i = 0; i < draft.weeks * 7; i++) {
		days.push(iso(addDays(startIso, i)));
	}
	const stationNames = stations.length
		? stations.map((station) => station.name)
		: [...KNOWN_STATIONS];
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
			internalDueDate: iso(order.internalDueDate),
			externalShipDate: iso(order.externalShipDate),
			status: order.status,
			lineItems: order.lineItems.map((item) => ({
				id: item.id,
				design: item.design,
				itemType: item.itemType,
				decorationType: item.decorationType,
				finishingStep: item.finishingStep,
				printLocation: item.printLocation,
				apparelColor: item.apparelColor,
				inkColorCount: item.inkColorCount,
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
			status: a.status
		})),
		stationNames,
		capacity,
		defaultStationDayHours: DEFAULT_STATION_DAY_HOURS
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
		const startMinuteOfDay = parseInt10(form.get('startMinuteOfDay'));
		const hours = parseFloat10(form.get('hours'));

		if (typeof lineItemId !== 'string' || !lineItemId) return fail(400, { message: 'lineItemId required' });
		if (typeof stationName !== 'string' || !stationName) return fail(400, { message: 'stationName required' });
		if (!date) return fail(400, { message: 'date required (YYYY-MM-DD)' });
		if (startMinuteOfDay === null || startMinuteOfDay < 0 || startMinuteOfDay >= 1440)
			return fail(400, { message: 'startMinuteOfDay out of range' });
		if (hours === null || hours <= 0 || hours > 24)
			return fail(400, { message: 'hours out of range' });

		// Server-side enforcement of the same CONFIRMED-only + not-yet-overdue rules the
		// candidate sidebar already filters by (see load() above) — that filter only
		// controls what's shown, not what this endpoint accepts, so a NEEDS_REVIEW
		// order's line item, or one whose due date has already passed, must be rejected
		// here too, not just kept out of the UI's drag source.
		const lineItem = await prisma.lineItem.findUnique({ where: { id: lineItemId }, select: { order: { select: { status: true, internalDueDate: true } } } });
		if (!lineItem) return fail(404, { message: 'Line item not found' });
		if (lineItem.order.status !== OrderStatus.CONFIRMED) {
			return fail(400, { message: `This line item's order is ${lineItem.order.status}, not CONFIRMED — it can't be placed yet.` });
		}
		if (lineItem.order.internalDueDate.getTime() < startOfToday().getTime()) {
			return fail(400, { message: "This order's due date has already passed — it can't be scheduled until the due date is corrected." });
		}

		// A finisher has to start after the job(s) it waits on end — refused, not snapped
		// (2026-09-23 decision). See draftDependencies.ts.
		const dependencyProblem = await checkFinisherPlacement(params.id, lineItemId, date, startMinuteOfDay);
		if (dependencyProblem) return fail(400, { message: dependencyProblem });

		const station = await ensureStation(stationName);
		const sequenceOrder = await nextSequenceOrder(station.id, date);

		const created = await prisma.scheduleAssignment.create({
			data: {
				lineItemId,
				stationId: station.id,
				date,
				sequenceOrder,
				startMinuteOfDay,
				estimatedHours: hours,
				status: ScheduleAssignmentStatus.PROPOSED,
				proposedBy: user.email,
				scheduleDraftId: params.id
			}
		});
		// Placing a print later than a finisher that's already on the board pushes it.
		const pushed = await pushDependentsAfter(params.id, created.id);
		return { success: true as const, id: created.id, pushed };
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
			select: { scheduleDraftId: true, stationId: true, date: true, lineItemId: true }
		});
		if (!existing || existing.scheduleDraftId !== params.id)
			return fail(404, { message: 'Assignment not in this draft' });

		const dependencyProblem = await checkFinisherPlacement(params.id, existing.lineItemId, date, startMinuteOfDay);
		if (dependencyProblem) return fail(400, { message: dependencyProblem });

		const station = await ensureStation(stationName);
		const movingToNewSlot =
			station.id !== existing.stationId ||
			iso(date) !== iso(existing.date);
		const sequenceOrder = movingToNewSlot
			? await nextSequenceOrder(station.id, date, id)
			: undefined;

		await prisma.scheduleAssignment.update({
			where: { id },
			data: {
				stationId: station.id,
				date,
				startMinuteOfDay,
				...(sequenceOrder !== undefined ? { sequenceOrder } : {}),
				proposedBy: user.email
			}
		});
		// Moving a print later pushes its finishers only as far as needed; moving it
		// earlier leaves them where they are (2026-09-23 decision).
		const pushed = await pushDependentsAfter(params.id, id);
		return { success: true as const, pushed };
	},

	removeAssignment: async ({ request, params, locals, url }) => {
		requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const id = form.get('id');
		if (typeof id !== 'string' || !id) return fail(400, { message: 'id required' });

		// Only allow removal of assignments belonging to this draft.
		const existing = await prisma.scheduleAssignment.findUnique({
			where: { id },
			select: { scheduleDraftId: true }
		});
		if (!existing || existing.scheduleDraftId !== params.id)
			return fail(404, { message: 'Assignment not in this draft' });

		await prisma.scheduleAssignment.delete({ where: { id } });
		return { success: true as const };
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
	}
};
