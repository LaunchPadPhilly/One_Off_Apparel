import { prisma } from '$lib/server/prisma';

/**
 * NEW (2026-09-21): fetches every scheduled job (a "ScheduleAssignment" row) that
 * belongs to a given order, so the order's detail page can show a "Schedule" section
 * ("here's when and where each of this order's jobs is scheduled to run").
 *
 * A couple of things worth knowing if you're new to this codebase:
 *
 * - There's a similar function, getSchedule.ts, used by the main Schedule/production
 *   board page — but that one deliberately skips jobs with status "PROPOSED" (a
 *   proposed-but-not-yet-approved schedule slot), because the production board should
 *   only show the *real*, approved schedule. This function is different on purpose: it
 *   includes PROPOSED rows too, because on an order's own page we actually want to
 *   show "here's what the scheduler suggested for this order," even before a human
 *   has approved it.
 *
 * - ScheduleAssignment rows don't have a direct link to Order — only to LineItem
 *   (and LineItem has orderId). So to find "every schedule assignment for order X" we
 *   have to go through the lineItem relation, filtering on lineItem.orderId. That's
 *   what the `where: { lineItem: { orderId } }` below does — Prisma lets you filter
 *   through a relationship like this.
 *
 * @param orderId - the order whose schedule we want to look up
 */
export async function getScheduleForOrder(orderId: string) {
	return prisma.scheduleAssignment.findMany({
		// Only return rows whose linked line item belongs to this order.
		where: { lineItem: { orderId } },
		// `include` pulls in related data we need for display — the station's name and
		// a few identifying details about the line item (so the page can show
		// something readable like "Screen print — Front logo" instead of just IDs).
		include: {
			lineItem: { select: { id: true, design: true, itemType: true, decorationType: true, finishingStep: true } },
			station: { select: { id: true, name: true } }
		},
		// Sort by date first, then by the job's position within that day's queue at its
		// station (sequenceOrder), so the results read top-to-bottom in the same order
		// the jobs would actually run.
		orderBy: [{ date: 'asc' }, { sequenceOrder: 'asc' }]
	});
}
