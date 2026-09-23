import { z } from 'zod';
import type { McpToolDefinition } from '$lib/server/mcp/handler';
import { principalIdentity } from '$lib/server/mcp/handler';
import { importHoopsExport } from '$lib/server/hoops/importHoopsExport';
import { confirmImport } from '$lib/server/hoops/confirmImport';
import { addOrderNote } from '$lib/server/hoops/addOrderNote';
import { orderCandidateSchema, importCorrectionsSchema } from '$lib/server/hoops/types';
import { getSchedule } from '$lib/server/schedule/getSchedule';
import { proposeAndPersistSchedule } from '$lib/server/schedule/proposeAndPersistSchedule';
import { commitSchedule } from '$lib/server/schedule/commitSchedule';
import { simulateChange, simulateChangeSchema } from '$lib/server/schedule/simulateChange';

/**
 * The tools this deployment exposes over MCP. Both entry points import this list
 * (src/mcp-server/index.ts and src/routes/api/mcp/+server.ts), so adding a tool here
 * adds it everywhere.
 *
 * Rules for every tool, enforced by review rather than by the type system:
 *  - Set `readOnly` truthfully (see McpToolDefinition in mcp/handler.ts). Read-only is
 *    the default expectation; `readOnly: false` is an approved, scoped exception for the
 *    write-tools below (import_hoops_export, confirm_import, add_order_note,
 *    commit_schedule) — each sits behind its own scope, and the first three write to
 *    data that's still human-editable/reversible afterward, never a bare irreversible
 *    write. See CLAUDE.md's Security constraints section for the decision record.
 *  - Parameterized queries only. Prisma's query builder does this; `$queryRaw` must use
 *    tagged-template parameters, never string interpolation.
 *  - Validate input with the Zod shape; the handler receives the parsed object.
 *  - Never return secrets, raw upstream payloads, or another user's private data.
 *
 * The first six are CLAUDE.md's "Domain MCP tools". import_hoops_export and
 * confirm_import are the persistence half of the Hoops import feature
 * (src/lib/server/hoops/) — this repo still has no file parser (no documented Hoops
 * export format exists), so import_hoops_export takes already-structured order/line-item
 * data, not a raw file. get_schedule/propose_schedule/commit_schedule/simulate_change
 * wrap the deterministic engine (src/lib/server/engine/) plus the schedule persistence
 * layer (src/lib/server/schedule/) — Claude never computes hours or a schedule itself,
 * only calls these. add_order_note is a seventh, added later, so a note given in
 * conversation reaches Order.notes (and from there, the order's page and Reports)
 * without requiring the web form — same field, no separate write path.
 */

// A plain `readonly McpToolDefinition[]` annotation on the array below would force every
// element to the same (default, unconstrained) Shape, widening each handler's `input` to
// an effectively untyped record — defeating the point of a per-tool Zod inputSchema. This
// identity helper lets each tool literal be checked against its own inputSchema's inferred
// shape first, then only widens to the common McpToolDefinition afterward.
function defineTool<Shape extends z.ZodRawShape>(tool: McpToolDefinition<Shape>): McpToolDefinition {
	return tool as unknown as McpToolDefinition;
}

