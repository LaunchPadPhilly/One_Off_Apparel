import { prisma } from '$lib/server/prisma';
import { computeOrderGaps, type OrderGaps } from './orderGaps';

type Db = Pick<typeof prisma, 'order'>;

/**
 * computeOrderGaps() for many orders at once, read fresh from the database — the one
 * definition of "is this order valid" used by the confirm gate (confirmImport.ts), the
 * Orders list's "Needs re-review" flag, and the schedule board. Import-time flags are
 * passed as empty: they're context only and never count toward `blockingCount`, so
 * there's no need to read them back out of the audit log here.
 */
export async function fetchOrderGaps(orderIds: readonly string[], db: Db = prisma): Promise<Map<string, OrderGaps>> {
	if (orderIds.length === 0) return new Map();
	const orders = await db.order.findMany({
		where: { id: { in: [...orderIds] } },
		select: { id: true, blankOrderingStatus: true, customerApprovalStatus: true, lineItems: true }
	});
	return new Map(
		orders.map((order) => [
			order.id,
			computeOrderGaps({ blankOrderingStatus: order.blankOrderingStatus, customerApprovalStatus: order.customerApprovalStatus, importFlags: [] }, order.lineItems)
		])
	);
}
