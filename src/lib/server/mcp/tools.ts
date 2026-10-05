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
import {
	getStaffing,
	getStaffingSchema,
	setWorkerAvailability,
	setWorkerAvailabilitySchema,
	setWorkerStation,
	setWorkerStationSchema
} from '$lib/server/schedule/staffing';

/**
 * The tools this deployment exposes over MCP. Both entry points import this list
 * (src/mcp-server/index.ts and src/routes/api/mcp/+server.ts), so adding a tool here
 * adds it everywhere.
 *
 * Rules for every tool, enforced by review rather than by the type system:
 *  - Set `readOnly` truthfully (see McpToolDefinition in mcp/handler.ts). Read-only is
 *    the default expectation; `readOnly: false` is an approved, scoped exception for the
 *    write-tools below (import_hoops_export, confirm_import, add_order_note,
 *    propose_schedule, commit_schedule, set_worker_availability, set_worker_station) —
 *    each sits behind its own scope (IMPORT_WRITE or SCHEDULE_WRITE). All but
 *    commit_schedule write data that's still human-editable/reversible afterward or is
 *    only a draft; commit_schedule is itself the human schedule-approval gate. Never a
 *    bare irreversible write. See CLAUDE.md's Security constraints section for the
 *    decision record.
 *  - The `description` strings are sent to Claude verbatim as the tool descriptions —
 *    they are prompt text, not documentation. Change them deliberately, and connected
 *    clients only see the change after they reconnect.
 *  - Parameterized queries only. Prisma's query builder does this; `$queryRaw` must use
 *    tagged-template parameters, never string interpolation.
 *  - Validate input with the Zod shape; the handler receives the parsed object.
 *  - Never return secrets, raw upstream payloads, or another user's private data.
 *
 * These are the tools in CLAUDE.md's "Domain MCP tools" table. import_hoops_export and
 * confirm_import are the persistence half of the Hoops import feature
 * (src/lib/server/hoops/). import_hoops_export takes already-structured order/line-item
 * data, not a raw file — the web upload's PDF extraction (hoops/extractOrderFromPdf.ts)
 * is not exposed over MCP. get_schedule/propose_schedule/commit_schedule/simulate_change
 * wrap the deterministic engine (src/lib/server/engine/) plus the schedule persistence
 * layer (src/lib/server/schedule/) — Claude never computes hours or a schedule itself,
 * only calls these. add_order_note (added 2026-09-18) lets a note given in
 * conversation reach Order.notes (and from there, the order's page and Reports)
 * without requiring the web form — same field, no separate write path. The three
 * staffing tools (2026-09-28) are documented at their section below.
 */

// A plain `readonly McpToolDefinition[]` annotation on the array below would force every
// element to the same (default, unconstrained) Shape, widening each handler's `input` to
// an effectively untyped record — defeating the point of a per-tool Zod inputSchema. This
// identity helper lets each tool literal be checked against its own inputSchema's inferred
// shape first, then only widens to the common McpToolDefinition afterward.
function defineTool<Shape extends z.ZodRawShape>(tool: McpToolDefinition<Shape>): McpToolDefinition {
	return tool as unknown as McpToolDefinition;
}

/** Every tool this MCP server registers. Each tool's `principal` argument (when used)
 *  only feeds principalIdentity() for attribution — the scope check already happened in
 *  handler.ts before the handler runs. */
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
			"optionally for one station. Example question: 'what's running on Screen Print Auto 1 next week?' → " +
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
	}),
	// ─── Daily staffing (2026-09-28) ───────────────────────────────────────────
	// The deterministic engine picks each day's crew (engine/planStaffing.ts). These let
	// a person tell Claude about organic changes — someone out, someone moved — which the
	// next proposed schedule takes into account. None of them changes an approved
	// schedule by itself; a new plan still has to be proposed and approved by a person.
	defineTool({
		name: 'get_staffing',
		description:
			"Shows who works where: the roster with each person's certified stations, who is out, who is pinned to a " +
			"station, and the crew on each station/day of the approved schedule. Example question: 'who's on the " +
			"autos Tuesday?' → { from: '2026-10-06', to: '2026-10-06' }. Returns { roster, out, pinned, approvedCrews }.",
		inputSchema: getStaffingSchema.shape,
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async (input) => getStaffing(input)
	}),
	defineTool({
		name: 'set_worker_availability',
		description:
			'Marks a person out (available: false) or back in (available: true) for one or more days, by name. ' +
			'The next proposed schedule will not staff them on those days. Returns the approved jobs they were on ' +
			'those days — tell the user, and offer to propose an updated schedule for them to approve. Only the ' +
			"given days are affected. Example: 'Maria is out today' → { workerName: 'Maria', from: '<today>', to: " +
			"'<today>', available: false, reason: 'sick' }.",
		inputSchema: setWorkerAvailabilitySchema.shape,
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async (input, principal) => setWorkerAvailability(input, principalIdentity(principal))
	}),
	defineTool({
		name: 'set_worker_station',
		description:
			'Pins a person to one station for one day, by name — the staffing plan keeps them there and places ' +
			'everyone else around them. They must be certified on that station and not marked out. Omit ' +
			"stationName (or pass null) to clear the pin. Example: 'put Jo on embroidery Thursday' → " +
			"{ workerName: 'Jo', date: '2026-10-08', stationName: 'Embroidery' }.",
		inputSchema: setWorkerStationSchema.shape,
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async (input, principal) => setWorkerStation(input, principalIdentity(principal))
	})
];
