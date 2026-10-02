import { prisma } from '$lib/server/prisma';
import { requireScopePage } from '$lib/server/auth/guards';
import { OrderStatus } from '../../../../prisma/generated/prisma/enums';
import type { PageServerLoad } from './$types';

/**
 * Read-only terminal-orders view — CLAUDE.md's "no new archiving logic" instruction:
 * this is a filtered view, not a separate data path. Covers both terminal statuses:
 * complete (only ever reached via check_completion,
 * src/lib/server/engine/checkCompletion.ts) and cancelled (cancelOrder.ts's
 * non-destructive "delete" — status only, no rows removed).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'ORDERS_READ', url.pathname);

	// CHANGED (2026-09-21): used to only fetch COMPLETE orders. Now also includes
	// CANCELLED ones, so a cancelled order still shows up SOMEWHERE (just not in the
	// active list) instead of effectively vanishing.
	const orders = await prisma.order.findMany({
		where: { status: { in: [OrderStatus.COMPLETE, OrderStatus.CANCELLED] } },
		include: { lineItems: { select: { id: true } } },
		orderBy: { deadline: 'desc' }
	});

	return {
		orders: orders.map((order) => ({
			id: order.id,
			hoopsOrderId: order.hoopsOrderId,
			customerName: order.customerName,
			// Null until a deadline is entered (export had no Deadline).
			deadline: order.deadline?.toISOString().slice(0, 10) ?? null,
			deadlineIsTight: order.deadlineIsTight,
			// NEW (2026-09-21): now that this page shows two different statuses instead
			// of just COMPLETE, we need to actually pass the status through so the page
			// can show which one each order is.
			status: order.status,
			lineItemCount: order.lineItems.length
		}))
	};
};
