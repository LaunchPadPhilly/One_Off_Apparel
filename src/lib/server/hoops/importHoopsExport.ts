import { randomUUID } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { LineItemStatus, LineItemType, OrderStatus } from '../../../../prisma/generated/prisma/enums';
import type { LineItem, Order } from '../../../../prisma/generated/prisma/client';
import { ALL_SIBLINGS, orderCandidateSchema, type OrderCandidate } from './types';

export interface ImportHoopsExportResult {
	orderIds: string[];
	lineItems: LineItem[];
	confidenceFlags: string[];
}

function resolveDependsOn(dependsOn: string | null | undefined, localIdToRealId: ReadonlyMap<string, string>): string | null {
	if (dependsOn == null) return null;
	if (dependsOn === ALL_SIBLINGS) return ALL_SIBLINGS;

	const resolved = localIdToRealId.get(dependsOn);
	if (!resolved) {
		throw new Error(`import_hoops_export: dependsOn references unknown localId "${dependsOn}" within this order's line items`);
	}
	return resolved;
}

async function createLineItemsForOrder(
	tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
	orderId: string,
	itemCandidates: OrderCandidate['lineItems']
): Promise<LineItem[]> {
	// Pre-generate real ids so a finishing row's dependsOn can point at a sibling
	// decoration row created in this same batch, before either exists in the DB.
	const localIdToRealId = new Map(itemCandidates.map((item) => [item.localId, randomUUID()]));
	const created: LineItem[] = [];

	for (const itemCandidate of itemCandidates) {
		const isFinishing = itemCandidate.itemType === LineItemType.FINISHING;
		const row = await tx.lineItem.create({
			data: {
				id: localIdToRealId.get(itemCandidate.localId)!,
				orderId,
				itemType: itemCandidate.itemType,
				design: itemCandidate.design,
				printLocation: itemCandidate.printLocation ?? null,
				decorationType: itemCandidate.decorationType ?? null,
				finishingStep: itemCandidate.finishingStep ?? null,
				dependsOn: resolveDependsOn(itemCandidate.dependsOn, localIdToRealId),
				// Finishing rows always start blocked, whatever they depend on —
				// check_completion is the only thing that unlocks them.
				status: isFinishing ? LineItemStatus.BLOCKED : LineItemStatus.NEEDS_REVIEW,
				weightClass: itemCandidate.weightClass,
				apparelColor: itemCandidate.apparelColor,
				inkColorCount: itemCandidate.inkColorCount ?? null,
				screens: itemCandidate.screens ?? null,
				stitchCount: itemCandidate.stitchCount ?? null,
				quantity: itemCandidate.quantity,
				sizeBreakdown: itemCandidate.sizeBreakdown,
				reviewConfidence: itemCandidate.reviewConfidence ?? null
			}
		});
		created.push(row);
	}
	return created;
}

/**
 * Persists already-extracted Hoops order/line-item candidates (see types.ts for why
 * this doesn't parse a file itself). Creates `Order` rows at status needs_review and
 * `LineItem` rows at needs_review (decoration, and any finishing row with no unmet
 * dependency) or blocked (every other finishing row) — exactly per CLAUDE.md's schema
 * notes. Nothing here is schedulable yet: that gate is confirm_import, not this.
 *
 * Re-import (a hoopsOrderId that already exists) is always allowed and always reopens
 * review, regardless of the existing order's current status — this was an explicit
 * product decision, not inferred. It replaces the order's line items outright rather
 * than trying to diff/merge them: the old ones no longer describe the job once a
 * corrected export lands. Because ScheduleAssignment/Actual both cascade-delete from
 * LineItem, this also clears any stale schedule/actuals history tied to the old line
 * items — those don't make sense against a superseded spec either.
 */
export async function importHoopsExport(orders: readonly OrderCandidate[]): Promise<ImportHoopsExportResult> {
	const validatedOrders = orders.map((order) => orderCandidateSchema.parse(order));

	const orderIds: string[] = [];
	const lineItems: LineItem[] = [];
	const confidenceFlags: string[] = [];

	await prisma.$transaction(async (tx) => {
		for (const orderCandidate of validatedOrders) {
			const existing = await tx.order.findUnique({ where: { hoopsOrderId: orderCandidate.hoopsOrderId } });

			const orderData = {
				customerName: orderCandidate.customerName,
				// externalShipDate/internalDueDate are z.iso.date() strings ("YYYY-MM-DD") —
				// Prisma's runtime validation, unlike its TS types, rejects a date-only
				// string and needs a real Date.
				externalShipDate: new Date(orderCandidate.externalShipDate),
				internalDueDate: new Date(orderCandidate.internalDueDate),
				status: OrderStatus.NEEDS_REVIEW,
				importedBy: orderCandidate.importedBy
			};

			let order: Order;
			let auditAction: string;
			if (existing) {
				// Replace this order's line items outright — see doc comment above.
				await tx.lineItem.deleteMany({ where: { orderId: existing.id } });
				order = await tx.order.update({ where: { id: existing.id }, data: orderData });
				auditAction = 'hoops_import_reopened';
			} else {
				order = await tx.order.create({ data: { id: randomUUID(), hoopsOrderId: orderCandidate.hoopsOrderId, ...orderData } });
				auditAction = 'hoops_import_created';
			}

			orderIds.push(order.id);
			if (orderCandidate.confidenceFlags) confidenceFlags.push(...orderCandidate.confidenceFlags);

			const createdLineItems = await createLineItemsForOrder(tx, order.id, orderCandidate.lineItems);
			lineItems.push(...createdLineItems);

			await tx.domainAuditLog.create({
				data: {
					entity: 'Order',
					entityId: order.id,
					action: auditAction,
					actor: orderCandidate.importedBy,
					diff: {
						hoopsOrderId: orderCandidate.hoopsOrderId,
						lineItemCount: orderCandidate.lineItems.length,
						confidenceFlags: orderCandidate.confidenceFlags ?? []
					}
				}
			});
		}
	});

	return { orderIds, lineItems, confidenceFlags };
}
