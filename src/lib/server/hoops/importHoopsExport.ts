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

/**
 * Persists already-extracted Hoops order/line-item candidates (see types.ts for why
 * this doesn't parse a file itself). Creates `Order` rows at status needs_review and
 * `LineItem` rows at needs_review (decoration, and any finishing row with no unmet
 * dependency) or blocked (every other finishing row) — exactly per CLAUDE.md's schema
 * notes. Nothing here is schedulable yet: that gate is confirm_import, not this.
 *
 * This is the persistence half of the `import_hoops_export` MCP tool CLAUDE.md
 * describes. It is deliberately NOT wired into src/lib/server/mcp/tools.ts yet — every
 * tool registered there is hardcoded read-only (see mcp/handler.ts), and CLAUDE.md's
 * Security constraints section explicitly says not to silently resolve that conflict
 * either direction. Call this from wherever that gets decided (a tool once the write
 * exception is approved, or a server action it triggers).
 */
export async function importHoopsExport(orders: readonly OrderCandidate[]): Promise<ImportHoopsExportResult> {
	const validatedOrders = orders.map((order) => orderCandidateSchema.parse(order));

	const orderIds: string[] = [];
	const lineItems: LineItem[] = [];
	const confidenceFlags: string[] = [];

	await prisma.$transaction(async (tx) => {
		for (const orderCandidate of validatedOrders) {
			const orderId = randomUUID();
			const createdOrder: Order = await tx.order.create({
				data: {
					id: orderId,
					hoopsOrderId: orderCandidate.hoopsOrderId,
					customerName: orderCandidate.customerName,
					// externalShipDate/internalDueDate are z.iso.date() strings ("YYYY-MM-DD") —
					// Prisma's runtime validation, unlike its TS types, rejects a date-only
					// string and needs a real Date.
					externalShipDate: new Date(orderCandidate.externalShipDate),
					internalDueDate: new Date(orderCandidate.internalDueDate),
					status: OrderStatus.NEEDS_REVIEW,
					importedBy: orderCandidate.importedBy
				}
			});
			orderIds.push(createdOrder.id);
			if (orderCandidate.confidenceFlags) confidenceFlags.push(...orderCandidate.confidenceFlags);

			// Pre-generate real ids so a finishing row's dependsOn can point at a sibling
			// decoration row created in this same batch, before either exists in the DB.
			const localIdToRealId = new Map(orderCandidate.lineItems.map((item) => [item.localId, randomUUID()]));

			for (const itemCandidate of orderCandidate.lineItems) {
				const isFinishing = itemCandidate.itemType === LineItemType.FINISHING;
				const created = await tx.lineItem.create({
					data: {
						id: localIdToRealId.get(itemCandidate.localId)!,
						orderId: createdOrder.id,
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
				lineItems.push(created);
			}

			await tx.domainAuditLog.create({
				data: {
					entity: 'Order',
					entityId: createdOrder.id,
					action: 'hoops_import_created',
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
