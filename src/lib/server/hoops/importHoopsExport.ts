import { randomUUID } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { ArtworkApprovalStatus, BlankOrderingStatus, CustomerApprovalStatus, LineItemStatus, LineItemType, OrderStatus } from '../../../../prisma/generated/prisma/enums';
import type { LineItem, Order } from '../../../../prisma/generated/prisma/client';
import { ALL_SIBLINGS, orderCandidateSchema, type OrderCandidate } from './types';
import { finishingDependencyRule } from '$lib/server/engine/finishingDependencies';
import { ALL_DECORATIONS_DEPENDENCY } from '$lib/server/engine/types';
import { countDecorationColors } from '$lib/server/engine/decorationColors';

/*
 * Saves extracted Hoops orders to the database for human review. Called from the Orders
 * page's upload action (after extractOrderFromPdf.ts) and the import_hoops_export MCP
 * tool. Key rule: everything lands as needs_review — nothing imported here is
 * schedulable until a person confirms it (confirmImport.ts).
 */

/** What importHoopsExport() returns: the saved order ids, their new line item rows, and every confidence flag raised. */
export interface ImportHoopsExportResult {
	orderIds: string[];
	lineItems: LineItem[];
	confidenceFlags: string[];
}

/**
 * A finishing row's real dependency and starting status, per finishingDependencies.ts
 * (2026-09-28): matte waits on its decoration, fold & bag on everything, the rest on
 * nothing. A matte row the extraction didn't wire to a decoration is linked to the
 * order's only decoration when there's exactly one; otherwise it waits on every
 * design on the order ("all_decorations" — still "after the print") and says so in a flag, rather
 * than guessing which print it belongs to.
 */
function resolveFinishingDependency(
	item: OrderCandidate['lineItems'][number],
	itemCandidates: OrderCandidate['lineItems'],
	localIdToRealId: ReadonlyMap<string, string>,
	flags: string[]
): { dependsOn: string | null; status: LineItemStatus } {
	const rule = finishingDependencyRule(item.finishingStep);
	if (rule === 'none') return { dependsOn: null, status: LineItemStatus.NEEDS_REVIEW };
	if (rule === 'all_siblings') return { dependsOn: ALL_SIBLINGS, status: LineItemStatus.BLOCKED };

	const decorations = itemCandidates.filter((candidate) => candidate.itemType === LineItemType.DECORATION);
	const target = decorations.find((candidate) => candidate.localId === item.dependsOn) ?? (decorations.length === 1 ? decorations[0] : undefined);
	if (target) return { dependsOn: localIdToRealId.get(target.localId)!, status: LineItemStatus.BLOCKED };

	// Not linked to one design: wait on every design on the order (still "after the
	// print"). Never "all_siblings" — that includes fold & bag, which waits on
	// everything too, and the two would wait on each other forever. With no designs at
	// all there's nothing to wait for, so it isn't blocked.
	if (decorations.length === 0) return { dependsOn: null, status: LineItemStatus.NEEDS_REVIEW };
	flags.push(`Matte finish "${item.design}" isn't linked to a specific design, so it will wait until every design on the order is done, rather than guessing which one it belongs to.`);
	return { dependsOn: ALL_DECORATIONS_DEPENDENCY, status: LineItemStatus.BLOCKED };
}

/**
 * Screen print and embroidery need a color count for their formulas. The PDF already
 * lists the colors (2026-10-02: assume what's in the PDF rather than asking), so when
 * the extraction didn't state a count, count the "Color(s)" entries; when those don't
 * name real colors ("TBD", blank), assume 1 and say so in a flag.
 */
function resolveInkColorCount(item: OrderCandidate['lineItems'][number], flags: string[]): number | null {
	if (item.inkColorCount != null) return item.inkColorCount;
	if (item.decorationType !== 'SCREEN_PRINT' && item.decorationType !== 'EMBROIDERY') return null;
	const counted = countDecorationColors(item.decorationColors);
	if (counted != null) return counted;
	flags.push(`"${item.design}" lists no countable colors${item.decorationColors ? ` ("${item.decorationColors}")` : ''}, so 1 color was assumed.`);
	return 1;
}

/**
 * Creates every line item for one order inside the caller's transaction, applying the
 * finishing-dependency, color-count and garment-style defaults above. Any flag raised
 * along the way is appended to `flags`.
 */
