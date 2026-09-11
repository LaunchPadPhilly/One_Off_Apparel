import { prisma } from '$lib/server/prisma';
import { LineItemStatus, OrderStatus } from '../../../../prisma/generated/prisma/enums';
import { ALL_SIBLINGS_DEPENDENCY } from './types';

/**
 * Runs the moment the "Stop" button fires for the last station on a line item. Part
 * of the start/stop + actuals flow, not the scheduling flow — never call this from
 * inside proposeSchedule (see CLAUDE.md's engine section).
 *
 * Marks the line item complete, unlocks any finishing line item under the same order
 * that was waiting specifically on it or on "all_siblings", and flips the order to
 * complete once every line item under it is complete. orders.status only ever
 * becomes complete through this path — never set it directly elsewhere.
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
