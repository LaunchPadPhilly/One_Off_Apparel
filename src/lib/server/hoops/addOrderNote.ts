import { prisma } from '$lib/server/prisma';

/**
 * Lets a note reach an order through conversation with Claude, not just the Orders
 * page's textarea — e.g. Nate or Toby telling Claude "order 100127 ran late because the
 * vendor shipped blanks late" should actually land in Order.notes, the same field
 * /reports and the order's page both already read. No separate write path (see
 * CLAUDE.md's "What this system is").
 *
 * Takes `hoopsOrderId` (the "Job <number>" people actually say), not the internal id —
 * a chat participant doesn't know or care about the database id.
 *
 * Appends a dated, attributed line rather than overwriting: a person editing the
 * textarea directly is rewriting the whole field on purpose, but a note added through
 * conversation is one more observation stacking on whatever's already there — losing
 * an earlier note because a later one overwrote it would be the wrong default.
 */
export async function addOrderNote(hoopsOrderId: string, note: string, actor: string) {
	return prisma.$transaction(async (tx) => {
		const order = await tx.order.findUnique({ where: { hoopsOrderId } });
		if (!order) throw new Error(`add_order_note: no order with hoopsOrderId "${hoopsOrderId}"`);

		const entry = `[${new Date().toISOString().slice(0, 10)} ${actor}] ${note}`;
		const notes = order.notes ? `${order.notes}\n${entry}` : entry;

		const updated = await tx.order.update({ where: { id: order.id }, data: { notes } });

		await tx.domainAuditLog.create({
			data: { entity: 'Order', entityId: order.id, action: 'order_note_added', actor, diff: { note } }
		});

		return updated;
	});
}
