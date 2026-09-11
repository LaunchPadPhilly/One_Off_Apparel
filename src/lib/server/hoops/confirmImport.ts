import { prisma } from '$lib/server/prisma';
import { OrderStatus } from '../../../../prisma/generated/prisma/enums';
import { lineItemCorrectionSchema, orderCorrectionSchema, type ImportCorrections } from './types';

/**
 * Locks a Hoops import in as real once a person has checked it — the first of
 * CLAUDE.md's two human approval gates. Applies any corrections, then flips the given
 * orders from needs_review to confirmed. Never touches LineItem.status: propose_schedule's
 * backlog is filtered on LineItem.status alone (see CLAUDE.md's engine section — "backlog
 * only ever contains status: needs_review"), so whatever builds that backlog must also
 * check the parent Order is confirmed. That's this function's caller's job, not this one's.
 *
 * Note: CLAUDE.md's tool signature is `confirm_import(order_ids[], corrections?)` — no
 * explicit confirmer identity, unlike `commit_schedule(assignment_ids[], approved_by)`.
 * That's presumably because at the MCP-tool layer the authenticated principal making the
 * call *is* the confirming human, so there's nothing to pass explicitly. This module has
 * no request-scoped principal (it's not wired into mcp/tools.ts — see importHoopsExport.ts
 * for why), so `confirmedBy` is a required parameter here; thread the caller's identity
 * through it once that wiring exists.
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
			await tx.order.update({ where: { id: orderId }, data: validated });
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
