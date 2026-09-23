import { fail } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { hasGrantedScope, requireScopePage } from '$lib/server/auth/guards';
import { summarizeOrderEstimate } from '$lib/server/engine/estimateForDisplay';
import { fetchOrderGaps } from '$lib/server/hoops/orderReadiness';
import { extractOrderFromPdf, PdfExtractionError } from '$lib/server/hoops/extractOrderFromPdf';
import { cancelOrder, CancelOrderError } from '$lib/server/hoops/cancelOrder';
import { importHoopsExport } from '$lib/server/hoops/importHoopsExport';
import type { OrderCandidate } from '$lib/server/hoops/types';
import { OrderStatus } from '../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

/**
 * Orders (provisional) — see CLAUDE.md's Known open items. Active orders only
 * (excludes the two terminal statuses, complete and cancelled);
 * `/orders/archive` is the terminal-orders view.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'ORDERS_READ', url.pathname);

	// CHANGED (2026-09-21): used to filter out just COMPLETE orders (`status: { not:
	// COMPLETE }`). Now that CANCELLED exists as a second "this order is done, stop
	// showing it here" status, we exclude both — `notIn` just means "status is none of
	// these values."
	// NEW (2026-09-21): now also selects the fields estimateHours() needs (itemType,
	// decorationType, etc.) so each order row can show "how long will this take" right
	// on the list, computed live rather than stored — see estimateForDisplay.ts for why
	// (a stored number would go stale the moment someone edits a line item's fields).
	const orders = await prisma.order.findMany({
		where: { status: { notIn: [OrderStatus.COMPLETE, OrderStatus.CANCELLED] } },
		include: {
			lineItems: {
				select: {
					id: true,
					status: true,
					itemType: true,
					decorationType: true,
					finishingStep: true,
					inkColorCount: true,
					screens: true,
					stitchCount: true,
					quantity: true,
					weightClass: true,
					garmentStyle: true,
					capConstruction: true,
					matteSurface: true,
					foldBagGarment: true
				}
			}
		},
		orderBy: { internalDueDate: 'asc' }
	});
	// NEW (2026-09-23): open-item count per order (orderGaps.ts) — drives the "N open"
	// badge on orders still in review and the "Needs re-review" flag on confirmed ones.
	const gapsByOrder = await fetchOrderGaps(orders.map((order) => order.id));

	return {
		canImport: hasGrantedScope(locals.user, 'IMPORT_WRITE'),
		// Same scope cancelOrder.ts is gated on for the per-order "Cancel order"
		// button — bulk-cancel here is that same action, just looped over a selection.
		canCancel: hasGrantedScope(locals.user, 'IMPORT_WRITE'),
		orders: orders.map((order) => ({
			id: order.id,
			hoopsOrderId: order.hoopsOrderId,
			customerName: order.customerName,
			internalDueDate: order.internalDueDate.toISOString().slice(0, 10),
			status: order.status,
			lineItemCount: order.lineItems.length,
			estimate: summarizeOrderEstimate(order.lineItems),
			blockingCount: gapsByOrder.get(order.id)?.blockingCount ?? 0
		}))
	};
};

export const actions: Actions = {
	upload: async ({ request, locals, url }) => {
		requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		const data = await request.formData();
		const files = data.getAll('files').filter((value): value is File => value instanceof File && value.size > 0);

		if (files.length === 0) return fail(400, { message: 'Choose at least one PDF.' });

		const candidates: OrderCandidate[] = [];
		const errors: string[] = [];

		for (const file of files) {
			try {
				const buffer = Buffer.from(await file.arrayBuffer());
				const candidate = await extractOrderFromPdf(buffer.toString('base64'), file.name);
				candidates.push(candidate);
			} catch (error) {
				const message = error instanceof PdfExtractionError ? error.message : `Unexpected error reading "${file.name}"`;
				errors.push(message);
			}
		}

		if (candidates.length === 0) {
			return fail(422, { message: `Nothing could be extracted. ${errors.join(' ')}` });
		}

		try {
			const result = await importHoopsExport(candidates);
			return {
				imported: result.orderIds.length,
				extractionErrors: errors
			};
		} catch (error) {
			return fail(500, { message: (error as Error).message });
		}
	},
	// Bulk version of the per-order "Cancel order" button (cancelOrder.ts) — same
	// non-destructive status-flip, same guard rails, just looped over a checkbox
	// selection instead of one order at a time. Continues past individual failures
	// (e.g. one order in the selection is already CANCELLED) rather than aborting the
	// whole batch, and reports which ones failed and why.
	cancelSelected: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		const data = await request.formData();
		const orderIds = data.getAll('orderIds').filter((value): value is string => typeof value === 'string' && value.length > 0);
		if (orderIds.length === 0) return fail(400, { message: 'Select at least one order to cancel.' });

		let cancelledCount = 0;
		const failures: string[] = [];
		for (const orderId of orderIds) {
			try {
				await cancelOrder(orderId, user.email);
				cancelledCount++;
			} catch (err) {
				const message = err instanceof CancelOrderError ? err.message : 'Could not cancel this order.';
				failures.push(`${orderId}: ${message}`);
			}
		}

		return { cancelled: cancelledCount, cancelFailures: failures };
	}
};