async function createLineItemsForOrder(
	tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
	orderId: string,
	itemCandidates: OrderCandidate['lineItems'],
	flags: string[]
): Promise<LineItem[]> {
	// Pre-generate real ids so a finishing row's dependsOn can point at a sibling
	// decoration row created in this same batch, before either exists in the DB.
	const localIdToRealId = new Map(itemCandidates.map((item) => [item.localId, randomUUID()]));
	const created: LineItem[] = [];

	for (const itemCandidate of itemCandidates) {
		const isFinishing = itemCandidate.itemType === LineItemType.FINISHING;
		const dependency = isFinishing
			? resolveFinishingDependency(itemCandidate, itemCandidates, localIdToRealId, flags)
			: { dependsOn: null, status: LineItemStatus.NEEDS_REVIEW };
		const row = await tx.lineItem.create({
			data: {
				id: localIdToRealId.get(itemCandidate.localId)!,
				orderId,
				itemType: itemCandidate.itemType,
				design: itemCandidate.design,
				printLocation: itemCandidate.printLocation ?? null,
				decorationType: itemCandidate.decorationType ?? null,
				finishingStep: itemCandidate.finishingStep ?? null,
				// Matte and fold & bag start blocked (check_completion unlocks them);
				// relabel / hang tags / wovens wait on nothing (2026-09-28).
				dependsOn: dependency.dependsOn,
				status: dependency.status,
				// Artwork is always considered approved (client decision, 2026-09-28); only
				// decorations carry the field at all.
				artworkApprovalStatus: itemCandidate.itemType === LineItemType.DECORATION ? ArtworkApprovalStatus.APPROVED : null,
				otherJobType: itemCandidate.itemType === LineItemType.OTHER ? (itemCandidate.otherJobType ?? null) : null,
				weightClass: itemCandidate.weightClass,
				apparelColor: itemCandidate.apparelColor,
				inkColorCount: resolveInkColorCount(itemCandidate, flags),
				decorationColors: itemCandidate.decorationColors || null,
				screens: itemCandidate.screens ?? null,
				stitchCount: itemCandidate.stitchCount ?? null,
				// Anything that isn't a hat is flat (2026-10-02), so a decoration the
				// extraction didn't mark CAP is FLAT rather than a question.
				garmentStyle: itemCandidate.itemType === LineItemType.DECORATION ? (itemCandidate.garmentStyle ?? 'FLAT') : null,
				capConstruction: itemCandidate.capConstruction ?? null,
				matteSurface: itemCandidate.matteSurface ?? null,
				foldBagGarment: itemCandidate.foldBagGarment ?? null,
				manualEstimatedHours: itemCandidate.manualEstimatedHours ?? null,
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
 * `LineItem` rows at needs_review (decorations, OTHER rows, and relabel / hang tag /
 * wovens) or blocked (matte and fold & bag, which wait on other rows) — exactly per
 * CLAUDE.md's schema notes. Decoration rows get artworkApprovalStatus: APPROVED (always
 * considered done); other rows leave it null. Nothing here is schedulable yet: that gate
 * is confirm_import.
 *
 * @throws ZodError if any candidate fails orderCandidateSchema — checked before anything
 *         is written, and the whole import runs in one transaction.
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
				// deadline is a z.iso.date() string ("YYYY-MM-DD") — Prisma's runtime
				// validation, unlike its TS types, rejects a date-only string and needs a
				// real Date. May be null (no Deadline in the export) — the order page asks
				// for it. deadlineIsTight defaults true for imports (a Hoops Deadline is
				// always a customer-promised date); flip on the order page for internal targets.
				deadline: orderCandidate.deadline ? new Date(orderCandidate.deadline) : null,
				deadlineIsTight: orderCandidate.deadlineIsTight,
				status: OrderStatus.NEEDS_REVIEW,
				// Assumed (2026-10-02): blanks are ordered and the customer has signed off.
				// Neither is asked about or gates scheduling; both stay editable on the
				// order page for the record.
				blankOrderingStatus: BlankOrderingStatus.ORDERED,
				customerApprovalStatus: CustomerApprovalStatus.APPROVED,
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
			// This order's own flags: the extraction's, plus any the import adds while
			// creating line items ("1 color assumed", "matte not linked"). All of them go
			// into the audit entry below, which is where the order page reads them from.
			const orderFlags = [...(orderCandidate.confidenceFlags ?? [])];
			const createdLineItems = await createLineItemsForOrder(tx, order.id, orderCandidate.lineItems, orderFlags);
			lineItems.push(...createdLineItems);
			confidenceFlags.push(...orderFlags);

			await tx.domainAuditLog.create({
				data: {
					entity: 'Order',
					entityId: order.id,
					action: auditAction,
					actor: orderCandidate.importedBy,
					diff: {
						hoopsOrderId: orderCandidate.hoopsOrderId,
						lineItemCount: orderCandidate.lineItems.length,
						confidenceFlags: orderFlags
					}
				}
			});
		}
	});

	return { orderIds, lineItems, confidenceFlags };
}
