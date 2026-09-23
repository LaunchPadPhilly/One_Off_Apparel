import { prisma } from '$lib/server/prisma';
import { computeInternalDueDate } from '$lib/internalDueDate';
import { orderCorrectionSchema, lineItemCorrectionSchema, type OrderCorrection, type LineItemCorrection } from './types';

/**
 * Direct field edits on an active order/line item — the Orders page's "editing" ask,
 * independent of confirmImport's corrections (which only apply *at* confirm time and
 * only to needs_review orders). This works regardless of order status, so an active
 * order can be corrected after confirmation too. Not exposed as an MCP tool (no
 * decision to do that has been made); a plain server-side function the Orders page
 * calls directly, same pattern as startAssignment/stopAssignment.
 */
export async function updateOrderFields(orderId: string, patch: OrderCorrection, actor: string) {
	const validated = orderCorrectionSchema.parse(patch);

	return prisma.$transaction(async (tx) => {
		const updated = await tx.order.update({
			where: { id: orderId },
			data: {
				...validated,
				...(validated.externalShipDate ? { externalShipDate: new Date(validated.externalShipDate) } : {}),
				// A directly-given internalDueDate always wins (a human reviewing the order
				// can set it to whatever they want). Only fall back to the 14-days-before
				// default when externalShipDate changed but internalDueDate wasn't given
				// alongside it.
				...(validated.internalDueDate
					? { internalDueDate: new Date(validated.internalDueDate) }
					: validated.externalShipDate
						? { internalDueDate: new Date(computeInternalDueDate(validated.externalShipDate)) }
						: {})
			}
		});

		await tx.domainAuditLog.create({
			data: { entity: 'Order', entityId: orderId, action: 'order_field_edited', actor, diff: validated }
		});

		return updated;
	});
}

export async function updateLineItemFields(lineItemId: string, patch: LineItemCorrection, actor: string) {
	const validated = lineItemCorrectionSchema.parse(patch);

	return prisma.$transaction(async (tx) => {
		const updated = await tx.lineItem.update({ where: { id: lineItemId }, data: validated });

		await tx.domainAuditLog.create({
			data: { entity: 'LineItem', entityId: lineItemId, action: 'line_item_field_edited', actor, diff: validated }
		});

		return updated;
	});
}
