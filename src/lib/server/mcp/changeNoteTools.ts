import { z } from 'zod';
import type { McpToolDefinition } from '$lib/server/mcp/handler';
import { principalIdentity } from '$lib/server/mcp/handler';
import { explainScheduleChange, listScheduleChanges } from '$lib/server/schedule/changeNotes';

/**
 * "Why did the approved schedule change?" (2026-10-16). Every change to committed work —
 * jobs reopened, replaced by a newly approved plan, someone marked out on days they were
 * crewing, approved slots removed — is written down as a ScheduleChangeNote
 * (schedule/changeNotes.ts). These two tools let Claude find the unexplained ones and
 * record the person's answer; answered notes show on the Reports page. Registered by
 * spreading `changeNoteTools` at the end of `mcpTools` in mcp/tools.ts.
 *
 * Descriptions are prompt text sent to Claude verbatim. The non-negotiable here: the
 * reason is only ever what a person said — Claude never infers or writes its own.
 */

// Same identity helper as mcp/tools.ts: check each literal against its own Zod shape,
// then widen to the common McpToolDefinition.
function defineTool<Shape extends z.ZodRawShape>(tool: McpToolDefinition<Shape>): McpToolDefinition {
	return tool as unknown as McpToolDefinition;
}

export const changeNoteTools: readonly McpToolDefinition[] = [
	defineTool({
		name: 'list_schedule_changes',
		description:
			'Lists changes made to the approved (live) schedule after it was approved — jobs reopened for changes, ' +
			'jobs moved when a new plan was approved, someone marked out on days they were working approved jobs, ' +
			'approved slots removed — newest first, each with when, who, a one-line summary, the jobs it touched ' +
			'(from/to station and day) and the reason a person gave, if any. Call it with { needsReason: true } right ' +
			'after you change an approved schedule (commit_schedule that replaces slots, unapprove_schedule, ' +
			'set_worker_availability marking someone out) and at the start of a daily brief. For each unexplained ' +
			'change, ask the person in plain words why it happened, then record exactly what they say with ' +
			'explain_schedule_change. Never guess or suggest a reason yourself. Answered notes show on the Reports page. ' +
			"Example: 'anything I need to explain?' → { needsReason: true }. Returns { changes }.",
		inputSchema: {
			needsReason: z.boolean().optional(),
			from: z.iso.date().optional(),
			to: z.iso.date().optional()
		},
		requiredScope: 'SCHEDULE_READ',
		readOnly: true,
		handler: async ({ needsReason, from, to }) => {
			const changes = await listScheduleChanges({ needsReason, from, to, limit: 100 });
			return {
				changes: changes.map((change) => ({
					changeId: change.id,
					at: change.at.toISOString(),
					by: change.actor,
					kind: change.kind,
					summary: change.summary,
					jobs: change.details?.jobs ?? [],
					...(change.details?.worker ? { worker: change.details.worker, days: change.details.days ?? [], outReason: change.details.outReason ?? null } : {}),
					reason: change.reason,
					reasonBy: change.reasonBy,
					reasonAt: change.reasonAt?.toISOString() ?? null
				}))
			};
		}
	}),
	defineTool({
		name: 'explain_schedule_change',
		description:
			'Records why an approved schedule changed, in the words of the person who told you — e.g. "Rush order for ' +
			'100157 came in" or "Maria was out sick". Only call it with a reason the person actually gave; never write ' +
			'your own, and if they don\'t know, leave it unanswered. Get changeId from list_schedule_changes. An ' +
			'existing reason is replaced. The answer shows on the Reports page under Change notes. ' +
			"Example: 'that was because the press broke' → { changeId: '...', reason: 'The press broke.' }. " +
			'Returns { changeId, summary, reason, reasonBy }.',
		inputSchema: {
			changeId: z.string().trim().min(1),
			reason: z.string().trim().min(1).max(2000)
		},
		requiredScope: 'SCHEDULE_WRITE',
		readOnly: false,
		handler: async ({ changeId, reason }, principal) => {
			// explainScheduleChange throws a ScheduleChangeNoteError (an McpUserError) for an
			// unknown id, so its message reaches Claude as-is.
			const updated = await explainScheduleChange(changeId, reason, principalIdentity(principal));
			return { changeId: updated.id, summary: updated.summary, reason: updated.reason, reasonBy: updated.reasonBy };
		}
	})
];
