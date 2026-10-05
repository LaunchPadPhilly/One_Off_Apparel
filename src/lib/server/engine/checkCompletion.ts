/**
 * check_completion: the one place a line item, and then its order, becomes COMPLETE.
 * Called from the Production Board's "Stop" flow (start/stop + actuals), never from
 * scheduling. Key rule: Order.status only ever flips to COMPLETE here — application
 * code must never set it directly (see CLAUDE.md's `orders` table notes).
 */
import { prisma } from '$lib/server/prisma';
import { LineItemStatus, LineItemType, OrderStatus } from '../../../../prisma/generated/prisma/enums';
import { ALL_DECORATIONS_DEPENDENCY, ALL_SIBLINGS_DEPENDENCY } from './types';

/**
 * Runs the moment the "Stop" button fires for the last station on a line item. Part
 * of the start/stop + actuals flow, not the scheduling flow — never call this from
 * inside proposeSchedule (see CLAUDE.md's engine section).
 *
 * Marks the line item complete, unlocks (BLOCKED → NEEDS_REVIEW) any finishing line
 * item under the same order that was waiting on it — specifically by id, on
 * "all_decorations" once every decoration is done, or on "all_siblings" once every
 * other line item is done — and flips the order to complete once every line item
 * under it is complete. orders.status only ever becomes complete through this path —
 * never set it directly elsewhere. Runs in one transaction, so a failure part-way
 * leaves nothing half-updated.
 *
 * @param lineItemId the line item whose last station was just Stopped.
 * @throws Prisma's not-found error if no line item has that id (the transaction rolls back).
 */
export async function checkCompletion(lineItemId: string): Promise<void> {
	await prisma.$transaction(async (tx) => {
		const completed = await tx.lineItem.update({
			where: { id: lineItemId },
			data: { status: LineItemStatus.COMPLETE }
		});

		// Snapshot every line item under this order, taken after marking `completed`
		// complete, so both the unlock check and the order-completion check below see
		// a single consistent view.
		const siblings = await tx.lineItem.findMany({ where: { orderId: completed.orderId } });

		const toUnlock = siblings
			.filter((candidate) => candidate.id !== completed.id && candidate.status === LineItemStatus.BLOCKED)
			.filter((candidate) => {
				if (candidate.dependsOn === completed.id) return true;
				// A matte not linked to one design (2026-09-28) waits on every design.
				if (candidate.dependsOn === ALL_DECORATIONS_DEPENDENCY) {
					return siblings.filter((sibling) => sibling.itemType === LineItemType.DECORATION).every((sibling) => sibling.status === LineItemStatus.COMPLETE);
				}
				if (candidate.dependsOn === ALL_SIBLINGS_DEPENDENCY) {
					return siblings.every((sibling) => sibling.id === candidate.id || sibling.status === LineItemStatus.COMPLETE);
				}
				return false;
			});

		if (toUnlock.length > 0) {
			await tx.lineItem.updateMany({
				where: { id: { in: toUnlock.map((item) => item.id) } },
				data: { status: LineItemStatus.NEEDS_REVIEW }
			});
		}

		const unlockedIds = new Set(toUnlock.map((item) => item.id));
		const orderComplete = siblings.every((sibling) => {
			if (sibling.id === completed.id) return true;
			if (unlockedIds.has(sibling.id)) return false; // just moved to needs_review, not complete
			return sibling.status === LineItemStatus.COMPLETE;
		});

		if (orderComplete) {
			await tx.order.update({ where: { id: completed.orderId }, data: { status: OrderStatus.COMPLETE } });
		}
	});
}
