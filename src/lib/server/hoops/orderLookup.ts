/**
 * Read-only order lookups for Claude (2026-10-05): the `list_orders` and `get_order` MCP
 * tools. They show Claude the same thing the Orders pages show a person: each order's
 * status, its open questions (the same computeOrderGaps the order page and the confirm
 * gate use), its jobs with their hour estimates, and where each job is scheduled. That
 * lets Claude walk someone through a just-imported rush order — "what's missing?",
 * answer it, confirm — without the web form. Nothing here writes.
 */
import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { OrderStatus, ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';
import { estimateForDisplay, summarizeOrderEstimate } from '$lib/server/engine/estimateForDisplay';
import { computeOrderGaps } from './orderGaps';
import { fetchOrderGaps } from './orderReadiness';

/** A refusal written for the person asking — passed to Claude as-is. */
export class OrderLookupError extends McpUserError {
	constructor(message: string) {
		super(message);
		this.name = 'OrderLookupError';
	}
}

/** The `list_orders` tool's input. With no status, lists every order still in play. */
export const listOrdersSchema = z.object({
	status: z.enum(['needs_review', 'confirmed', 'scheduled', 'in_production', 'complete', 'cancelled']).optional(),
	// Case-insensitive match on the Hoops job number or the customer's name.
	search: z.string().trim().min(1).max(100).optional(),
	limit: z.number().int().min(1).max(100).default(50)
});

/** Orders that aren't finished or cancelled — the default list, same as /orders. */
const ACTIVE_STATUSES = [OrderStatus.NEEDS_REVIEW, OrderStatus.CONFIRMED, OrderStatus.SCHEDULED, OrderStatus.IN_PRODUCTION];

function iso(date: Date | null): string | null {
	return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Lists orders with what each still needs. `needsReReview` is a confirmed order that
 * has stopped being valid (the Orders page's "Needs re-review" badge).
 */
export async function listOrders(input: z.infer<typeof listOrdersSchema>) {
	const orders = await prisma.order.findMany({
		where: {
			status: input.status ? (input.status.toUpperCase() as OrderStatus) : { in: ACTIVE_STATUSES },
			...(input.search
				? { OR: [{ hoopsOrderId: { contains: input.search, mode: 'insensitive' } }, { customerName: { contains: input.search, mode: 'insensitive' } }] }
				: {})
		},
		orderBy: [{ deadline: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
		take: input.limit,
		select: { id: true, hoopsOrderId: true, customerName: true, status: true, deadline: true, deadlineIsTight: true, lineItems: true }
	});
	const gaps = await fetchOrderGaps(orders.map((order) => order.id));

	return {
		orders: orders.map((order) => {
			const orderGaps = gaps.get(order.id);
			const openItems = orderGaps?.blockingCount ?? 0;
			const estimate = summarizeOrderEstimate(order.lineItems);
			return {
				hoopsOrderId: order.hoopsOrderId,
				customerName: order.customerName,
				status: order.status.toLowerCase(),
				deadline: iso(order.deadline),
				deadlineIsTight: order.deadlineIsTight,
				jobCount: order.lineItems.length,
				estimatedHours: Math.round(estimate.totalHours * 100) / 100,
				openItems,
				needsReReview: order.status === OrderStatus.CONFIRMED && openItems > 0
			};
		})
	};
}

/** The `get_order` tool's input: the Hoops job number, which is what people say. */
export const getOrderSchema = z.object({ hoopsOrderId: z.string().trim().min(1) });

/**
 * One order in full: its jobs (with ids for confirm_import corrections), each job's
 * estimate, the open questions a person must answer before it can be confirmed,
 * import notes, and every non-draft schedule slot its jobs have.
 *
 * @throws OrderLookupError when there's no order with that job number
 */
export async function getOrder(input: z.infer<typeof getOrderSchema>) {
	const order = await prisma.order.findFirst({
		where: { hoopsOrderId: input.hoopsOrderId },
		include: { lineItems: { orderBy: { id: 'asc' } } }
	});
	if (!order) throw new OrderLookupError(`There's no order with job number ${input.hoopsOrderId}.`);

	const [lastImportLog, assignments] = await Promise.all([
		prisma.domainAuditLog.findFirst({
			where: { entity: 'Order', entityId: order.id, action: { in: ['hoops_import_created', 'hoops_import_reopened'] } },
			orderBy: { at: 'desc' }
		}),
		prisma.scheduleAssignment.findMany({
			where: { lineItemId: { in: order.lineItems.map((item) => item.id) }, status: { not: ScheduleAssignmentStatus.PROPOSED } },
			include: { station: { select: { label: true } } },
			orderBy: [{ date: 'asc' }, { sequenceOrder: 'asc' }]
		})
	]);
	const importFlags = ((lastImportLog?.diff as { confidenceFlags?: string[] } | null)?.confidenceFlags ?? []) as string[];
	const gaps = computeOrderGaps(
		{ deadline: order.deadline, blankOrderingStatus: order.blankOrderingStatus, customerApprovalStatus: order.customerApprovalStatus, importFlags },
		order.lineItems
	);

	return {
		hoopsOrderId: order.hoopsOrderId,
		orderId: order.id,
		customerName: order.customerName,
		status: order.status.toLowerCase(),
		deadline: iso(order.deadline),
		deadlineIsTight: order.deadlineIsTight,
		notes: order.notes,
		canConfirm: order.status === OrderStatus.NEEDS_REVIEW && gaps.blockingCount === 0,
		openQuestions: gaps.questions.map((question) => ({ question: question.question, answersField: question.target })),
		importNotes: gaps.infoNotes,
		jobs: order.lineItems.map((item) => {
			const estimate = estimateForDisplay(item);
			return {
				lineItemId: item.id,
				type: (item.decorationType ?? item.finishingStep ?? item.otherJobType ?? item.itemType).toLowerCase(),
				design: item.design,
				printLocation: item.printLocation,
				quantity: item.quantity,
				status: item.status.toLowerCase(),
				estimate: estimate.ok ? { hours: Math.round(estimate.hours * 100) / 100, station: estimate.station } : { missing: estimate.reason }
			};
		}),
		schedule: assignments.map((row) => ({
			lineItemId: row.lineItemId,
			station: row.station.label,
			date: iso(row.date),
			status: row.status.toLowerCase(),
			estimatedHours: row.estimatedHours
		}))
	};
}
