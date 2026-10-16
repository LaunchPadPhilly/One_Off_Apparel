/**
 * "Why did the approved schedule change?" notes (2026-10-16). Once a schedule is approved
 * (the live schedule), every later change to committed work — APPROVED / IN_PROGRESS jobs —
 * is written down here, in the same transaction as the change itself, and a person is asked
 * later WHY. The answers collect on the Reports page.
 *
 * What records a note (each call site writes one inside its own transaction):
 *   - `reopened`      — unapproveSchedule / unapproveDraft ("Make changes" on the board,
 *                       unapprove_schedule in chat): approved jobs went back to proposed.
 *   - `replaced`      — commitSchedule: approving a plan replaced approved, not-started
 *                       slots with new ones at a different station / day / time.
 *   - `worker_out`    — setWorkerAvailability: someone was marked out on days they were
 *                       crewing approved or running jobs.
 *   - `slots_removed` — updateLineItemFields: approved slots were deleted because the job
 *                       was marked outsourced.
 *
 * `reason` is only ever what a person said — typed on the Reports page or told to Claude
 * (explain_schedule_change). Nothing here, and no engine or LLM code, fills it in.
 */
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import type { Prisma } from '../../../../prisma/generated/prisma/client';

export const SCHEDULE_CHANGE_KINDS = ['reopened', 'replaced', 'worker_out', 'slots_removed'] as const;
export type ScheduleChangeKind = (typeof SCHEDULE_CHANGE_KINDS)[number];

/** Where a job was (or now is): station label, "YYYY-MM-DD", and a clock time when known. */
export type ChangeSlot = { station: string; date: string; time?: string | null };

/** One job a change touched, in words a shop manager recognizes. */
export type ChangeJob = { job: string; hoopsOrderId: string; from?: ChangeSlot; to?: ChangeSlot };

/** What `details` holds. `jobs` is always present; the rest depends on the kind. */
export type ScheduleChangeDetails = {
	jobs: ChangeJob[];
	/** worker_out: who was marked out, on which days, and what was said when they were. */
	worker?: string;
	days?: string[];
	outReason?: string | null;
};

/** A user-facing problem (unknown note id, empty reason). Its message reaches Claude as-is. */
export class ScheduleChangeNoteError extends McpUserError {
	constructor(message: string) {
		super(message);
		this.name = 'ScheduleChangeNoteError';
	}
}

const MAX_REASON_LENGTH = 2000;

/** Writes one change note inside the caller's transaction. */
export async function recordScheduleChange(
	tx: Prisma.TransactionClient,
	input: { actor: string; kind: ScheduleChangeKind; summary: string; draftId?: string | null; orderIds?: readonly string[]; details?: ScheduleChangeDetails }
) {
	return tx.scheduleChangeNote.create({
		data: {
			actor: input.actor,
			kind: input.kind,
			summary: input.summary,
			draftId: input.draftId ?? null,
			orderIds: [...new Set(input.orderIds ?? [])],
			...(input.details ? { details: input.details as unknown as Prisma.InputJsonValue } : {})
		}
	});
}

// ─── Small shared formatting helpers for the call sites ─────────────────────────────

