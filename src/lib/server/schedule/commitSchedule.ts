/**
 * Approving a plan — the second of CLAUDE.md's two human approval gates. Backs the
 * `commit_schedule` MCP tool (mcp/tools.ts) and the draft page's Approve button, so chat
 * and the board approve the same way. Key rules: it only ever approves rows that are
 * still PROPOSED, all-or-nothing, in one transaction; and approving a job replaces
 * that job's old not-started approved slot (2026-10-05 re-planning — see
 * committedWork.ts), so a moved job is never on the schedule twice.
 */
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { ScheduleAssignmentStatus, ScheduleDraftStatus } from '../../../../prisma/generated/prisma/enums';

/** A refusal written for the person approving — shown as-is in chat and on the board. */
export class CommitScheduleError extends McpUserError {
	constructor(message: string) {
		super(message);
		this.name = 'CommitScheduleError';
	}
}

/**
 * Makes proposed assignments official. Writes only to schedule_assignments, the
 * draft's status, and audit_log; it does not touch Order or LineItem status. (When an
 * order's status should move to `scheduled` isn't documented anywhere — not addressed
 * here rather than guessed.)
 *
 * For each job being approved, its other approved-but-not-started rows are removed (the
 * new slot replaces them), each with a `schedule_superseded` audit entry. A job that
 * has already started is refused: the plan was made before it started and is out of date.
 * A draft with nothing left to approve is marked APPROVED.
 *
 * @param assignmentIds - the PROPOSED ScheduleAssignment ids to approve
 * @param approvedBy - who approved them (stored on each row and in the audit log)
 * @returns the updated (now APPROVED) rows and how many old slots they replaced
 * @throws CommitScheduleError if any id doesn't exist, isn't PROPOSED, or is for a job
 *   that has already started or finished — nothing is approved then
 */
export async function commitSchedule(assignmentIds: readonly string[], approvedBy: string) {
	if (assignmentIds.length === 0) return { assignments: [], replacedCount: 0 };

	return prisma.$transaction(async (tx) => {
		const assignments = await tx.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } } });

		if (assignments.length !== assignmentIds.length) {
			const found = new Set(assignments.map((a) => a.id));
			const missing = assignmentIds.filter((id) => !found.has(id));
			throw new CommitScheduleError(`These assignment ids weren't found: ${missing.join(', ')}`);
		}

		const notProposed = assignments.filter((a) => a.status !== ScheduleAssignmentStatus.PROPOSED);
		if (notProposed.length > 0) {
			throw new CommitScheduleError(`Only proposed jobs can be approved; these aren't: ${notProposed.map((a) => `${a.id} (${a.status.toLowerCase()})`).join(', ')}`);
		}

		const lineItemIds = [...new Set(assignments.map((a) => a.lineItemId))];
		const approvingIds = new Set(assignments.map((a) => a.id));
		const otherCommitted = await tx.scheduleAssignment.findMany({
			where: {
				lineItemId: { in: lineItemIds },
				id: { notIn: [...approvingIds] },
				status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS, ScheduleAssignmentStatus.COMPLETE] }
			}
		});

		const started = otherCommitted.filter((row) => row.status !== ScheduleAssignmentStatus.APPROVED || row.startedAt !== null);
		if (started.length > 0) {
			throw new CommitScheduleError(
				`${started.length} job${started.length === 1 ? ' has' : 's have'} already started or finished since this plan was made, so it's out of date. Propose a new plan instead.`
			);
		}

		// The new slots replace the old approved ones.
		for (const old of otherCommitted) {
			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: old.id,
					action: 'schedule_superseded',
					actor: approvedBy,
					diff: { lineItemId: old.lineItemId, stationId: old.stationId, date: old.date, startMinuteOfDay: old.startMinuteOfDay, replacedBy: assignments.find((a) => a.lineItemId === old.lineItemId)?.id ?? null }
				}
			});
		}
		if (otherCommitted.length > 0) {
			await tx.scheduleAssignment.deleteMany({ where: { id: { in: otherCommitted.map((row) => row.id) } } });
		}

		const approvedAt = new Date();
		await tx.scheduleAssignment.updateMany({
			where: { id: { in: [...assignmentIds] } },
			data: { status: ScheduleAssignmentStatus.APPROVED, approvedBy, approvedAt }
		});

		for (const assignment of assignments) {
			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: assignment.id,
					action: 'schedule_committed',
					actor: approvedBy,
					diff: { lineItemId: assignment.lineItemId, stationId: assignment.stationId, date: assignment.date }
				}
			});
		}

		// A draft whose every job is now approved is itself approved.
		const draftIds = [...new Set(assignments.map((a) => a.scheduleDraftId).filter((id): id is string => id !== null))];
		for (const draftId of draftIds) {
			const stillProposed = await tx.scheduleAssignment.count({ where: { scheduleDraftId: draftId, status: ScheduleAssignmentStatus.PROPOSED } });
			if (stillProposed === 0) await tx.scheduleDraft.update({ where: { id: draftId }, data: { status: ScheduleDraftStatus.APPROVED } });
		}

		return {
			assignments: await tx.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } } }),
			replacedCount: otherCommitted.length
		};
	});
}

/**
 * Approves every proposed job in one draft — the board's Approve button, and
 * `commit_schedule` given a draftId.
 *
 * @throws CommitScheduleError if the draft doesn't exist or has nothing to approve,
 *   plus anything commitSchedule throws
 */
export async function commitDraft(draftId: string, approvedBy: string) {
	const draft = await prisma.scheduleDraft.findUnique({ where: { id: draftId }, select: { id: true } });
	if (!draft) throw new CommitScheduleError(`No schedule draft with id "${draftId}".`);
	const proposed = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId, status: ScheduleAssignmentStatus.PROPOSED },
		select: { id: true }
	});
	if (proposed.length === 0) throw new CommitScheduleError('This draft has no proposed jobs left to approve.');
	return commitSchedule(
		proposed.map((row) => row.id),
		approvedBy
	);
}
