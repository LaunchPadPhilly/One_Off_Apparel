import { prisma } from '$lib/server/prisma';
import { ALL_SIBLINGS_DEPENDENCY } from '$lib/server/engine/types';
import { SHIFT_START_MIN, WORKING_MIN, findNonOverlappingStart, wallClockEnd, workingMinutesUntilShiftEnd } from '$lib/schedule/shift';
import { LineItemStatus, LineItemType } from '../../../../prisma/generated/prisma/enums';

/**
 * Keeps finishers after their prints inside one schedule draft (2026-09-23 decision):
 *
 * - A finisher may start right after every job it depends on ends (no cure/dry
 *   buffer). Dragging or placing it earlier than that is REFUSED, not snapped.
 * - Moving a print later pushes its finishers later only as far as needed to stay
 *   after it; moving a print earlier leaves them where they are. Pushes cascade (a
 *   pushed relabel can in turn push a fold & bag waiting on "all_siblings").
 *
 * "After" is judged on real wall-clock times from the shared shift model
 * ($lib/schedule/shift.ts), the same one the timeline renders, so what the board
 * shows and what's enforced here can't disagree. A dependency that's already
 * COMPLETE imposes no constraint.
 */

interface LineItemNode {
	id: string;
	orderId: string;
	itemType: LineItemType;
	dependsOn: string | null;
	status: LineItemStatus;
	design: string;
}

interface DraftPlacement {
	id: string;
	lineItemId: string;
	stationId: string;
	dayMs: number;
	startMin: number;
	durationMin: number;
}

export interface PushedPlacement {
	id: string;
	date: string;
	startMinuteOfDay: number;
}

// Same duration rule the drafts workspace renders with (+page.svelte's hydration).
function durationMinutes(estimatedHours: number): number {
	return Math.max(15, Math.round(estimatedHours * 60));
}

function iso(dayMs: number): string {
	return new Date(dayMs).toISOString().slice(0, 10);
}

function formatClock(minute: number): string {
	const h24 = Math.floor(minute / 60);
	const m = minute % 60;
	const h12 = ((h24 + 11) % 12) + 1;
	return `${h12}:${String(m).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`;
}

function isBefore(dayA: number, minA: number, dayB: number, minB: number): boolean {
	return dayA !== dayB ? dayA < dayB : minA < minB;
}

async function loadContext(draftId: string, extraLineItemIds: string[] = []) {
	const assignments = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId },
		select: { id: true, lineItemId: true, stationId: true, date: true, startMinuteOfDay: true, estimatedHours: true, lineItem: { select: { orderId: true } } }
	});
	const extra = extraLineItemIds.length
		? await prisma.lineItem.findMany({ where: { id: { in: extraLineItemIds } }, select: { orderId: true } })
		: [];
	const orderIds = [...new Set([...assignments.map((a) => a.lineItem.orderId), ...extra.map((e) => e.orderId)])];
	const lineItems: LineItemNode[] = await prisma.lineItem.findMany({
		where: { orderId: { in: orderIds } },
		select: { id: true, orderId: true, itemType: true, dependsOn: true, status: true, design: true }
	});

	const nodes = new Map(lineItems.map((item) => [item.id, item]));
	const placements: DraftPlacement[] = assignments.map((a) => ({
		id: a.id,
		lineItemId: a.lineItemId,
		stationId: a.stationId,
		dayMs: a.date.getTime(),
		startMin: a.startMinuteOfDay ?? SHIFT_START_MIN,
		durationMin: durationMinutes(a.estimatedHours)
	}));

	function dependenciesOf(item: LineItemNode): LineItemNode[] {
		if (item.itemType !== LineItemType.FINISHING || !item.dependsOn) return [];
		if (item.dependsOn === ALL_SIBLINGS_DEPENDENCY) return lineItems.filter((other) => other.orderId === item.orderId && other.id !== item.id);
		const dep = nodes.get(item.dependsOn);
		return dep ? [dep] : [];
	}

	function dependentsOf(lineItemId: string): LineItemNode[] {
		const item = nodes.get(lineItemId);
		if (!item) return [];
		return lineItems.filter(
			(other) =>
				other.itemType === LineItemType.FINISHING &&
				other.id !== lineItemId &&
				(other.dependsOn === lineItemId || (other.dependsOn === ALL_SIBLINGS_DEPENDENCY && other.orderId === item.orderId))
		);
	}

	return { nodes, placements, dependenciesOf, dependentsOf };
}

