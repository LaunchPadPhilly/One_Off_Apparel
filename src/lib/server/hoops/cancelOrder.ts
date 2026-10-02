import { prisma } from '$lib/server/prisma';
import { OrderStatus } from '../../../../prisma/generated/prisma/enums';

// A custom error type just for this file, so the code calling cancelOrder() can tell
// "this specific, expected failure happened" (e.g. "already cancelled") apart from a
// random unexpected crash. `extends Error` means CancelOrderError behaves like a
// normal JavaScript error (has a .message, works with try/catch) but can also be
// checked with `instanceof CancelOrderError` elsewhere in the code.
export class CancelOrderError extends Error {}

/**
 * NEW (2026-09-21): this is the whole "Delete an order" feature — except it doesn't
 * actually delete anything from the database. Instead it just changes the order's
 * status to CANCELLED. Why do it this way instead of a real delete?
 *
 * Because an Order can have LineItems, ScheduleAssignments, and Actuals attached to
 * it. If we deleted the Order row, the database's cascade rule would automatically
 * delete all of those too — wiping out real production history just because someone
 * wanted an order to stop showing up in the active list. Marking it CANCELLED instead
 * keeps every bit of that data intact; it just makes the order invisible to the
 * scheduling logic and the active Orders page.
 *
 * How does "cancelling" actually keep it out of scheduling? Nothing extra had to be
 * built for that — the code that builds the scheduling backlog (fetchBacklog) only
 * ever looks at orders with status CONFIRMED, so a CANCELLED order is automatically
 * skipped, same as any other non-CONFIRMED status.
 *
 * @param orderId - which order to cancel (its database id)
 * @param actor - who is doing the cancelling (their email), so we can write it to the
 *                audit log for accountability
 */
export async function cancelOrder(orderId: string, actor: string) {
	// prisma.$transaction runs everything inside this function as one atomic unit:
	// either both the status update AND the audit log entry succeed together, or if
	// anything goes wrong, neither happens. This stops us from ever ending up with an
	// order marked cancelled but no record of who cancelled it (or vice versa).
	return prisma.$transaction(async (tx) => {
		// Step 1: look up the order's current status before changing anything, so we
		// can (a) check it's actually allowed to be cancelled, and (b) record what the
		// status was changing FROM in the audit log.
		const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
		if (!order) throw new CancelOrderError('Order not found');

		// Step 2: guard rails. You can't cancel an order that's already fully done
		// (COMPLETE) — there's nothing left to cancel. And cancelling an
		// already-cancelled order would just be a no-op, so we reject that too, to
		// make it obvious to whoever's using the button that nothing happened.
		if (order.status === OrderStatus.COMPLETE) throw new CancelOrderError('Cannot cancel a completed order');
		if (order.status === OrderStatus.CANCELLED) throw new CancelOrderError('Order is already cancelled');

		// Step 3: the actual "cancel" — just a normal database update of one field.
		const updated = await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED } });

		// Step 4: write an audit log entry so there's a permanent record of who
		// cancelled this order and when. `diff` stores what changed (old status ->
		// new status) as JSON, matching how every other change in this app is logged.
		await tx.domainAuditLog.create({
			data: { entity: 'Order', entityId: orderId, action: 'order_cancelled', actor, diff: { from: order.status, to: OrderStatus.CANCELLED } }
		});

		return updated;
	});
}
