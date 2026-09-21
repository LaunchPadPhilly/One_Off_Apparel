import { prisma } from '$lib/server/prisma';
import { LineItemStatus, OrderStatus, ScheduleAssignmentStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Reports (minimal, per CLAUDE.md's explicit request to propose metrics rather than
 * invent them). Everything here is backed by data the schema already has —
 * `actuals` vs `estimated_hours` is the one comparison the schema's own doc comment
 * calls out as the point of the actuals table.
 *
 * `Actual` has no foreign key back to the `ScheduleAssignment` it came from (see
 * prisma/schema.prisma) — they're matched here by (lineItemId, stationId,
 * completedAt), which is exact because stopAssignment.ts writes both with the same
 * completedAt in the same transaction. If that invariant ever changes, this join
 * breaks silently — worth a real foreign key if reporting matters long-term.
 *
 * Explicitly NOT included: a historical "at risk" trend. propose_schedule's
 * flag_at_risk results are returned to the caller but never persisted anywhere (see
 * CLAUDE.md) — building that is new persistence, not a report query, so it isn't
 * silently added here.
 */
export async function getReportData(range: { from: string; to: string }) {
	const from = new Date(range.from);
	const to = new Date(range.to);

	const completedAssignments = await prisma.scheduleAssignment.findMany({
		where: { status: ScheduleAssignmentStatus.COMPLETE, completedAt: { gte: from, lte: to } },
		include: { lineItem: { select: { design: true } }, station: { select: { id: true, name: true } } }
	});

	const actuals = await prisma.actual.findMany({ where: { completedAt: { gte: from, lte: to } } });
	const actualKey = (lineItemId: string, stationId: string, completedAt: Date) => `${lineItemId}__${stationId}__${completedAt.getTime()}`;
	const actualsByKey = new Map(actuals.map((actual) => [actualKey(actual.lineItemId, actual.stationId, actual.completedAt), actual]));

	const lineItemVariance = completedAssignments
		.map((assignment) => {
			const actual = assignment.completedAt && actualsByKey.get(actualKey(assignment.lineItemId, assignment.stationId, assignment.completedAt));
			if (!actual) return null;
			return {
				lineItemId: assignment.lineItemId,
				design: assignment.lineItem.design,
				stationName: assignment.station.name,
				estimatedHours: assignment.estimatedHours,
				actualHours: actual.actualHours,
				varianceHours: actual.actualHours - assignment.estimatedHours
			};
		})
		.filter((row): row is NonNullable<typeof row> => row !== null)
		.sort((a, b) => Math.abs(b.varianceHours) - Math.abs(a.varianceHours));

	const perStation = new Map<string, { stationName: string; estimatedHours: number; actualHours: number }>();
	for (const row of lineItemVariance) {
		const existing = perStation.get(row.stationName) ?? { stationName: row.stationName, estimatedHours: 0, actualHours: 0 };
		existing.estimatedHours += row.estimatedHours;
		existing.actualHours += row.actualHours;
		perStation.set(row.stationName, existing);
	}

	const completedOrders = await prisma.order.findMany({
		where: { status: OrderStatus.COMPLETE, internalDueDate: { gte: from, lte: to } },
		include: { lineItems: { select: { id: true } } }
	});
	const onTimeResults = await Promise.all(
		completedOrders.map(async (order) => {
			const lastCompleted = await prisma.scheduleAssignment.findFirst({
				where: { lineItem: { orderId: order.id } },
				orderBy: { completedAt: 'desc' },
				select: { completedAt: true }
			});
			const onTime = !lastCompleted?.completedAt || lastCompleted.completedAt <= order.internalDueDate;
			return {
				orderId: order.id,
				hoopsOrderId: order.hoopsOrderId,
				dueDate: order.internalDueDate,
				completedAt: lastCompleted?.completedAt ?? null,
				onTime,
				notes: order.notes
			};
		})
	);

	const blockedCount = await prisma.lineItem.count({ where: { status: LineItemStatus.BLOCKED } });

	const recentChanges = await prisma.domainAuditLog.findMany({
		where: { at: { gte: from, lte: to } },
		orderBy: { at: 'desc' },
		take: 50
	});

	return {
		perStation: [...perStation.values()],
		lineItemVariance,
		onTime: {
			total: onTimeResults.length,
			onTimeCount: onTimeResults.filter((r) => r.onTime).length,
			late: onTimeResults.filter((r) => !r.onTime)
		},
		blockedCount,
		recentChanges
	};
}
