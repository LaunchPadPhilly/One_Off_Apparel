import { prisma } from '$lib/server/prisma';
import { OrderStatus } from '../../../../prisma/generated/prisma/enums';
import { fetchOrderGaps } from './orderReadiness';
import { lineItemCorrectionSchema, orderCorrectionSchema, type ImportCorrections } from './types';

/**
 * Locks a Hoops import in as real once a person has checked it — the first of
 * CLAUDE.md's two human approval gates. Applies any corrections, then flips the given
 * orders from needs_review to confirmed. Never touches LineItem.status: the scheduling
 * backlog (fetchBacklog() in buildBacklogAndCapacity.ts) checks the parent Order is
 * CONFIRMED itself, so flipping Order.status here is all it takes to make the line items
 * schedulable.
 *
 * Called from the order page's "Confirm import" action (src/routes/orders/[id]/+page.server.ts)
 * and the confirm_import MCP tool (src/lib/server/mcp/tools.ts) — both go through this
 * same gate.
 *
 * Note: CLAUDE.md's tool signature is `confirm_import(order_ids[], corrections?)` — no
 * explicit confirmer identity, unlike `commit_schedule(assignment_ids[], approved_by)`,
 * because at the MCP-tool layer the authenticated principal making the call *is* the
 * confirming human. This module has no request-scoped principal of its own, so each
 * caller passes that identity in as `confirmedBy`.
 *
 * @param orderIds - database ids of the orders to confirm (all must be needs_review)
 * @param confirmedBy - who is confirming, for the audit log
 * @param corrections - optional field edits applied just before the check (see types.ts)
 * @throws Error if an order id doesn't exist, isn't needs_review, or still has open
 *         blocking items (orderGaps.ts) after corrections. The whole transaction rolls
 *         back, so corrections aren't saved either.
 */
export async function confirmImport(orderIds: readonly string[], confirmedBy: string, corrections?: ImportCorrections): Promise<void> {
	if (orderIds.length === 0) return;

	await prisma.$transaction(async (tx) => {
		const orders = await tx.order.findMany({ where: { id: { in: [...orderIds] } } });
		if (orders.length !== orderIds.length) {
			const found = new Set(orders.map((order) => order.id));
			const missing = orderIds.filter((id) => !found.has(id));
			throw new Error(`confirm_import: order id(s) not found: ${missing.join(', ')}`);
		}

		const notNeedsReview = orders.filter((order) => order.status !== OrderStatus.NEEDS_REVIEW);
		if (notNeedsReview.length > 0) {
			throw new Error(
				`confirm_import: order(s) not in needs_review status: ${notNeedsReview.map((order) => `${order.id} (${order.status})`).join(', ')}`
			);
		}

		// So each order's audit entry can report only the line item corrections that
		// actually belong to it, not the whole batch's.
		const lineItemOrders = await tx.lineItem.findMany({
			where: { orderId: { in: [...orderIds] } },
			select: { id: true, orderId: true }
		});
		const lineItemsByOrder = new Map(lineItemOrders.map((row) => [row.id, row.orderId] as const));

		for (const [lineItemId, patch] of Object.entries(corrections?.lineItems ?? {})) {
			const validated = lineItemCorrectionSchema.parse(patch);
			await tx.lineItem.update({ where: { id: lineItemId }, data: validated });
		}

		for (const [orderId, patch] of Object.entries(corrections?.orders ?? {})) {
			const validated = orderCorrectionSchema.parse(patch);
			// deadline, if present, is a z.iso.date() string — Prisma's runtime validation
			// needs a real Date (see getSchedule.ts).
			await tx.order.update({
				where: { id: orderId },
				data: {
					...validated,
					...(validated.deadline ? { deadline: new Date(validated.deadline) } : {})
				}
			});
		}

		// NEW (2026-09-23): an order is only confirmable once it's fully valid — a
		// deadline set and every line item estimable (orderGaps.ts' blockingCount; blanks,
		// customer approval and artwork are assumed done and no longer counted). Checked here, after corrections are applied and
		// inside the same transaction, so neither the order page nor the confirm_import
		// MCP tool can confirm around it.
		const gapsByOrder = await fetchOrderGaps(orderIds, tx);
		const notReady = orders.filter((order) => (gapsByOrder.get(order.id)?.blockingCount ?? 0) > 0);
		if (notReady.length > 0) {
			throw new Error(
				`confirm_import: can't confirm yet — ${notReady
					.map((order) => `${order.hoopsOrderId} has ${gapsByOrder.get(order.id)!.blockingCount} open item(s) (see Needs attention on its order page)`)
					.join('; ')}.`
			);
		}

		await tx.order.updateMany({ where: { id: { in: [...orderIds] } }, data: { status: OrderStatus.CONFIRMED } });

		for (const orderId of orderIds) {
			const lineItemCorrectionsForOrder = Object.fromEntries(
				Object.entries(corrections?.lineItems ?? {}).filter(([lineItemId]) => lineItemsByOrder.get(lineItemId) === orderId)
			);

			await tx.domainAuditLog.create({
				data: {
					entity: 'Order',
					entityId: orderId,
					action: 'hoops_import_confirmed',
					actor: confirmedBy,
					diff: {
						orderCorrection: corrections?.orders?.[orderId] ?? null,
						lineItemCorrections: lineItemCorrectionsForOrder
					}
				}
			});
		}
	});
}
