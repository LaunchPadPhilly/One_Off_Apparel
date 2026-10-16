import { z } from 'zod';
import type { McpToolDefinition, Principal } from '$lib/server/mcp/handler';
import { prisma } from '$lib/server/prisma';
import { principalIdentity } from '$lib/server/mcp/handler';
import { importHoopsExport } from '$lib/server/hoops/importHoopsExport';
import { confirmImport } from '$lib/server/hoops/confirmImport';
import { addOrderNote } from '$lib/server/hoops/addOrderNote';
import { orderCandidateSchema, importCorrectionsSchema } from '$lib/server/hoops/types';
import { getSchedule } from '$lib/server/schedule/getSchedule';
import { proposeAndPersistSchedule } from '$lib/server/schedule/proposeAndPersistSchedule';
import { commitDraft, commitSchedule, CommitScheduleError } from '$lib/server/schedule/commitSchedule';
import { unapproveDraft, unapproveSchedule, UnapproveScheduleError } from '$lib/server/schedule/unapproveSchedule';
import { moveDraftAssignment, MoveDraftAssignmentError } from '$lib/server/schedule/moveDraftAssignment';
import { assertAssignmentsApprovable, assertDraftApprovable } from '$lib/server/schedule/draftProblemsServer';
import { problemsForTool } from '$lib/server/schedule/draftEdit';
import { setDraftCrew, setDraftCrewSchema, SetDraftCrewError } from '$lib/server/schedule/setDraftCrew';
import { shiftDraft, shiftDraftSchema, ShiftDraftError } from '$lib/server/schedule/shiftDraft';
import { replanDraft, replanDraftSchema, ReplanDraftError } from '$lib/server/schedule/replanDraft';
import { getDraftForTool, GetDraftError, listDraftsForTool, SHOP_SHIFT } from '$lib/server/schedule/getDraftForTool';
import { listStationsForTool } from '$lib/server/schedule/listStationsForTool';
import { resolveDraftIdOrShortCode } from '$lib/server/schedule/draftShortCode';
import { ScheduleDraftStatus } from '../../../../prisma/generated/prisma/enums';
import { HOOPS_EXTRACTION_RULES } from '$lib/server/hoops/extractionRules';
import { getOrder, getOrderSchema, listOrders, listOrdersSchema } from '$lib/server/hoops/orderLookup';
import { simulateChange, simulateChangeSchema } from '$lib/server/schedule/simulateChange';
import { changeNoteTools } from '$lib/server/mcp/changeNoteTools';
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
 *    propose_schedule, move_assignment, set_draft_crew, shift_draft, replan_draft,
 *    commit_schedule, unapprove_schedule, set_worker_availability, set_worker_station,
 *    explain_schedule_change) —
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
 * Editing a draft from chat (2026-10-16 — client: "edit the draft, don't make a new one
 * unless asked; question, advise and flag; the human is always right"): move_assignment,
 * set_draft_crew and shift_draft all take `dryRun` (check without saving: what else
 * would move, which problems it would create — draftEdit.ts) and `makeRoom` (the person
 * insists: everything else gives way and every knock-on move is listed — the board shows
 * it in a pop-up). replan_draft re-runs the engine inside the same draft. Every result
 * carries the draft's problems (draftProblems.ts, the board's red/orange); red ones block
 * commit_schedule.
 *
 * list_drafts / get_draft (added 2026-10-14) are the chat-side read tools for drafts —
 * get_schedule only sees the approved live schedule, so without these Claude has no way
 * to find a draft by name or inspect what's inside one. Both accept a draft's full cuid
 * OR its 6-char shortCode (draftShortCode.ts), and move_assignment / commit_schedule /
 * unapprove_schedule now resolve the same short code so a code read from the UI can be
 * pasted straight into any write-side draft tool.
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
/**
 * Who approved, for commit_schedule (2026-10-05). A person signed in through Claude
 * (OAuth) is recorded as their own account, whatever name the call passes — so the
 * schedule-approval gate's audit trail can't be pointed at someone else. A shared token
 * (agent or legacy) has no person behind it, so the given name is kept but marked with
 * the token it came through.
 */
async function approverFor(principal: Principal, givenName: string | undefined): Promise<string> {
	if (principal.kind === 'oauth') {
		const user = await prisma.user.findUnique({ where: { id: principal.userId }, select: { email: true } });
		return user?.email ?? principal.userId;
	}
	if (!givenName) throw new CommitScheduleError('Say who approved this plan (approvedBy).');
	return `${givenName} (via ${principalIdentity(principal)})`;
}

