import { prisma } from '$lib/server/prisma';
import { estimateForDisplay } from '$lib/server/engine/estimateForDisplay';
import { computeOrderGaps } from '$lib/server/hoops/orderGaps';
import { DEFAULT_STATION_DAY_HOURS } from '$lib/schedule/defaultCapacity';
import { pressSafeCrew } from '$lib/schedule/people';
import { isPressKind } from '$lib/schedule/stationKinds';
import { OrderStatus, ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import { problemJobLabel, type ProblemBusyBlock } from '$lib/schedule/draftProblems';

/**
 * Everything the schedule board (routes/schedule/drafts/[id]/ScheduleBoard.svelte) draws,
 * for one of two sources (2026-10-15):
 *
 * - `draft`: one draft's placements plus the confirmed orders that can still be dragged
 *   onto it (the editing board).
 * - `live`: the committed schedule — every APPROVED / IN_PROGRESS / COMPLETE job in the
 *   window, across all drafts. Same board, finalized: nothing to drag, Start/Stop on
 *   each job (the /schedule page).
 *
 * One builder so the approved schedule looks exactly like the draft it came from.
 */

export type BoardSource =
	| { kind: 'draft'; draft: { id: string; name: string; description: string | null; startDate: Date; weeks: number; strategy: string; status: string; createdBy: string; createdAt: Date } }
	| { kind: 'live'; from: Date; weeks: number };

const COMMITTED = [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS, ScheduleAssignmentStatus.COMPLETE];

function iso(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addDays(isoDay: string, days: number): Date {
	const d = new Date(`${isoDay}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d;
}

function groupNamesByDate(rows: readonly { date: Date; worker: { name: string } }[]): Record<string, string[]> {
	const byDate: Record<string, string[]> = {};
	for (const row of rows) (byDate[iso(row.date)] ??= []).push(row.worker.name);
	for (const names of Object.values(byDate)) names.sort();
	return byDate;
}

// Mirrors buildBacklogAndCapacity.ts's own startOfToday() — an order whose due date
// has already passed is excluded from the draft's candidate list the same way it's
// excluded from the automatic engine's backlog (2026-09-22 decision).
function startOfToday(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * @param db - `prisma`, or a transaction client so a check can see edits not committed
 *   yet (draftEdit.ts' dry runs).
 */
export async function buildBoardData(source: BoardSource, db: Prisma.TransactionClient = prisma) {
	const startDate = source.kind === 'draft' ? source.draft.startDate : source.from;
	const weeks = source.kind === 'draft' ? source.draft.weeks : source.weeks;
	const startIso = iso(startDate);
	const endDate = addDays(startIso, weeks * 7 - 1);
	const endIso = iso(endDate);

	const assignmentWhere: Prisma.ScheduleAssignmentWhereInput =
		source.kind === 'draft'
			? { scheduleDraftId: source.draft.id }
			: { status: { in: COMMITTED }, date: { gte: startDate, lte: endDate } };

	const [stations, capacityRows, assignments] = await Promise.all([
		db.station.findMany({
			where: { archivedAt: null },
			orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
			select: { id: true, name: true, label: true, kind: true, autoSchedule: true }
		}),
		db.capacityCalendar.findMany({ where: { date: { gte: startDate, lte: endDate } } }),
		db.scheduleAssignment.findMany({
			where: assignmentWhere,
			include: {
				lineItem: { select: { id: true, orderId: true, status: true } },
				station: { select: { id: true, name: true, kind: true } },
				// The day's crew on this job (planStaffing.ts, 2026-09-28), with each
				// member's role (2026-10-15): MAIN / OPERATOR / CATCH.
				crew: { select: { role: true, worker: { select: { id: true, name: true } } } }
			},
			orderBy: [{ date: 'asc' }, { startMinuteOfDay: 'asc' }, { sequenceOrder: 'asc' }]
		})
	]);

	// Orders: on a draft, the confirmed orders that can still be placed (the tray) —
	// CONFIRMED only, not past due, with at least one job — plus any order already on
	// the board, so a placed job always has its order's name and color. On the live
	// schedule, just the orders on it.
	const placedOrderIds = [...new Set(assignments.map((a) => a.lineItem.orderId))];
	const candidateWhere: Prisma.OrderWhereInput = { status: OrderStatus.CONFIRMED, deadline: { gte: startOfToday() }, lineItems: { some: {} } };
	const orders = await db.order.findMany({
		where: source.kind === 'draft' ? { OR: [candidateWhere, { id: { in: placedOrderIds } }] } : { id: { in: placedOrderIds } },
		include: { lineItems: { orderBy: { id: 'asc' } } },
		orderBy: [{ deadline: 'asc' }, { createdAt: 'desc' }]
	});
	const today = startOfToday();
	const isCandidate = (order: (typeof orders)[number]) =>
		source.kind === 'draft' &&
		order.status === OrderStatus.CONFIRMED &&
		order.deadline !== null &&
		order.deadline >= today &&
		order.lineItems.length > 0;

	// Committed work outside this draft (2026-10-16): it occupies the same stations and
	// people, so the draft's problem check (draftProblems.ts) counts it — overlaps, a
	// person on two stations — and an order's job already approved elsewhere counts as
	// scheduled. In the window, plus anything for the orders on this draft.
	const elsewhereRows =
		source.kind === 'draft'
			? await db.scheduleAssignment.findMany({
					where: {
						status: { in: COMMITTED },
						OR: [{ scheduleDraftId: null }, { scheduleDraftId: { not: source.draft.id } }],
						AND: [{ OR: [{ date: { gte: startDate, lte: endDate } }, { lineItem: { orderId: { in: placedOrderIds } } }] }]
					},
					select: {
						id: true,
						lineItemId: true,
						date: true,
						startMinuteOfDay: true,
						estimatedHours: true,
						station: { select: { name: true } },
						crew: { select: { workerId: true } },
						lineItem: { select: { design: true, decorationType: true, finishingStep: true, otherJobType: true, order: { select: { hoopsOrderId: true } } } }
					}
				})
			: [];
	const elsewhere: ProblemBusyBlock[] = elsewhereRows.map((row) => ({
		id: row.id,
		lineItemId: row.lineItemId,
		date: iso(row.date),
		stationName: row.station.name,
		startMin: row.startMinuteOfDay ?? 8 * 60,
		durationMin: Math.max(15, Math.round(row.estimatedHours * 60)),
		crewIds: row.crew.map((c) => c.workerId),
		label: problemJobLabel(row.lineItem, row.lineItem.order.hoopsOrderId)
	}));

	const [unavailability, workers, pins] = await Promise.all([
		db.workerUnavailability.findMany({
			where: { date: { gte: startDate, lte: endDate }, worker: { archivedAt: null } },
			select: { date: true, reason: true, worker: { select: { id: true, name: true } } }
		}),
		// The People panel (2026-10-14): the active roster with certifications and notes.
		db.worker.findMany({
			where: { archivedAt: null },
			orderBy: { name: 'asc' },
			select: {
				id: true,
				name: true,
				notes: true,
				isMain: true,
				isOperator: true,
				certifications: { where: { station: { archivedAt: null } }, select: { station: { select: { name: true } } } }
			}
		}),
		db.staffingPin.findMany({
			where: { date: { gte: startDate, lte: endDate }, worker: { archivedAt: null } },
			select: { date: true, workerId: true, station: { select: { name: true } } }
		})
	]);

	// One entry per (station, day) in the window; falls back to the default day
	// length when the capacity_calendar has no row for that pair.
	const days: string[] = [];
	for (let i = 0; i < weeks * 7; i++) days.push(iso(addDays(startIso, i)));
	// Row order is the admin's (sortOrder, then label).
	const stationNames = stations.map((station) => station.name);
	const capacityMap = new Map<string, number>();
	for (const row of capacityRows) capacityMap.set(`${row.stationId}:${iso(row.date)}`, row.availableHrs);
	const stationIdByName = new Map(stations.map((station) => [station.name, station.id]));
	const capacity = days.map((day) => ({
		date: day,
		stations: stationNames.map((name) => {
			const stationId = stationIdByName.get(name);
			const hrs = stationId ? capacityMap.get(`${stationId}:${day}`) : undefined;
			return { name, availableHrs: hrs ?? DEFAULT_STATION_DAY_HOURS };
		})
	}));

	return {
		/** `live` = the committed schedule, finalized; `draft` = one draft, editable. */
		mode: source.kind,
		draft:
			source.kind === 'draft'
				? {
						id: source.draft.id,
						name: source.draft.name,
						description: source.draft.description,
						startDate: startIso,
						endDate: endIso,
						weeks,
						strategy: source.draft.strategy,
						status: source.draft.status,
						createdBy: source.draft.createdBy,
						createdAt: source.draft.createdAt.toISOString()
					}
				: { id: 'live', name: 'Live schedule', description: null, startDate: startIso, endDate: endIso, weeks, strategy: '', status: 'LIVE', createdBy: '', createdAt: '' },
		orders: orders.map((order) => ({
			id: order.id,
			hoopsOrderId: order.hoopsOrderId,
			customerName: order.customerName,
			displayTitle: order.displayTitle,
			colorHex: order.colorHex,
			/** Offered in the draft's Orders tray (placeable); the rest are only here for jobs already on the board. */
			candidate: isCandidate(order),
			deadline: order.deadline ? iso(order.deadline) : '',
			deadlineIsTight: order.deadlineIsTight,
			status: order.status,
			// Open items (orderGaps.ts) — a confirmed order with any is flagged "Needs
			// re-review" on its card, linking to the order page to fix it.
			blockingCount: computeOrderGaps(
				{ deadline: order.deadline, blankOrderingStatus: order.blankOrderingStatus, customerApprovalStatus: order.customerApprovalStatus, importFlags: [] },
				order.lineItems
			).blockingCount,
			// Left off the last automatic plan for lack of room (2026-10-13).
			scheduleFlagged: order.scheduleFlagReason !== null,
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
				// An outsourced Patch Install needs no slot (draftProblems.ts).
				outsourced: item.outsourced,
				// The live estimate (estimateForDisplay(), same as the Orders page).
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
			// BLOCKED = a finisher still waiting on its print: it can't be Started yet.
			lineItemStatus: a.lineItem.status,
			draftId: a.scheduleDraftId,
			// Lead (MAIN or OPERATOR) first; a press crew with no lead isn't shown (no
			// catch without a lead) — noLead tells the board to say so instead. Role is
			// carried per crew member so the details popover can show MAIN / OPERATOR /
			// CATCH and the role-switch control knows what's selected.
			crew: pressSafeCrew(
				a.crew.map((member) => ({
					id: member.worker.id,
					name: member.worker.name,
					role: member.role as 'MAIN' | 'OPERATOR' | 'CATCH',
					isMain: member.role === 'MAIN' || member.role === 'OPERATOR'
				})),
				isPressKind(a.station.kind)
			),
			noLead: isPressKind(a.station.kind) && a.crew.length > 0 && !a.crew.some((m) => m.role === 'MAIN' || m.role === 'OPERATOR')
		})),
		stationNames,
		// name → display label / formula kind, for the board's row labels, the
		// finishing-group split and the drop restriction.
		stations: stations.map((station) => ({ name: station.name, label: station.label, kind: station.kind, autoSchedule: station.autoSchedule })),
		capacity,
		defaultStationDayHours: DEFAULT_STATION_DAY_HOURS,
		// Who's out each day (set through Claude, 2026-09-28): date → names.
		outByDate: groupNamesByDate(unavailability),
		// The People panel (2026-10-14): roster, days out and pins in this window, with
		// worker-level press-role flags (2026-10-15) for the role switcher and the
		// "no mains?" warning.
		people: workers.map((w) => ({
			id: w.id,
			name: w.name,
			notes: w.notes,
			isMain: w.isMain,
			isOperator: w.isOperator,
			certifications: w.certifications.map((c) => ({ stationName: c.station.name }))
		})),
		peopleOut: unavailability.map((row) => ({ date: iso(row.date), workerId: row.worker.id, reason: row.reason })),
		pins: pins.map((row) => ({ date: iso(row.date), workerId: row.workerId, stationName: row.station.name })),
		elsewhere
	};
}

export type BoardData = Awaited<ReturnType<typeof buildBoardData>>;

/**
 * The live schedule's window: from today — or earlier, back to the oldest job that's
 * still running or was due to start and hasn't (overdue work stays in view) — for at
 * least 4 weeks and long enough to reach the last approved job, capped at 12 weeks.
 * `later` counts committed jobs past the cap, so the page can say they're not shown.
 */
export async function liveWindow(): Promise<{ from: Date; weeks: number; later: { count: number; firstDate: string | null } }> {
	const today = startOfToday();
	const [unfinished, last] = await Promise.all([
		prisma.scheduleAssignment.aggregate({
			where: { status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] }, date: { lt: today } },
			_min: { date: true }
		}),
		prisma.scheduleAssignment.aggregate({ where: { status: { in: COMMITTED }, date: { gte: today } }, _max: { date: true } })
	]);
	const from = unfinished._min.date && unfinished._min.date < today ? unfinished._min.date : today;
	const lastDate = last._max.date;
	const spanDays = lastDate ? Math.round((lastDate.getTime() - from.getTime()) / 86_400_000) + 1 : 0;
	const weeks = Math.min(12, Math.max(4, Math.ceil(spanDays / 7)));

	const end = new Date(from);
	end.setUTCDate(end.getUTCDate() + weeks * 7 - 1);
	const laterWhere = { status: { in: COMMITTED }, date: { gt: end } };
	const [count, first] = await Promise.all([
		prisma.scheduleAssignment.count({ where: laterWhere }),
		prisma.scheduleAssignment.aggregate({ where: laterWhere, _min: { date: true } })
	]);
	return { from, weeks, later: { count, firstDate: first._min.date ? iso(first._min.date) : null } };
}
