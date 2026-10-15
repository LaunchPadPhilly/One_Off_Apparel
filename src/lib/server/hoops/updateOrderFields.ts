import { prisma } from '$lib/server/prisma';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import { LineItemStatus, OrderStatus } from '../../../../prisma/generated/prisma/enums';
import { checkCompletion } from '$lib/server/engine/checkCompletion';
import { isPatchInstall } from '$lib/schedule/patchInstall';
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
 * Clears the red "Couldn't be scheduled" flag (proposeAndPersistSchedule.ts). It's the
 * outcome of the last automatic plan, so an edit to the order or one of its jobs may
 * have fixed the cause — and a flagged order is hidden from the draft board's sidebar,
 * so a stale flag would keep a fixed order from being placed by hand.
 */
async function clearScheduleFlag(tx: Prisma.TransactionClient, orderId: string) {
	await tx.order.updateMany({ where: { id: orderId, scheduleFlagReason: { not: null } }, data: { scheduleFlagReason: null, scheduleFlaggedAt: null } });
}

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
		// An edit (other than notes) may have fixed why the last plan couldn't fit it.
		if (Object.keys(validated).some((key) => key !== 'notes')) await clearScheduleFlag(tx, orderId);

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
 *         unknown station, or `outsourced: true` is set on anything but a Patch Install;
 *         ZodError if the patch fails validation
 */
export async function updateLineItemFields(lineItemId: string, patch: LineItemCorrection, actor: string) {
	const validated = lineItemCorrectionSchema.parse(patch);
	let completeAfterCommit = false;

	const result = await prisma.$transaction(async (tx) => {
		// Outsourced (2026-10-14) is Patch Install only, and the job's status follows the
		// answer: outsourced = done, through check_completion after commit (confirmImport
		// does it for an order still in review); switched back to in-house = schedulable
		// again, unless the order already completed.
		let statusChange: { status?: LineItemStatus } = {};
		if (validated.outsourced !== undefined) {
			const before = await tx.lineItem.findUnique({
				where: { id: lineItemId },
				select: { itemType: true, otherJobType: true, outsourced: true, status: true, order: { select: { status: true } } }
			});
			if (validated.outsourced === true && !(before && isPatchInstall(before))) throw new Error('Only a Patch Install can be marked outsourced.');
			if (before && validated.outsourced === true && before.status !== LineItemStatus.COMPLETE && before.order.status !== OrderStatus.NEEDS_REVIEW) {
				completeAfterCommit = true;
			}
			if (before && validated.outsourced !== true && before.outsourced === true && before.status === LineItemStatus.COMPLETE && before.order.status !== OrderStatus.COMPLETE) {
				statusChange = { status: LineItemStatus.NEEDS_REVIEW };
			}
		}

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

		const updated = await tx.lineItem.update({ where: { id: lineItemId }, data: { ...validated, ...statusChange } });
		await clearScheduleFlag(tx, updated.orderId);

		await tx.domainAuditLog.create({
			data: { entity: 'LineItem', entityId: lineItemId, action: 'line_item_field_edited', actor, diff: validated }
		});

		return updated;
	});

	if (completeAfterCommit) await checkCompletion(lineItemId);
	return result;
}
