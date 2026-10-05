import { z } from 'zod';
import type { McpToolDefinition } from '$lib/server/mcp/handler';
import { principalIdentity } from '$lib/server/mcp/handler';
import { importHoopsExport } from '$lib/server/hoops/importHoopsExport';
import { confirmImport } from '$lib/server/hoops/confirmImport';
import { addOrderNote } from '$lib/server/hoops/addOrderNote';
import { orderCandidateSchema, importCorrectionsSchema } from '$lib/server/hoops/types';
import { getSchedule } from '$lib/server/schedule/getSchedule';
import { proposeAndPersistSchedule } from '$lib/server/schedule/proposeAndPersistSchedule';
import { commitDraft, commitSchedule, CommitScheduleError } from '$lib/server/schedule/commitSchedule';
import { HOOPS_EXTRACTION_RULES } from '$lib/server/hoops/extractionRules';
import { getOrder, getOrderSchema, listOrders, listOrdersSchema } from '$lib/server/hoops/orderLookup';
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
			'Saves orders read from Hoops "Job" PDFs as needs_review orders. When someone drops a PDF into the chat, ' +
			'read it yourself and send what you read here, one entry per PDF; this tool does not take the file. ' +
			"Nothing here is schedulable until a person confirms it (confirm_import). Afterwards, call get_order to " +
			"see the order's open questions, ask the person, and confirm. If it's a rush, then call " +
			'propose_schedule with replanFrom/replanTo so not-started jobs can move to make room. ' +
			"Example: 'here's a rush order' + PDF → { orders: [{ hoopsOrderId: '100157', ... }] }. " +
			'Returns { orderIds, lineItems, confidenceFlags }.' +
			'\n\nHow to read a Hoops Job PDF:\n' +
			HOOPS_EXTRACTION_RULES,
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
			'Builds a suggested schedule with the deterministic engine and saves it as a draft on the board ' +
			'(Schedule page) — it does not change the live schedule. Started work never moves, and by default nothing ' +
			'already approved moves either: only new work is placed around it. Pass replanFrom/replanTo to let ' +
			'approved, not-started jobs dated in that window move: for a rush order use the whole from–to window; ' +
			'when someone is out use just the days they are out (their jobs move to the next open slots, by due ' +
			'date). Due date is the hard floor; jobs that cannot make it are flagged at risk, never dropped. Show the ' +
			'person `changes` (new / moved / kept_at_risk) and `atRisk`, and link `draftPath`; nothing is real until ' +
			"they approve it (commit_schedule with the draftId, or Approve on the board). At most 28 days. Example: " +
			"'Maria is out Tuesday, fix the schedule' → { from: '2026-10-06', to: '2026-11-02', replanFrom: " +
			"'2026-10-06', replanTo: '2026-10-06', reason: 'Maria out Tue' }. Returns { draftId, draftPath, " +
			'assignmentIds, placedCount, atRisk, changes, reasoning }.',
		inputSchema: {
			from: z.iso.date(),
			to: z.iso.date(),
			// Approved, not-started jobs dated in this window may move. Omit both to move nothing.
			replanFrom: z.iso.date().optional(),
			replanTo: z.iso.date().optional(),
			// A few words on why, used as the draft's name on the board (e.g. "Rush 100157").
			reason: z.string().max(80).optional()
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ from, to, replanFrom, replanTo, reason }, principal) => {
			if ((replanFrom === undefined) !== (replanTo === undefined)) {
				throw new CommitScheduleError('Give both replanFrom and replanTo, or neither.');
			}
			const release = replanFrom && replanTo ? { from: replanFrom, to: replanTo } : null;
			return proposeAndPersistSchedule({ from, to }, principalIdentity(principal), release, reason);
		}
	}),
	defineTool({
		name: 'commit_schedule',
		description:
			'Makes a proposed schedule official — the second human approval gate. Only call it after the person has ' +
			'clearly said to approve. Pass the draftId from propose_schedule to approve the whole plan, or ' +
			'assignmentIds to approve some of it. Each approved job replaces its old not-started slot, so a moved ' +
			"job is never on the schedule twice. Refused if a job in the plan has started since. Example: 'approve " +
			"it' → { draftId: '...', approvedBy: 'Jeff' }. Returns { assignments, replacedCount }.",
		inputSchema: {
			draftId: z.string().min(1).optional(),
			assignmentIds: z.array(z.string()).min(1).optional(),
			// The person who approved, as they'd be named on the board.
			approvedBy: z.string().min(1)
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ draftId, assignmentIds, approvedBy }) => {
			if ((draftId === undefined) === (assignmentIds === undefined)) {
				throw new CommitScheduleError('Give either a draftId or assignmentIds (not both).');
			}
			return draftId ? commitDraft(draftId, approvedBy) : commitSchedule(assignmentIds ?? [], approvedBy);
		}
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
	// ─── Order lookups (2026-10-05) ────────────────────────────────────────────
	// Read-only, so Claude can walk someone through an order in chat: what's open,
	// what's missing, what's scheduled (hoops/orderLookup.ts).
	defineTool({
		name: 'list_orders',
		description:
			'Lists orders with what each still needs: status, deadline, number of jobs, estimated hours, how many open ' +
			'items block confirming it, and needsReReview (confirmed but no longer valid). By default only orders still ' +
			"in play; filter by status or search by job number / customer. Example: 'what still needs review?' → " +
			"{ status: 'needs_review' }. Returns { orders }.",
		inputSchema: listOrdersSchema.shape,
		requiredScope: 'ORDERS_READ',
		readOnly: true,
		handler: async (input) => listOrders(listOrdersSchema.parse(input))
	}),
	defineTool({
		name: 'get_order',
		description:
			'One order in full, by Hoops job number: its jobs (lineItemId, type, quantity, hour estimate or what the ' +
			'estimate is missing), the openQuestions a person must answer before it can be confirmed (each names the ' +
			'field it answers, for confirm_import corrections), import notes, and where its jobs are scheduled. ' +
			"Ask the person the open questions in plain words; don't guess answers. Example: 'what's missing on " +
			"100157?' → { hoopsOrderId: '100157' }.",
		inputSchema: getOrderSchema.shape,
		requiredScope: 'ORDERS_READ',
		readOnly: true,
		handler: async (input) => getOrder(input)
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
			'those days — tell the user, and offer to fix the schedule: propose_schedule with replanFrom/replanTo set ' +
			'to exactly the days they are out, so only the jobs on those days move. Only the ' +
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