export const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** "Oct 19" — dates here are midnight-UTC calendar days. */
export function shortDay(date: Date | string) {
	const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date;
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Oct 19" or "Oct 19 – Oct 21" for a sorted list of "YYYY-MM-DD" days. */
export function dayRange(days: readonly string[]) {
	if (days.length === 0) return '';
	const first = shortDay(days[0]);
	const last = shortDay(days[days.length - 1]);
	return first === last ? first : `${first} – ${last}`;
}

/** "9:30a" for a minute-of-day, or null. */
export function clockTime(minuteOfDay: number | null | undefined) {
	if (minuteOfDay === null || minuteOfDay === undefined) return null;
	const h = Math.floor(minuteOfDay / 60);
	const m = minuteOfDay % 60;
	const suffix = h >= 12 ? 'p' : 'a';
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return `${h12}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`}${suffix}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ');

/** The select every call site uses to describe a job's line item. */
export const changeJobLineItemSelect = {
	id: true,
	orderId: true,
	design: true,
	decorationType: true,
	finishingStep: true,
	otherJobType: true,
	order: { select: { hoopsOrderId: true } }
} as const;

type ChangeJobLineItem = {
	design: string;
	decorationType: string | null;
	finishingStep: string | null;
	otherJobType: string | null;
	order: { hoopsOrderId: string };
};

/** "Front logo (screen print)" */
export function jobLabel(item: ChangeJobLineItem) {
	const type = item.decorationType ? humanize(item.decorationType) : item.finishingStep ? humanize(item.finishingStep) : item.otherJobType;
	return type ? `${item.design} (${type})` : item.design;
}

/** A slot as written into details. */
export function changeSlot(station: string, date: Date, startMinuteOfDay: number | null | undefined): ChangeSlot {
	return { station, date: isoDay(date), time: clockTime(startMinuteOfDay) };
}

// ─── Reading and answering ──────────────────────────────────────────────────────────

export type ScheduleChangeNoteView = {
	id: string;
	at: Date;
	actor: string;
	kind: string;
	summary: string;
	draftId: string | null;
	orderIds: string[];
	details: ScheduleChangeDetails | null;
	reason: string | null;
	reasonBy: string | null;
	reasonAt: Date | null;
};

/**
 * Change notes, newest first. `needsReason: true` = only unexplained ones, `false` = only
 * explained ones, omitted = both. `from` / `to` ("YYYY-MM-DD", inclusive) filter on when
 * the change happened.
 */
export async function listScheduleChanges(options: { needsReason?: boolean; from?: string; to?: string; limit?: number } = {}): Promise<ScheduleChangeNoteView[]> {
	const at: { gte?: Date; lt?: Date } = {};
	const isDay = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
	if (isDay(options.from)) at.gte = new Date(`${options.from}T00:00:00Z`);
	if (isDay(options.to)) {
		const end = new Date(`${options.to}T00:00:00Z`);
		end.setUTCDate(end.getUTCDate() + 1);
		at.lt = end;
	}
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const rows = await prisma.scheduleChangeNote.findMany({
		where: {
			...(options.needsReason === true ? { reason: null } : options.needsReason === false ? { reason: { not: null } } : {}),
			...(at.gte || at.lt ? { at } : {})
		},
		orderBy: { at: 'desc' },
		take: limit
	});
	return rows.map((row) => ({ ...row, details: (row.details as ScheduleChangeDetails | null) ?? null }));
}

/**
 * Records a person's answer to "why did this change?". Overwrites an earlier answer.
 *
 * @throws ScheduleChangeNoteError for an empty/too-long reason or an unknown id
 */
export async function explainScheduleChange(id: string, reason: string, actor: string): Promise<ScheduleChangeNoteView> {
	const trimmed = reason.trim();
	if (!trimmed) throw new ScheduleChangeNoteError('Write down the reason the person gave — it can’t be empty.');
	if (trimmed.length > MAX_REASON_LENGTH) throw new ScheduleChangeNoteError(`Keep the reason under ${MAX_REASON_LENGTH} characters.`);

	return prisma.$transaction(async (tx) => {
		const existing = await tx.scheduleChangeNote.findUnique({ where: { id }, select: { id: true, reason: true } });
		if (!existing) throw new ScheduleChangeNoteError(`No schedule change with id "${id}". Use list_schedule_changes to find it.`);
		const updated = await tx.scheduleChangeNote.update({ where: { id }, data: { reason: trimmed, reasonBy: actor, reasonAt: new Date() } });
		await tx.domainAuditLog.create({
			data: { entity: 'ScheduleChangeNote', entityId: id, action: 'schedule_change_explained', actor, diff: { from: existing.reason, to: trimmed } }
		});
		return { ...updated, details: (updated.details as ScheduleChangeDetails | null) ?? null };
	});
}
