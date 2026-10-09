import { prisma } from '$lib/server/prisma';
import { orderCorrectionSchema, lineItemCorrectionSchema, type OrderCorrection, type LineItemCorrection } from './types';

/**
 * Direct field edits on an active order/line item — the Orders page's "editing" ask,
 * independent of confirmImport's corrections (which only apply *at* confirm time and
 * only to needs_review orders). This works regardless of order status, so an active
 * order can be corrected after confirmation too. Not exposed as an MCP tool (no
 * decision to do that has been made); a plain server-side function the Orders page
 * calls directly, same pattern as startAssignment/stopAssignment. Also used by
 * fillNeedsAttentionFromNotes.ts to apply answers from a reviewer's note.
 */

/**
 * Validates and saves an order-level field edit, with an audit log entry.
 *
 * @param orderId - the order's database id
 * @param patch - only the fields being changed (see orderCorrectionSchema in types.ts)
 * @param actor - who made the edit, for the audit log
 * @returns the updated Order row
 * @throws ZodError if the patch fails validation; Prisma's not-found error if the order doesn't exist
 */
export async function updateOrderFields(orderId: string, patch: OrderCorrection, actor: string) {
	const validated = orderCorrectionSchema.parse(patch);

	return prisma.$transaction(async (tx) => {
		const updated = await tx.order.update({
			where: { id: orderId },
			data: {
				...validated,
				// z.iso.date() gives back a "YYYY-MM-DD" string; Prisma's runtime validation
				// needs a real Date at rest (see getSchedule.ts for the deeper reason).
				...(validated.deadline ? { deadline: new Date(validated.deadline) } : {})
			}
		});

		await tx.domainAuditLog.create({
			data: { entity: 'Order', entityId: orderId, action: 'order_field_edited', actor, diff: validated }
		});

		return updated;
	});
}

/**
 * Validates and saves a line-item field edit, with an audit log entry.
 *
 * @param lineItemId - the line item's database id
 * @param patch - only the fields being changed (see lineItemCorrectionSchema in types.ts)
 * @param actor - who made the edit, for the audit log
 * @returns the updated LineItem row
 * @throws Error if `assignedStationId` is set on a non-OTHER row or names an archived /
 *         unknown station; ZodError if the patch fails validation
 */
export async function updateLineItemFields(lineItemId: string, patch: LineItemCorrection, actor: string) {
	const validated = lineItemCorrectionSchema.parse(patch);

	return prisma.$transaction(async (tx) => {
		// A station assignment (2026-09-28) only means something on an OTHER row, and
		// must name a real, active station — refused rather than stored otherwise.
		if (validated.assignedStationId) {
			const [lineItem, station] = await Promise.all([
				tx.lineItem.findUnique({ where: { id: lineItemId }, select: { itemType: true } }),
				tx.station.findFirst({ where: { id: validated.assignedStationId, archivedAt: null }, select: { id: true } })
			]);
			if (lineItem?.itemType !== 'OTHER') throw new Error('Only a job the system has no type for can be assigned a station by hand.');
			if (!station) throw new Error('That station no longer exists — pick another one.');
		}

		const updated = await tx.lineItem.update({ where: { id: lineItemId }, data: validated });

		await tx.domainAuditLog.create({
			data: { entity: 'LineItem', entityId: lineItemId, action: 'line_item_field_edited', actor, diff: validated }
		});

		return updated;
	});
}