function defineTool<Shape extends z.ZodRawShape>(tool: McpToolDefinition<Shape>): McpToolDefinition {
	return tool as unknown as McpToolDefinition;
}

/**
 * Resolves a draft id or 6-char short code (as returned by list_drafts / get_draft) to a
 * full id, so every write-side draft tool — move_assignment, commit_schedule,
 * unapprove_schedule — accepts whichever one the person has in hand. Throws a user-facing
 * error on miss or ambiguity, matching each caller's own error class.
 */
async function resolveDraftIdForTool<E extends Error>(idOrCode: string, ErrorClass: new (message: string) => E): Promise<string> {
	const resolved = await resolveDraftIdOrShortCode(idOrCode);
	if (resolved === null) throw new ErrorClass(`No schedule draft matches "${idOrCode}". Try list_drafts.`);
	if (resolved === 'AMBIGUOUS') throw new ErrorClass(`Short code "${idOrCode}" matches more than one draft; use the full id from list_drafts.`);
	return resolved;
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
			"orderIds are Hoops job numbers (or internal ids). Refused while the order has open questions " +
			"(get_order's openQuestions) — answer them through `corrections` (each question names its field), never " +
			"by guessing; an order that still can't be estimated stays in review. Example question: 'looks right, " +
			"confirm 100157' → { orderIds: ['100157'] }. Returns { confirmed }.",
		inputSchema: {
			orderIds: z.array(z.string()).min(1),
			corrections: importCorrectionsSchema.optional()
		},
		requiredScope: 'IMPORT_WRITE',
		readOnly: false,
		handler: async ({ orderIds, corrections }, principal) => {
			// Accept the Hoops job number (what people say, and what get_order / list_orders
			// use) as well as the internal id — the example above always used job numbers.
			const byJob = await prisma.order.findMany({ where: { hoopsOrderId: { in: orderIds } }, select: { id: true, hoopsOrderId: true } });
			const idOf = new Map(byJob.map((o) => [o.hoopsOrderId, o.id]));
			const ids = orderIds.map((value) => idOf.get(value) ?? value);
			await confirmImport(ids, principalIdentity(principal), corrections);
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
			"CREATES A NEW DRAFT — call this only when the person asks for a new schedule (\"create an automatic " +
			"schedule\", \"make a new plan\") and no draft for that work exists yet, or they explicitly ask for a new " +
			"one. For ANY change to a draft that already exists — tweak, re-order, buffer, re-time, move days, change " +
			"people, someone out, an order added — do NOT call propose_schedule: find it with list_drafts (or the " +
			"6-char short code on the board), read it with get_draft, then edit it in place with move_assignment, " +
			"set_draft_crew, shift_draft, or replan_draft (re-plans inside the same draft). To change the APPROVED " +
			"schedule, reopen its draft with unapprove_schedule (after the person agrees) and edit that draft. " +
			"Re-proposing creates a sibling draft and strands the one they were editing.\n\nWhen a NEW plan is what's wanted: builds a suggested schedule with the deterministic " +
			"engine and saves it as a new draft on the board (Schedule page) — it does not change the live schedule. " +
			'Started work never moves, and by default nothing already approved moves either: only new work is placed ' +
			'around it. Pass replanFrom/replanTo to let approved, not-started jobs dated in that window move: for a ' +
			'rush order use the whole from–to window; when someone is out use just the days they are out (their jobs ' +
			'move to the next open slots, by due date). Due date is the hard floor; jobs that cannot make it are ' +
			'flagged at risk, never dropped. Show the person `changes` (new / moved / kept_at_risk) and `atRisk`, and ' +
			"link `draftPath`; nothing is real until they approve it (commit_schedule with the draftId, or Approve on " +
			"the board). At most 28 days. Example: 'create the automatic schedule for the next 4 weeks' → { from: " +
			"'2026-10-19', to: '2026-11-15', reason: 'Next 4 weeks' }. Orders are " +
			"all-or-nothing: one that can't fully fit is left off the plan and listed in `unscheduledOrders` with a " +
			'plain reason (also shown as a red flag on the Orders page) — tell the person which ones and why; orders ' +
			'needing re-review are never planned. Returns { draftId, draftPath, assignmentIds, placedCount, atRisk, ' +
			'unscheduledOrders, changes, reasoning }.',
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
			"job is never on the schedule twice. Refused if a job in the plan has started since, and refused while the " +
			"draft has any red (blocking) problem — overlaps, past the end of the shift, a finishing step before its " +
			"print, a station with nobody on it, a press with no main, a person on two stations or out, late for a firm " +
			"deadline, an order only partly placed (get_draft lists them). Tell the person what's wrong and offer fixes; " +
			"never approve around them. Example: 'approve " +
			"it' → { draftId: '...' }. The approver is recorded as the signed-in person. Returns { assignments, replacedCount }.",
		inputSchema: {
			draftId: z.string().min(1).optional(),
			assignmentIds: z.array(z.string()).min(1).optional(),
			// Who approved. Ignored for people signed in through Claude (their own account
			// is recorded); required when calling with a shared token.
			approvedBy: z.string().min(1).optional()
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ draftId, assignmentIds, approvedBy }, principal) => {
			if ((draftId === undefined) === (assignmentIds === undefined)) {
				throw new CommitScheduleError('Give either a draftId or assignmentIds (not both).');
			}
			const approver = await approverFor(principal, approvedBy);
			if (draftId) {
				const resolvedId = await resolveDraftIdForTool(draftId, CommitScheduleError);
				await assertDraftApprovable(resolvedId);
				return commitDraft(resolvedId, approver);
			}
			await assertAssignmentsApprovable(assignmentIds ?? []);
			return commitSchedule(assignmentIds ?? [], approver);
		}
	}),
	defineTool({
		name: 'unapprove_schedule',
		description:
			"Reverses commit_schedule — flips APPROVED jobs back to PROPOSED so they can be moved with " +
			"move_assignment or re-approved after edits. The recovery path when a plan was approved too early " +
			"and someone wants to adjust it without re-running propose_schedule. Only approved, not-started jobs " +
			"can be unapproved; a job that has already started (IN_PROGRESS) or finished (COMPLETE) is refused — " +
			"those have already happened on the floor and must not be rewound. Pass draftId to unapprove every " +
			"approved, not-started job in one draft (its status rolls back from APPROVED to DRAFT so the board " +
			"treats it as editable again), or assignmentIds to unapprove a specific set. Known limit: commit " +
			"deletes a job's prior approved slot when it supersedes it, and those deleted slots are not restored " +
			"here — the unapproved rows return as PROPOSED on their own; re-propose if the prior slot mattered. " +
			"Example: 'actually, unapprove that whole plan I just approved' → { draftId: '...' }. Returns " +
			"{ assignments, draftsReopened, skipped? }.",
		inputSchema: {
			draftId: z.string().min(1).optional(),
			assignmentIds: z.array(z.string()).min(1).optional()
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ draftId, assignmentIds }, principal) => {
			if ((draftId === undefined) === (assignmentIds === undefined)) {
				throw new UnapproveScheduleError('Give either a draftId or assignmentIds (not both).');
			}
			const actor = principalIdentity(principal);
			if (draftId) {
				const resolvedId = await resolveDraftIdForTool(draftId, UnapproveScheduleError);
				return unapproveDraft(resolvedId, actor);
			}
			return unapproveSchedule(assignmentIds ?? [], actor);
		}
	}),
	defineTool({
		name: 'list_stations',
		description:
			"Lists every station on the shop floor with the two values a drag-and-drop or move_assignment " +
			"actually compares: `label` (what people see) and `kind` (which estimate_hours formula it runs — " +
			"the real gate). Diagnostic for \"why can't I drag this screen-print job onto Screen Print Manual?\" " +
			"problems: a station's kind must equal the line item's expected kind, so a Manual press labeled " +
			"\"Screen Print Manual\" is only draggable from an auto press if its kind is `screen_print_auto` too " +
			"(both share one kind by design — client decision 2026-09-25, same time assumption). An entry with " +
			"`kindIsRecognized: false` is misconfigured (likely a legacy station from before admin-managed " +
			"stations, backfilled with `kind = name`); every job will be refused on it until an admin archives " +
			"and re-creates it with the right kind in Settings → Stations. `hasUnrecognizedKinds: true` on the " +
			"result means at least one such station exists on this shop. Example question: \"why does the manual " +
			"press reject screen-print jobs?\" → {}. Returns { stations, hasUnrecognizedKinds }.",
		inputSchema: {
			// Set true to also return archived stations (for diagnosing a station that was already
			// archived — e.g. "did someone archive the DTG press?"). Default false.
			includeArchived: z.boolean().optional()
		},
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async ({ includeArchived }) => listStationsForTool(includeArchived ?? false)
	}),
	defineTool({
		name: 'list_drafts',
		description:
			"Lists schedule drafts on the board — every one that isn't archived, newest first — so Claude can find " +
			"the draft the person is talking about without seeing the UI. CALL THIS FIRST whenever the person refers " +
			"to \"that draft\", \"the one from today\", \"Automatic schedule — <date>\", or any existing draft they're " +
			"editing — do not create a new one with propose_schedule just because you can't see what exists. Each entry " +
			"has `id` (the full cuid used by move_assignment/commit_schedule/unapprove_schedule), `shortCode` (6 chars, " +
			"e.g. 'AB3C9F', also accepted anywhere `draftId` is), `name`, `status` (DRAFT / PROPOSED / APPROVED), " +
			"window (startDate + weeks), and counts: totalAssignments, proposedCount, approvedCount. For the draft's " +
			"actual assignments and the shop's shift timing, call get_draft next. Filter by `status` when the person " +
			"says \"the approved one\" or \"the proposed drafts\". Example: 'which drafts do we have?' → {}. Returns " +
			"{ drafts }.",
		inputSchema: {
			status: z.enum(ScheduleDraftStatus).optional()
		},
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async ({ status }) => ({ drafts: await listDraftsForTool(status), shift: SHOP_SHIFT })
	}),
	defineTool({
		name: 'get_draft',
		description:
			"Reads one schedule draft in full — the only way for Claude to see what's inside a draft, since get_schedule " +
			"only returns the approved live schedule. Pass either the full id or the 6-char shortCode from list_drafts. " +
			"Returns the draft's metadata plus every assignment in run order (date → station → sequenceOrder) with: " +
			"`id` (pass to move_assignment), `job` (readable label), `stationName` (pass to move_assignment), `date`, " +
			"`startMinuteOfDay` (minutes from midnight), `durationMinutes`, `estimatedHours`, `status`. ALSO returns " +
			"`shift`: the shop's working day — `startMinuteOfDay` (480 = 8:00 AM), `endMinuteOfDay` (990 = 4:30 PM), " +
			"and the three breaks (10:00–10:15, 12:30–13:00 lunch, 15:00–15:15) with their start minutes and durations. " +
			"USE `shift.startMinuteOfDay` AS THE DAY-OPEN BASELINE WHEN COMPUTING MOVES — do not ask the person what " +
			"time the shift starts, that's in the response. Use this before any batch move (e.g. adding a 10-minute " +
			"buffer between items) so start times come from the draft's actual current layout, not guessed. Each " +
			"assignment also has `crew` (who works it, with main / operator / catch on a press) and the order's " +
			"`orderDeadline` / `deadlineIsTight`. `problems` lists everything wrong with the draft (the board's red and " +
			"orange highlights) and `canApprove` says whether it can be approved — read them before saying a draft is " +
			"ready. Example: " +
			"'show me what's in that draft' → { draftIdOrCode: 'AB3C9F' }. Returns { draft }.",
		inputSchema: {
			draftIdOrCode: z.string().min(1)
		},
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async ({ draftIdOrCode }) => {
			try {
				return { draft: await getDraftForTool(draftIdOrCode) };
			} catch (err) {
				if (err instanceof GetDraftError) throw err;
				throw err;
			}
		}
	}),
	defineTool({
		name: 'move_assignment',
		description:
			"THE TOOL FOR EDITING A DRAFT IN PLACE — use this (not propose_schedule) whenever the person wants to " +
			"adjust jobs inside a draft that already exists: re-time a slot, re-order items in a station's queue, " +
			"add buffers between jobs, move something to another station or day. Call it once per assignment with " +
			"the new absolute `startMinuteOfDay`; peers in the day cascade to preserve gaps the same way a " +
			"drag-and-drop would.\n\nCHECK FIRST: call with dryRun: true, look at `newProblems` and `changes` (other " +
			"jobs it would move). If it creates red problems (overlap, past 4:30, late for a firm deadline, a finishing " +
			"step before its print…) don't make it — tell the person plainly why it doesn't work and suggest " +
			"alternatives. If they still want it (they're always right), call again with makeRoom: true: the job goes " +
			"exactly there and the rest of that station gives way (overlapping jobs after it, overflow to the next " +
			"working day). Then tell them every item in `changes` and any `newProblems` still left. Never use makeRoom " +
			"without the person's go-ahead.\n\nMoves one proposed job inside a draft — changes its station, its day, or its " +
			"start time without touching the live schedule. Only PROPOSED rows inside the named draft can move; an " +
			"already-approved job is refused with a clear message (unapprove_schedule if you want to move it). " +
			"Row-kind restrictions still apply: a screen-print job only lands on a screen-print station, embroidery " +
			"on an embroidery station, and so on — both the manual and auto presses share the screen-print kind, " +
			"so manual↔auto moves are allowed. `stationName` is the station's internal name (as returned by " +
			"get_draft's `assignments[].stationName` or propose_schedule's `changes[].to.station`). `date` is " +
			"YYYY-MM-DD. `startMinuteOfDay` is optional — minutes from midnight (e.g. 480 = 8:00 AM, the shop's " +
			"day-open; see get_draft's `shift` for the full timing); when omitted the assignment keeps its current " +
			"start minute. Workflow for a batch adjustment: get_draft once (reads shift + current layout), compute " +
			"the new startMinuteOfDay for each item in the sequence, call move_assignment per item. Do NOT call " +
			"propose_schedule to re-arrange an existing draft — it creates a new draft and strands the one being " +
			"edited. Example: 'move that assignment to Screen Print Auto 2 at 10:00 on 2026-10-14' → { draftId: " +
			"'...', assignmentId: '...', stationName: 'screen_print_auto_2', date: '2026-10-14', startMinuteOfDay: " +
			"600 }. Returns { id, dryRun, changes, pushedCount, canApprove, newProblems, allProblems }.",
		inputSchema: {
			draftId: z.string().min(1),
			assignmentId: z.string().min(1),
			stationName: z.string().min(1),
			date: z.iso.date(),
			// Optional: keep the current start when omitted — Claude rarely has an exact
			// wall-clock minute from the conversation and shouldn't have to guess one.
			startMinuteOfDay: z.number().int().min(0).max(24 * 60).optional(),
			// Check only: report what would change and what problems it would create, save nothing.
			dryRun: z.boolean().optional(),
			// The person insists: everything else on the station gives way (see description).
			makeRoom: z.boolean().optional()
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ dryRun, makeRoom, ...input }, principal) => {
			const resolvedDraftId = await resolveDraftIdForTool(input.draftId, MoveDraftAssignmentError);
			const outcome = await moveDraftAssignment({ ...input, draftId: resolvedDraftId }, principalIdentity(principal), {
				via: 'claude',
				dryRun,
				withProblems: true,
				mode: makeRoom ? 'makeRoom' : 'flag'
			});
			return { id: outcome.result.id, dryRun: outcome.dryRun, changes: outcome.changes, pushedCount: outcome.result.pushedCount, ...problemsForTool(outcome) };
		}
	}),
	defineTool({
		name: 'set_draft_crew',
		description:
			"Sets exactly who works one station on one day inside a draft — for 'only one person on Press 1 Tuesday', " +
			"'swap Jo for Mitch on embroidery', 'put two catches on the press'. Only that draft changes (no shop-wide " +
			"pin). Read the current crew first (get_draft: assignments[].crew) and pass the FULL new list of names. " +
			"Hours are re-estimated by the engine for the new crew size — fewer people can make jobs longer and push " +
			"the jobs after them. Refused if someone isn't certified on the station, is marked out, or (Printed " +
			"Relabel) isn't a press person. On a press the first main (else operator) leads; with no main or operator " +
			"it's flagged red. Same check-first rule as move_assignment: dryRun: true first, explain any newProblems " +
			"(e.g. 'with one person the hoodies run past 4:30 Tuesday'), and only with the person's go-ahead use " +
			"makeRoom: true (overflow moves to the next working day; someone also on another station that day is " +
			"taken off it) — then list `changes` and `notes`. Example: 'only Mitch on Press 1 on the 20th' → " +
			"{ draftId: 'AB3C9F', date: '2026-10-20', stationName: 'Press 1', workerNames: ['Mitch'], dryRun: true }. " +
			"Returns { crew, jobs (hours before/after), notes, changes, canApprove, newProblems, allProblems }.",
		inputSchema: { ...setDraftCrewSchema.shape, dryRun: z.boolean().optional(), makeRoom: z.boolean().optional() },
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ dryRun, makeRoom, ...input }, principal) => {
			const draftId = await resolveDraftIdForTool(input.draftId, SetDraftCrewError);
			const outcome = await setDraftCrew({ ...input, draftId }, principalIdentity(principal), { dryRun, mode: makeRoom ? 'makeRoom' : 'flag' });
			const { changes: _moves, ...result } = outcome.result;
			return { ...result, dryRun: outcome.dryRun, changes: outcome.changes, ...problemsForTool(outcome) };
		}
	}),
	defineTool({
		name: 'shift_draft',
		description:
			"Moves many jobs in a draft at once, in place: `days` moves every selected proposed job that many WORKING " +
			"days later (negative = earlier; weekends skipped), keeping station and start time — 'push the schedule " +
			"back a day'. `bufferMinutes` leaves at least that much time between back-to-back jobs on each station's " +
			"day — 'give a 15-minute buffer'. Narrow it with from/to (the dates jobs are on now) and stationName. " +
			"Overlaps it causes are pushed later; anything past the end of the shift is flagged, or with makeRoom: " +
			"true (only after the person says so) moved to the next working day. Check first with dryRun: true and " +
			"explain newProblems (late deadlines, overflow) before saving. Example: 'push everything from Oct 21 on " +
			"back one day' → { draftId: 'AB3C9F', days: 1, from: '2026-10-21', dryRun: true }. Returns { moved, " +
			"changes, canApprove, newProblems, allProblems }.",
		inputSchema: { ...shiftDraftSchema.shape, dryRun: z.boolean().optional(), makeRoom: z.boolean().optional() },
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ dryRun, makeRoom, ...input }, principal) => {
			const draftId = await resolveDraftIdForTool(input.draftId, ShiftDraftError);
			const outcome = await shiftDraft({ ...input, draftId }, principalIdentity(principal), { dryRun, mode: makeRoom ? 'makeRoom' : 'flag' });
			return { moved: outcome.result.moved, dryRun: outcome.dryRun, changes: outcome.changes, ...problemsForTool(outcome) };
		}
	}),
	defineTool({
		name: 'replan_draft',
		description:
			"Re-runs the automatic scheduler INSIDE an existing draft (no new draft) — when the inputs changed: " +
			"someone marked out (set_worker_availability first), a new order confirmed, a deadline changed, or the " +
			"person says 'redo this draft'. Its proposed jobs are replaced by a fresh plan over the draft's window, " +
			"using the current roster, days out, pins and committed work; hand moves made in the draft are lost, so " +
			"say that and get a yes first. Approved jobs stay unless replanFrom/replanTo releases them (someone out: " +
			"just those days; a rush: the whole window). Show `changes`, `unscheduledOrders` and `allProblems`. " +
			"Example: 'Maria's out Tuesday, fix the draft' → set_worker_availability, then { draftId: 'AB3C9F', " +
			"reason: 'Maria out Tue' }. Returns { movedCount, addedCount, takenOffCount, changes, unscheduledOrders, " +
			"atRisk, canApprove, allProblems }.",
		inputSchema: replanDraftSchema.shape,
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async (input, principal) => {
			const draftId = await resolveDraftIdForTool(input.draftId, ReplanDraftError);
			return replanDraft({ ...input, draftId }, principalIdentity(principal));
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
			"autos Tuesday?' → { from: '2026-10-06', to: '2026-10-06' }. Returns { roster, out, pinned, approvedCrews }. " +
			'A screen-print press runs with exactly one main printer (roster[].mainOn lists the presses a person may ' +
			'run as main; approvedCrews[].main names who is, listed first in crew) and everyone else on it is a catch ' +
			'(approvedCrews[].catches) who assists the main. There is never a catch without a main: a press with no ' +
			'main in that day is closed and has no crew. Read roster[].notes before proposing a schedule: if a note states something ' +
			'the staffing plan should know (someone out, someone on a station a given day), ask the user and then ' +
			'use set_worker_availability / set_worker_station — never place people yourself.',
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
			'those days — tell the user, and offer to fix it in place: if they are on a draft being worked on, ' +
			'replan_draft on that draft (or set_draft_crew for the days affected); if they are on the approved ' +
			'schedule, with the person\'s yes reopen that draft (unapprove_schedule) and replan_draft it with ' +
			'replanFrom/replanTo set to exactly the days they are out, so only the jobs on those days move. A change ' +
			'to the approved schedule is recorded for Reports — ask why (list_schedule_changes). Only the ' +
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
	}),
	...changeNoteTools
];