type Context = Awaited<ReturnType<typeof loadContext>>;

/** The latest end among `item`'s placed dependencies, or an error when one isn't
 *  placed in this draft (and isn't already complete). */
function earliestAllowedStart(ctx: Context, item: LineItemNode): { dayMs: number; minute: number } | { missing: LineItemNode } | null {
	let earliest: { dayMs: number; minute: number } | null = null;
	for (const dep of ctx.dependenciesOf(item)) {
		if (dep.status === LineItemStatus.COMPLETE) continue;
		const placement = ctx.placements.find((p) => p.lineItemId === dep.id);
		if (!placement) return { missing: dep };
		const end = { dayMs: placement.dayMs, minute: wallClockEnd(placement.startMin, placement.durationMin) };
		if (!earliest || isBefore(earliest.dayMs, earliest.minute, end.dayMs, end.minute)) earliest = end;
	}
	return earliest;
}

/**
 * Returns a human-readable reason to refuse putting `lineItemId` at (date, startMin),
 * or null if it's allowed. Only finishers are ever refused.
 */
export async function checkFinisherPlacement(draftId: string, lineItemId: string, date: Date, startMin: number): Promise<string | null> {
	const ctx = await loadContext(draftId, [lineItemId]);
	const item = ctx.nodes.get(lineItemId);
	if (!item || item.itemType !== LineItemType.FINISHING) return null;

	const earliest = earliestAllowedStart(ctx, item);
	if (!earliest) return null;
	if ('missing' in earliest) {
		return `Place "${earliest.missing.design}" on this schedule first — "${item.design}" has to come after it.`;
	}
	if (isBefore(date.getTime(), startMin, earliest.dayMs, earliest.minute)) {
		return `"${item.design}" has to start after the job it waits on finishes (${iso(earliest.dayMs)} at ${formatClock(earliest.minute)}).`;
	}
	return null;
}

/**
 * After `assignmentId` was placed or moved, pushes any of its finishers (and theirs,
 * transitively) that would now start before it ends — each to the first slot on its
 * own station that's after the dependency, doesn't overlap another block, and fits
 * in the shift (else the next day). Returns every placement that moved.
 */
export async function pushDependentsAfter(draftId: string, assignmentId: string): Promise<PushedPlacement[]> {
	const ctx = await loadContext(draftId);
	const pushed = new Map<string, PushedPlacement>();
	const queue = [assignmentId];

	for (let guard = 0; queue.length > 0 && guard < 500; guard++) {
		const currentId = queue.shift();
		const current = ctx.placements.find((p) => p.id === currentId);
		if (!current) continue;

		for (const dependent of ctx.dependentsOf(current.lineItemId)) {
			const placement = ctx.placements.find((p) => p.lineItemId === dependent.id);
			if (!placement) continue;
			const earliest = earliestAllowedStart(ctx, dependent);
			if (!earliest || 'missing' in earliest) continue;
			if (!isBefore(placement.dayMs, placement.startMin, earliest.dayMs, earliest.minute)) continue;

			let dayMs = earliest.dayMs;
			let desired = earliest.minute;
			let start = desired;
			for (let day = 0; day < 366; day++) {
				const others = ctx.placements.filter((p) => p.id !== placement.id && p.stationId === placement.stationId && p.dayMs === dayMs);
				start = findNonOverlappingStart(desired, placement.durationMin, others);
				const fits = workingMinutesUntilShiftEnd(start) >= Math.min(placement.durationMin, WORKING_MIN);
				if (fits) break;
				dayMs += 24 * 60 * 60 * 1000;
				desired = SHIFT_START_MIN;
			}

			const movedDay = dayMs !== placement.dayMs;
			placement.dayMs = dayMs;
			placement.startMin = start;
			pushed.set(placement.id, { id: placement.id, date: iso(dayMs), startMinuteOfDay: start });

			const sequenceOrder = movedDay
				? ((
						await prisma.scheduleAssignment.findFirst({
							where: { stationId: placement.stationId, date: new Date(dayMs), id: { not: placement.id } },
							orderBy: { sequenceOrder: 'desc' },
							select: { sequenceOrder: true }
						})
					)?.sequenceOrder ?? -1) + 1
				: undefined;
			await prisma.scheduleAssignment.update({
				where: { id: placement.id },
				data: { date: new Date(dayMs), startMinuteOfDay: start, ...(sequenceOrder !== undefined ? { sequenceOrder } : {}) }
			});
			queue.push(placement.id);
		}
	}

	return [...pushed.values()];
}
