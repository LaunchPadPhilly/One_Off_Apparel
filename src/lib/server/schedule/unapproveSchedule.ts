/**
 * Reverses `commitSchedule` — flips APPROVED ScheduleAssignment rows back to PROPOSED
 * so they can be moved or re-approved. Backs the `unapprove_schedule` MCP tool; the
 * recovery path when a plan was approved too early (or by accident) and someone needs
 * to adjust it without re-running the engine from scratch.
 *
 * Rules:
 *   - Only APPROVED rows can be unapproved. IN_PROGRESS and COMPLETE have already
 *     started on the floor — the plan is no longer hypothetical and must not be
 *     silently rewound. Refused with a clear message.
 *   - All-or-nothing, in one transaction (matches commitSchedule's shape).
 *   - A draft whose status was flipped to APPROVED by its final commit is rolled
 *     back to DRAFT when any of its rows return to PROPOSED, so the drafts list
 *     and the board treat it as editable again.
 *   - approvedBy / approvedAt are cleared on the row; a `schedule_unapproved`
 *     audit entry captures who did it and when.
 *
 * Known limitation (documented, not silently fixed): commitSchedule DELETES prior
 * approved-but-not-started rows for the same line item (the "a job is never on the
 * schedule twice" rule in commitSchedule.ts:72-86). Those deleted rows are not
 * resurrected here — the unapproved row returns to PROPOSED on its own, and the
 * caller gets a fresh plan to adjust. If restoring the prior slot matters, re-propose.
 */
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { changeJobLineItemSelect, changeSlot, jobLabel, plural, recordScheduleChange } from './changeNotes';
import { ScheduleAssignmentStatus, ScheduleDraftStatus } from '../../../../prisma/generated/prisma/enums';

export class UnapproveScheduleError extends McpUserError {
	constructor(message: string) {
		super(message);
		this.name = 'UnapproveScheduleError';
	}
}

/**
 * Returns the given assignments to PROPOSED. See file header for rules.
 *
 * @throws UnapproveScheduleError if any id doesn't exist, or if any row is not
 *   APPROVED (IN_PROGRESS/COMPLETE have already started — refused as a group).
 */
export async function unapproveSchedule(assignmentIds: readonly string[], actor: string) {
	if (assignmentIds.length === 0) return { assignments: [], draftsReopened: 0 };

	return prisma.$transaction(async (tx) => {
		const assignments = await tx.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } } });

		if (assignments.length !== assignmentIds.length) {
			const found = new Set(assignments.map((a) => a.id));
			const missing = assignmentIds.filter((id) => !found.has(id));
			throw new UnapproveScheduleError(`These assignment ids weren't found: ${missing.join(', ')}`);
		}

		const notApproved = assignments.filter((a) => a.status !== ScheduleAssignmentStatus.APPROVED);
		if (notApproved.length > 0) {
			throw new UnapproveScheduleError(
				`Only approved, not-started jobs can be unapproved; these can't: ${notApproved.map((a) => `${a.id} (${a.status.toLowerCase()})`).join(', ')}`
			);
		}

		await tx.scheduleAssignment.updateMany({
			where: { id: { in: [...assignmentIds] } },
			data: { status: ScheduleAssignmentStatus.PROPOSED, approvedBy: null, approvedAt: null }
		});

		for (const assignment of assignments) {
			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: assignment.id,
					action: 'schedule_unapproved',
					actor,
					diff: { lineItemId: assignment.lineItemId, stationId: assignment.stationId, date: assignment.date, priorApprovedBy: assignment.approvedBy, priorApprovedAt: assignment.approvedAt }
				}
			});
		}

		// A draft that was marked APPROVED because its last proposed row was committed
		// now has PROPOSED rows again — roll its status back to DRAFT so the board and
		// the drafts list treat it as editable.
		const draftIds = [...new Set(assignments.map((a) => a.scheduleDraftId).filter((id): id is string => id !== null))];

		// These jobs were on the live schedule — note the change so someone is asked why
		// (changeNotes.ts). Every row here was APPROVED, checked above.
		const described = await tx.scheduleAssignment.findMany({
			where: { id: { in: [...assignmentIds] } },
			select: { date: true, startMinuteOfDay: true, station: { select: { label: true } }, lineItem: { select: changeJobLineItemSelect } },
			orderBy: [{ date: 'asc' }, { startMinuteOfDay: 'asc' }]
		});
		const drafts = draftIds.length ? await tx.scheduleDraft.findMany({ where: { id: { in: draftIds } }, select: { name: true } }) : [];
		const where =
			drafts.length === 1 ? `on “${drafts[0].name}”` : drafts.length > 1 ? `across ${drafts.length} plans` : 'on the live schedule';
		await recordScheduleChange(tx, {
			actor,
			kind: 'reopened',
			summary: `${plural(assignments.length, 'approved job')} ${where} ${assignments.length === 1 ? 'was' : 'were'} reopened for changes`,
			draftId: draftIds.length === 1 ? draftIds[0] : null,
			orderIds: described.map((row) => row.lineItem.orderId),
			details: {
				jobs: described.map((row) => ({
					job: jobLabel(row.lineItem),
					hoopsOrderId: row.lineItem.order.hoopsOrderId,
					from: changeSlot(row.station.label, row.date, row.startMinuteOfDay)
				}))
			}
		});

		let draftsReopened = 0;
		for (const draftId of draftIds) {
			const draft = await tx.scheduleDraft.findUnique({ where: { id: draftId }, select: { status: true } });
			if (draft?.status === ScheduleDraftStatus.APPROVED) {
				await tx.scheduleDraft.update({ where: { id: draftId }, data: { status: ScheduleDraftStatus.DRAFT } });
				draftsReopened += 1;
			}
		}

		return {
			assignments: await tx.scheduleAssignment.findMany({ where: { id: { in: [...assignmentIds] } } }),
			draftsReopened
		};
	});
}

/**
 * Unapproves every APPROVED (not-started) row in one draft — the parallel of
 * commitDraft, for the recovery case where a whole plan was approved and needs
 * to be reopened for edits. Rows already IN_PROGRESS or COMPLETE in that draft
 * are left alone and reported in `skipped`.
 *
 * @throws UnapproveScheduleError if the draft doesn't exist or has nothing
 *   approved to unapprove.
 */
export async function unapproveDraft(draftId: string, actor: string) {
	const draft = await prisma.scheduleDraft.findUnique({ where: { id: draftId }, select: { id: true } });
	if (!draft) throw new UnapproveScheduleError(`No schedule draft with id "${draftId}".`);
	const rows = await prisma.scheduleAssignment.findMany({
		where: { scheduleDraftId: draftId },
		select: { id: true, status: true }
	});
	const approved = rows.filter((r) => r.status === ScheduleAssignmentStatus.APPROVED).map((r) => r.id);
	const skipped = rows.filter((r) => r.status === ScheduleAssignmentStatus.IN_PROGRESS || r.status === ScheduleAssignmentStatus.COMPLETE).map((r) => r.id);
	if (approved.length === 0) {
		throw new UnapproveScheduleError(
			skipped.length > 0
				? `This draft has no approved, not-started jobs to unapprove (${skipped.length} already started or finished).`
				: 'This draft has no approved jobs to unapprove.'
		);
	}
	const result = await unapproveSchedule(approved, actor);
	return { ...result, skipped };
}