export const mcpTools: readonly McpToolDefinition[] = [
	defineTool({
		name: 'import_hoops_export',
		description:
			'Persists already-extracted Hoops order/line-item data as needs_review orders and line items ' +
			'(finishing rows start blocked). Does not parse a file — there is no documented Hoops export format ' +
			"in this repo, so extraction (reading the export) happens in conversation; this tool's input is the " +
			'already-structured result of that. Nothing here is schedulable until confirm_import locks it in. ' +
			"Example question: 'import these three orders I just read from the export' → { orders: [...] }. " +
			'Returns { orderIds, lineItems, confidenceFlags }.',
		inputSchema: {
			orders: z.array(orderCandidateSchema).min(1)
		},
		requiredScope: 'IMPORT_WRITE',
		readOnly: false,
		handler: async ({ orders }) => importHoopsExport(orders)
	}),
	defineTool({
		name: 'confirm_import',
		description:
			'Locks a Hoops import in as real once a person has checked it — the first of the two human approval ' +
			'gates. Applies any field corrections, then flips the given orders from needs_review to confirmed. ' +
			"Example question: 'looks right, confirm order ABC123' → { orderIds: ['ABC123'] }. Returns { confirmed }.",
		inputSchema: {
			orderIds: z.array(z.string()).min(1),
			corrections: importCorrectionsSchema.optional()
		},
		requiredScope: 'IMPORT_WRITE',
		readOnly: false,
		handler: async ({ orderIds, corrections }, principal) => {
			await confirmImport(orderIds, principalIdentity(principal), corrections);
			return { confirmed: orderIds };
		}
	}),
	defineTool({
		name: 'add_order_note',
		description:
			"Adds a free-text note to an order — e.g. why a job ran late — so it shows up on the order's page and " +
			'in Reports without anyone needing to open the web form. Appends a dated, attributed line rather than ' +
			"overwriting; nothing infers this automatically. Example question: 'note that 100127 ran late because " +
			"the vendor shipped blanks late' → { hoopsOrderId: '100127', note: 'Vendor shipped blanks late.' }. " +
			'Returns { orderId, notes }.',
		inputSchema: {
			hoopsOrderId: z.string().min(1),
			note: z.string().min(1)
		},
		requiredScope: 'IMPORT_WRITE',
		readOnly: false,
		handler: async ({ hoopsOrderId, note }, principal) => {
			const updated = await addOrderNote(hoopsOrderId, note, principalIdentity(principal));
			return { orderId: updated.id, notes: updated.notes };
		}
	}),
	defineTool({
		name: 'get_schedule',
		description:
			"Looks up what's currently scheduled (approved and beyond — not draft proposals) in a date range, " +
			"optionally for one station. Example question: 'what's running at screen_print_auto next week?' → " +
			"{ from: '2026-09-15', to: '2026-09-19', stationId: '...' }. Returns { assignments }.",
		inputSchema: {
			from: z.iso.date(),
			to: z.iso.date(),
			stationId: z.string().optional()
		},
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async ({ from, to, stationId }) => ({ assignments: await getSchedule({ from, to }, stationId) })
	}),
	defineTool({
		name: 'propose_schedule',
		description:
			'Builds a suggested schedule for the confirmed, needs_review backlog against open capacity in a date ' +
			'range, using the deterministic engine (due date is the hard floor, similar-setup jobs batch together, ' +
			"jobs that can't hit their due date are flagged at_risk, never silently dropped). Persists the result " +
			'as draft (status: proposed) assignments, not the live schedule — nothing is real until commit_schedule ' +
			"approves it. Example question: 'propose next week's schedule' → { from: '2026-09-15', to: '2026-09-19' }. " +
			'Returns { assignments, atRisk, reasoning }.',
		inputSchema: {
			from: z.iso.date(),
			to: z.iso.date()
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ from, to }, principal) => proposeAndPersistSchedule({ from, to }, principalIdentity(principal))
	}),
	defineTool({
		name: 'commit_schedule',
		description:
			'Makes a proposed schedule official — the second human approval gate. Flips the given proposed ' +
			"assignments to approved. Example question: 'approve those' → { assignmentIds: [...], approvedBy: 'jeff' }. " +
			'Returns { assignments }.',
		inputSchema: {
			assignmentIds: z.array(z.string()).min(1),
			approvedBy: z.string().min(1)
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ assignmentIds, approvedBy }) => ({ assignments: await commitSchedule(assignmentIds, approvedBy) })
	}),
	defineTool({
		name: 'simulate_change',
		description:
			'Checks a "what if" against real capacity without changing anything — no write of any kind, unlike ' +
			'propose_schedule. Two supported shapes: a hypothetical rush order, or moving an existing backlog line ' +
			"item to a different due date. Example question: 'can we get a 500-unit rush order out by Friday?' → " +
			"{ change: { type: 'rush_order', lineItem: {...}, range: {...} } }. Returns { assignments, atRisk, reasoning }.",
		inputSchema: {
			change: simulateChangeSchema
		},
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async ({ change }) => simulateChange(change)
	})
];
