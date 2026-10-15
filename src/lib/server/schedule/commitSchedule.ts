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
import { wallClockEnd } from '$lib/schedule/shift';
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
 * `commit_schedule` given a draftId. Two-places-at-once (2026-10-15): any crew
 * member on two jobs on the same date whose wall-clock spans overlap blocks
 * approval, since allowing both into the live schedule would commit a plan the
 * shop can't physically run. Both proposed-vs-proposed (within this draft) and
 * proposed-vs-committed (already APPROVED / IN_PROGRESS elsewhere, same day)
 * are checked; everyone with an overlap must come off one job before approval.
 *
 * @throws CommitScheduleError if the draft doesn't exist, has nothing to approve,
 *   or holds a crew conflict — plus anything commitSchedule throws
 */
export async function commitDraft(draftId: string, approvedBy: string) {
	const draft = await prisma.scheduleDraft.findUnique({ where: { id: draftId }, select: { id: true } });
	if (!draft) throw new CommitScheduleError(`No schedule draft with id "${draftId}".`);
	const proposed = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId, status: ScheduleAssignmentStatus.PROPOSED },
		select: {
			id: true,
			lineItemId: true,
			stationId: true,
			date: true,
			startMinuteOfDay: true,
			estimatedHours: true,
			station: { select: { label: true } },
			crew: { select: { workerId: true, worker: { select: { name: true } } } }
		}
	});
	if (proposed.length === 0) throw new CommitScheduleError('This draft has no proposed jobs left to approve.');

	await refuseIfCrewConflicts(proposed);

	return commitSchedule(
		proposed.map((row) => row.id),
		approvedBy
	);
}

type ProposedForCheck = {
	id: string;
	lineItemId: string;
	stationId: string;
	date: Date;
	startMinuteOfDay: number | null;
	estimatedHours: number;
	station: { label: string };
	crew: { workerId: string; worker: { name: string } }[];
};

/**
 * Throws CommitScheduleError if any PROPOSED assignment's crew member is on another
 * job that day — in this draft or already committed — whose wall-clock span overlaps.
 * The message names the first offender; a reviewer removes them from one job and
 * re-approves. Checked per (date, worker) via the same overlap rule the board uses.
 */
async function refuseIfCrewConflicts(proposed: ProposedForCheck[]) {
	const dates = [...new Set(proposed.map((a) => a.date.getTime()))].map((ms) => new Date(ms));
	if (dates.length === 0) return;
	const committed = await prisma.scheduleAssignment.findMany({
		where: {
			date: { in: dates },
			status: { in: [ScheduleAssignmentStatus.APPROVED, ScheduleAssignmentStatus.IN_PROGRESS] }
		},
		select: {
			id: true,
			lineItemId: true,
			stationId: true,
			date: true,
			startMinuteOfDay: true,
			estimatedHours: true,
			station: { select: { label: true } },
			crew: { select: { workerId: true, worker: { select: { name: true } } } }
		}
	});
	// A proposed job that supersedes a committed one (same line item) replaces its
	// APPROVED/IN_PROGRESS slot on commitSchedule, so the committed slot's crew won't
	// still be on the schedule after this approve — leave those committed rows out of
	// the overlap check to avoid flagging a conflict with the slot being replaced.
	const proposedLineItemIds = new Set(proposed.map((a) => a.lineItemId));

	type Span = { stationId: string; stationLabel: string; startMin: number; endMin: number; workerName: string };
	const spansByDayWorker = new Map<string, Span[]>();
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	const add = (row: ProposedForCheck | (typeof committed)[number]) => {
		const start = row.startMinuteOfDay ?? 8 * 60;
		const end = wallClockEnd(start, Math.round(row.estimatedHours * 60));
		for (const member of row.crew) {
			const key = `${iso(row.date)}|${member.workerId}`;
			const bucket = spansByDayWorker.get(key) ?? [];
			bucket.push({
				stationId: row.stationId,
				stationLabel: row.station.label,
				startMin: start,
				endMin: end,
				workerName: member.worker.name
			});
			spansByDayWorker.set(key, bucket);
		}
	};
	for (const row of proposed) add(row);
	for (const row of committed) if (!proposedLineItemIds.has(row.lineItemId)) add(row);

	for (const [key, spans] of spansByDayWorker) {
		if (spans.length < 2) continue;
		for (let i = 0; i < spans.length; i++) {
			for (let j = i + 1; j < spans.length; j++) {
				const a = spans[i];
				const b = spans[j];
				if (a.stationId === b.stationId) continue; // same station = same crew all day
				if (a.startMin >= b.endMin || b.startMin >= a.endMin) continue;
				const date = key.split('|')[0];
				const fmt = (m: number) => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')}${m < 12 * 60 ? 'a' : 'p'}`;
				throw new CommitScheduleError(
					`Can't approve while a crew member is in two places at once: ${a.workerName} is on ${a.stationLabel} (${fmt(a.startMin)}–${fmt(a.endMin)}) and ${b.stationLabel} (${fmt(b.startMin)}–${fmt(b.endMin)}) on ${date}. Remove them from one of the jobs, then try again.`
				);
			}
		}
	}
}
