/**
 * Read-side helpers for the `list_drafts` and `get_draft` MCP tools (mcp/tools.ts).
 * Chat needs to see what's on the board without opening a browser — the full set of
 * drafts, and the assignments inside one — so Claude can reason about moves,
 * approvals, buffers, and so on. Keeps the deterministic engine untouched; both
 * functions are pure reads.
 *
 * The shape returned is MCP-flavored (string ids, ISO date strings, short code
 * alongside the cuid, a precomputed `job` label) rather than raw Prisma rows, so
 * every tool caller — Claude in chat, future SDK users — gets the same stable
 * surface the tool description already describes.
 */
import { prisma } from '$lib/server/prisma';
import { McpUserError } from '$lib/server/mcp/handler';
import { shortDraftCode, resolveDraftIdOrShortCode } from './draftShortCode';
import { SHIFT_START_MIN, SHIFT_END_MIN, WORKING_MIN, BREAKS } from '$lib/schedule/shift';
import { ScheduleAssignmentStatus, ScheduleDraftStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * The shop's shift model, included in every list_drafts / get_draft response so
 * Claude in chat doesn't have to ask the user "does your day start at 8 AM?" —
 * the answer is already in the application and should travel with the data.
 * See $lib/schedule/shift.ts for the source of truth.
 */
export const SHOP_SHIFT = {
	startMinuteOfDay: SHIFT_START_MIN,
	endMinuteOfDay: SHIFT_END_MIN,
	startWallClock: '08:00',
	endWallClock: '16:30',
	workingMinutes: WORKING_MIN,
	workingHours: WORKING_MIN / 60,
	breaks: BREAKS.map((b) => ({
		startMinuteOfDay: b.startMin,
		durationMinutes: b.durationMin,
		label: b.label
	}))
} as const;

export class GetDraftError extends McpUserError {
	constructor(message: string) {
		super(message);
		this.name = 'GetDraftError';
	}
}

function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Short, readable name for one line item: "100127 · Front logo (screen print)". */
function jobLabel(item: {
	design: string | null;
	decorationType: string | null;
	finishingStep: string | null;
	otherJobType: string | null;
	order: { hoopsOrderId: string };
}): string {
	const kind = item.decorationType ?? item.finishingStep ?? item.otherJobType ?? 'job';
	return `${item.order.hoopsOrderId} · ${item.design ?? 'untitled'} (${kind.toLowerCase().replace(/_/g, ' ')})`;
}

export interface DraftSummary {
	id: string;
	shortCode: string;
	name: string;
	description: string | null;
	status: ScheduleDraftStatus;
	startDate: string;
	weeks: number;
	strategy: string;
	createdBy: string;
	createdAt: string;
	totalAssignments: number;
	proposedCount: number;
	approvedCount: number;
}

/**
 * Every draft that isn't archived, newest first, with per-status counts so Claude
 * can tell "all proposed" from "fully approved" without a second call.
 */
export async function listDraftsForTool(statusFilter?: ScheduleDraftStatus): Promise<DraftSummary[]> {
	const drafts = await prisma.scheduleDraft.findMany({
		where: statusFilter ? { status: statusFilter } : { status: { not: ScheduleDraftStatus.ARCHIVED } },
		orderBy: { createdAt: 'desc' },
		include: {
			assignments: { select: { status: true } }
		}
	});
	return drafts.map((d) => {
		const proposed = d.assignments.filter((a) => a.status === ScheduleAssignmentStatus.PROPOSED).length;
		const approved = d.assignments.filter((a) => a.status === ScheduleAssignmentStatus.APPROVED).length;
		return {
			id: d.id,
			shortCode: shortDraftCode(d.id),
			name: d.name,
			description: d.description,
			status: d.status,
			startDate: iso(d.startDate),
			weeks: d.weeks,
			strategy: d.strategy,
			createdBy: d.createdBy,
			createdAt: d.createdAt.toISOString(),
			totalAssignments: d.assignments.length,
			proposedCount: proposed,
			approvedCount: approved
		};
	});
}

export interface DraftAssignmentDetail {
	id: string;
	lineItemId: string;
	job: string;
	stationId: string;
	stationName: string;
	stationLabel: string;
	date: string;
	startMinuteOfDay: number | null;
	estimatedHours: number;
	durationMinutes: number;
	sequenceOrder: number;
	status: ScheduleAssignmentStatus;
}

export interface DraftDetail extends DraftSummary {
	assignments: DraftAssignmentDetail[];
	/** The shop's shift model — included here so Claude can compute wall-clock moves
	 *  without asking the user "when does the day start?". */
	shift: typeof SHOP_SHIFT;
}

/**
 * One draft by its cuid or 6-char short code, with every assignment it holds in
 * run order (date → station → sequenceOrder). The `startMinuteOfDay` and
 * `durationMinutes` fields are what move_assignment and the board's cascade act
 * on, so chat can read them directly to compute moves (e.g. a 10-min buffer
 * between items).
 *
 * @throws GetDraftError if no draft matches, or if a short code matches more than
 *   one (asks for the full id).
 */
export async function getDraftForTool(idOrShortCode: string): Promise<DraftDetail> {
	const resolved = await resolveDraftIdOrShortCode(idOrShortCode);
	if (resolved === null) throw new GetDraftError(`No schedule draft matches "${idOrShortCode}". Try list_drafts.`);
	if (resolved === 'AMBIGUOUS') throw new GetDraftError(`Short code "${idOrShortCode}" matches more than one draft; use the full id from list_drafts.`);

	const draft = await prisma.scheduleDraft.findUnique({
		where: { id: resolved },
		include: {
			assignments: {
				orderBy: [{ date: 'asc' }, { stationId: 'asc' }, { sequenceOrder: 'asc' }],
				include: {
					lineItem: { select: { design: true, decorationType: true, finishingStep: true, otherJobType: true, order: { select: { hoopsOrderId: true } } } },
					station: { select: { name: true, label: true } }
				}
			}
		}
	});
	if (!draft) throw new GetDraftError(`No schedule draft with id "${resolved}".`);

	const proposed = draft.assignments.filter((a) => a.status === ScheduleAssignmentStatus.PROPOSED).length;
	const approved = draft.assignments.filter((a) => a.status === ScheduleAssignmentStatus.APPROVED).length;

	const assignments: DraftAssignmentDetail[] = draft.assignments.map((a) => ({
		id: a.id,
		lineItemId: a.lineItemId,
		job: jobLabel(a.lineItem),
		stationId: a.stationId,
		stationName: a.station.name,
		stationLabel: a.station.label,
		date: iso(a.date),
		startMinuteOfDay: a.startMinuteOfDay,
		estimatedHours: a.estimatedHours,
		durationMinutes: Math.max(15, Math.round(a.estimatedHours * 60)),
		sequenceOrder: a.sequenceOrder,
		status: a.status
	}));

	return {
		id: draft.id,
		shortCode: shortDraftCode(draft.id),
		name: draft.name,
		description: draft.description,
		status: draft.status,
		startDate: iso(draft.startDate),
		weeks: draft.weeks,
		strategy: draft.strategy,
		createdBy: draft.createdBy,
		createdAt: draft.createdAt.toISOString(),
		totalAssignments: draft.assignments.length,
		proposedCount: proposed,
		approvedCount: approved,
		assignments,
		shift: SHOP_SHIFT
	};
}
