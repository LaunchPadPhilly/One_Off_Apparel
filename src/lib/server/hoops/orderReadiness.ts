import { prisma } from '$lib/server/prisma';
import { computeOrderGaps, type OrderGaps } from './orderGaps';

// Anything with Prisma's `order` model: the global client, or a transaction client
// (`tx`) so confirmImport.ts can run this inside its own transaction.
type Db = Pick<typeof prisma, 'order'>;

/**
 * computeOrderGaps() for many orders at once, read fresh from the database — the one
 * definition of "is this order valid" used by the confirm gate (confirmImport.ts) and
 * the Orders list's "Needs re-review" flag (src/routes/orders/+page.server.ts; the
 * draft board calls computeOrderGaps() directly). Import-time flags are
 * passed as empty: they're context only and never count toward `blockingCount`, so
 * there's no need to read them back out of the audit log here.
 *
 * @returns a Map from order id to its gaps; ids that don't exist are simply absent
 */
export async function fetchOrderGaps(orderIds: readonly string[], db: Db = prisma): Promise<Map<string, OrderGaps>> {
	if (orderIds.length === 0) return new Map();
	const orders = await db.order.findMany({
		where: { id: { in: [...orderIds] } },
		select: { id: true, deadline: true, blankOrderingStatus: true, customerApprovalStatus: true, lineItems: true }
	});
	return new Map(
		orders.map((order) => [
			order.id,
			computeOrderGaps({ deadline: order.deadline, blankOrderingStatus: order.blankOrderingStatus, customerApprovalStatus: order.customerApprovalStatus, importFlags: [] }, order.lineItems)
		])
	);
}
