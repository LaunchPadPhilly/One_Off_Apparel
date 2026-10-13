/**
 * Runs the deterministic engine and saves its plan as a new draft — the shared path
 * behind the `propose_schedule` MCP tool and the board's "Create automatic schedule"
 * button (proposeIntoNewDraft.ts). Saving into a draft (2026-10-05; the MCP tool used to
 * write draft-less rows) means a plan proposed in chat shows up on the board, where a
 * person can look at it, adjust it, and approve it.
 *
 * Nothing here touches the live schedule. The plan is only PROPOSED rows in its own
 * draft; approving it (commitSchedule.ts — the second human gate) is what makes it real
 * and replaces any approved jobs it moved.
 */
import { prisma } from '$lib/server/prisma';
import { DEPENDENCY_REASON_PREFIX, proposeSchedule } from '$lib/server/engine/proposeSchedule';
import { STATION_KINDS } from '$lib/schedule/stationKinds';
import type { AtRiskFlag } from '$lib/server/engine/types';
import { ScheduleAssignmentStatus, ScheduleStrategy } from '../../../../prisma/generated/prisma/enums';
import { buildSchedulingRun, type SchedulingRun } from './committedWork';
import { createDraft } from './draft';
import type { DateRange } from './types';

/** Drafts show at most 4 weeks (draft.ts' createDraftSchema), so a plan can't be longer. */
export const MAX_PROPOSAL_DAYS = 28;

/** One line of "what this plan changes", written for a person to read. */
export interface PlanChange {
	kind: 'new' | 'moved' | 'unchanged' | 'kept_at_risk';
	lineItemId: string;
	job: string;
	from?: { station: string; date: string };
	to?: { station: string; date: string };
}

export interface ProposeAndPersistResult {
	draftId: string;
	/** Orders left off this plan because some job couldn't fit, with the reason shown on the Orders page. */
	unscheduledOrders: { orderId: string; hoopsOrderId: string; reason: string }[];
	/** The board page where people can see and approve this plan. */
	draftPath: string;
	assignmentIds: string[];
	placedCount: number;
	atRisk: AtRiskFlag[];
	changes: PlanChange[];
	reasoning: string[];
}

export interface ProposeOptions {
	range: DateRange;
	/** Approved, not-started jobs dated in this window may move. Null = move nothing. */
	release: DateRange | null;
	name: string;
	description?: string;
	actor: string;
}

function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function dayCount(range: DateRange): number {
	return Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000) + 1;
}

/** A short, readable name for a job: "100127 · Front logo (Screen print)". */
function jobLabel(item: { design: string | null; decorationType: string | null; finishingStep: string | null; otherJobType: string | null; order: { hoopsOrderId: string } }): string {
	const kind = item.decorationType ?? item.finishingStep ?? item.otherJobType ?? 'job';
	return `${item.order.hoopsOrderId} · ${item.design ?? 'untitled'} (${kind.toLowerCase().replace(/_/g, ' ')})`;
}

/**
 * Turns an engine at-risk flag into the sentence shown on the Orders pages, e.g. "Not
 * enough open Screen print time before Oct 13 (needs about 6.3h)." Falls back to the
 * engine's own wording for anything it doesn't recognize.
 */
function plainReason(flag: AtRiskFlag): string {
	const station = STATION_KINDS.find((kind) => kind.key === flag.requiredStation)?.label ?? flag.requiredStation;
	const due = flag.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const hours = /with ([\d.]+)h free/.exec(flag.reason)?.[1];
	if (flag.reason.startsWith('No open slot')) {
		return `Not enough open ${station} time before ${due}${hours ? ` (needs about ${Number(hours).toFixed(1)}h)` : ''}.`;
	}
	if (flag.reason.startsWith(DEPENDENCY_REASON_PREFIX)) {
		return `A step on this order has to wait for another job that couldn't be fitted before ${due}.`;
	}
	return flag.reason;
}

/** Safety cap on engine re-runs while dropping orders that don't fully fit. */
const MAX_WHOLE_ORDER_PASSES = 200;

/**
 * Runs the engine so every order is all-or-nothing (2026-10-13): no plan holds part of
 * an order. When an order is only partly placed (some job couldn't fit before its
 * deadline, or a job it waits on didn't fit), the least urgent such order (latest
 * deadline) is left off and the engine runs again, so the time it was using goes to the
 * rest. Only one partial order is dropped per pass, because removing one can free
 * enough room for another to fit whole. Once no order is partly placed, any order with
 * nothing placed is left off too (it held no time, so nothing re-runs). The engine is
 * deterministic and cheap, so the re-runs only cost milliseconds.
 *
 * @returns the final engine result (only orders that fully fit), the at-risk flags of
 *   every job that was left off, why each dropped order was dropped, and every order
 *   this run considered (so the caller can clear old flags on the ones that fit).
 */
async function planWholeOrders(run: SchedulingRun) {
	const owners = await prisma.lineItem.findMany({ where: { id: { in: run.backlog.map((item) => item.id) } }, select: { id: true, orderId: true } });
	const orderOf = new Map(owners.map((row) => [row.id, row.orderId]));
	const dueOf = new Map<string, number>();
	for (const item of run.backlog) {
		const orderId = orderOf.get(item.id);
		if (orderId) dueOf.set(orderId, Math.max(dueOf.get(orderId) ?? 0, item.dueDate.getTime()));
	}
	const dropped = new Map<string, string>();
	const droppedFlags = new Map<string, AtRiskFlag>();
	const drop = (orderId: string, flags: readonly AtRiskFlag[]) => {
		const own = flags.filter((flag) => orderOf.get(flag.lineItemId) === orderId);
		dropped.set(orderId, own[0] ? plainReason(own[0]) : 'Some of its jobs could not be fitted.');
		for (const flag of own) if (!droppedFlags.has(flag.lineItemId)) droppedFlags.set(flag.lineItemId, flag);
	};
	const plan = () => proposeSchedule(run.backlog.filter((item) => !dropped.has(orderOf.get(item.id) ?? '')), run.capacity, run.externalDependencies);

	let result = plan();
	for (let pass = 0; pass < MAX_WHOLE_ORDER_PASSES && result.atRisk.length > 0; pass++) {
		const atRiskOrders = new Set(result.atRisk.map((flag) => orderOf.get(flag.lineItemId)).filter((id): id is string => !!id));
		const placedOrders = new Set(result.assignments.map((assignment) => orderOf.get(assignment.lineItemId)));
		const partial = [...atRiskOrders].filter((id) => placedOrders.has(id));
		if (partial.length > 0) {
			// Least urgent first (latest deadline); ties broken by id so runs are repeatable.
			partial.sort((a, b) => (dueOf.get(b) ?? 0) - (dueOf.get(a) ?? 0) || a.localeCompare(b));
			drop(partial[0], result.atRisk);
		} else {
			for (const orderId of atRiskOrders) drop(orderId, result.atRisk);
		}
		result = plan();
	}
	// Anything still at risk after the safety cap is reported too.
	for (const flag of result.atRisk) if (!droppedFlags.has(flag.lineItemId)) droppedFlags.set(flag.lineItemId, flag);

	return { result, dropped, atRisk: [...droppedFlags.values()], consideredOrderIds: new Set(owners.map((row) => row.orderId)) };
}

/**
 * Proposes a plan for `range` and saves it as a new draft.
 *
 * @throws Error when the range is backwards or longer than MAX_PROPOSAL_DAYS.
 */
export async function proposeIntoDraft(options: ProposeOptions): Promise<ProposeAndPersistResult> {
	const { range, release, actor } = options;
	const days = dayCount(range);
	if (days < 1) throw new Error(`propose_schedule: "to" (${range.to}) is before "from" (${range.from})`);
	if (days > MAX_PROPOSAL_DAYS) throw new Error(`propose_schedule: a plan can cover at most ${MAX_PROPOSAL_DAYS} days (got ${days})`);

	const run = await buildSchedulingRun(range, release);
	const { result, dropped, atRisk, consideredOrderIds } = await planWholeOrders(run);

	const draft = await createDraft(
		{ name: options.name, description: options.description ?? null, startDate: range.from, weeks: Math.ceil(days / 7), strategy: ScheduleStrategy.BATCH_OPTIMIZE },
		actor
	);

	const assignmentIds = await prisma.$transaction(async (tx) => {
		const ids: string[] = [];
		for (const assignment of result.assignments) {
			const row = await tx.scheduleAssignment.create({
				data: {
					lineItemId: assignment.lineItemId,
					stationId: assignment.stationId,
					date: assignment.date,
					sequenceOrder: assignment.sequenceOrder,
					startMinuteOfDay: assignment.startMinuteOfDay,
					estimatedHours: assignment.estimatedHours,
					status: ScheduleAssignmentStatus.PROPOSED,
					proposedBy: actor,
					scheduleDraftId: draft.id,
					// The day's crew on this station (planStaffing.ts, 2026-09-28).
					crew: { create: assignment.crewWorkerIds.map((workerId) => ({ workerId })) }
				}
			});
			ids.push(row.id);
			await tx.domainAuditLog.create({
				data: {
					entity: 'ScheduleAssignment',
					entityId: row.id,
					action: 'schedule_proposed',
					actor,
					diff: { lineItemId: row.lineItemId, stationId: row.stationId, date: row.date, estimatedHours: row.estimatedHours, scheduleDraftId: draft.id }
				}
			});
		}
		await tx.domainAuditLog.create({
			data: {
				entity: 'ScheduleDraft',
				entityId: draft.id,
				action: 'schedule_draft_auto_proposed',
				actor,
				diff: { placedCount: result.assignments.length, atRiskCount: atRisk.length, unscheduledOrderCount: dropped.size, releasedCount: run.released.length, range, release }
			}
		});

		// The red "Couldn't be scheduled" flag on the Orders pages (2026-10-13): set on
		// orders this plan had to leave off, cleared on the ones it fit.
		const flaggedAt = new Date();
		for (const [orderId, reason] of dropped) {
			await tx.order.update({ where: { id: orderId }, data: { scheduleFlagReason: reason, scheduleFlaggedAt: flaggedAt } });
		}
		const fitOrderIds = [...consideredOrderIds].filter((id) => !dropped.has(id));
		if (fitOrderIds.length > 0) {
			await tx.order.updateMany({ where: { id: { in: fitOrderIds }, scheduleFlagReason: { not: null } }, data: { scheduleFlagReason: null, scheduleFlaggedAt: null } });
		}
		return ids;
	});

	// Describe the plan against what's approved now, so a person can see what moves.
	const lineItemIds = [...new Set([...result.assignments.map((a) => a.lineItemId), ...run.released.map((r) => r.lineItemId)])];
	const [items, stations] = await Promise.all([
		prisma.lineItem.findMany({
			where: { id: { in: lineItemIds } },
			select: { id: true, design: true, decorationType: true, finishingStep: true, otherJobType: true, order: { select: { hoopsOrderId: true } } }
		}),
		prisma.station.findMany({ select: { id: true, label: true } })
	]);
	const labelOf = new Map(items.map((item) => [item.id, jobLabel(item)]));
	const stationLabel = new Map(stations.map((station) => [station.id, station.label]));
	const releasedByItem = new Map(run.released.map((row) => [row.lineItemId, row]));

	const changes: PlanChange[] = result.assignments.map((assignment) => {
		const before = releasedByItem.get(assignment.lineItemId);
		const to = { station: stationLabel.get(assignment.stationId) ?? assignment.stationName, date: iso(assignment.date) };
		const job = labelOf.get(assignment.lineItemId) ?? assignment.lineItemId;
		if (!before) return { kind: 'new', lineItemId: assignment.lineItemId, job, to };
		const from = { station: stationLabel.get(before.stationId) ?? before.stationId, date: iso(before.date) };
		const same = before.stationId === assignment.stationId && iso(before.date) === to.date;
		return { kind: same ? 'unchanged' : 'moved', lineItemId: assignment.lineItemId, job, from, to };
	});
	// A released job the new plan couldn't fit keeps its old approved slot (approving the
	// plan doesn't remove it) — but that slot may no longer have room, so say so.
	for (const flag of atRisk) {
		const before = releasedByItem.get(flag.lineItemId);
		if (!before) continue;
		changes.push({
			kind: 'kept_at_risk',
			lineItemId: flag.lineItemId,
			job: labelOf.get(flag.lineItemId) ?? flag.lineItemId,
			from: { station: stationLabel.get(before.stationId) ?? before.stationId, date: iso(before.date) }
		});
	}

	const droppedOrders = await prisma.order.findMany({ where: { id: { in: [...dropped.keys()] } }, select: { id: true, hoopsOrderId: true } });
	const unscheduledOrders = droppedOrders.map((order) => ({ orderId: order.id, hoopsOrderId: order.hoopsOrderId, reason: dropped.get(order.id) ?? '' }));

	return {
		draftId: draft.id,
		draftPath: `/schedule/drafts/${draft.id}`,
		assignmentIds,
		placedCount: result.assignments.length,
		atRisk,
		unscheduledOrders,
		changes,
		reasoning: result.reasoning
	};
}

/**
 * The `propose_schedule` MCP tool's implementation: a plan for `range`, saved as a
 * draft named after who asked and why.
 *
 * @param release approved, not-started jobs dated in this window may move (a rush order
 *   or someone out); null places only new work around the committed schedule.
 */
export async function proposeAndPersistSchedule(range: DateRange, proposedBy: string, release: DateRange | null = null, reason?: string): Promise<ProposeAndPersistResult> {
	return proposeIntoDraft({
		range,
		release,
		name: `${reason?.trim() ? reason.trim().slice(0, 80) : 'Proposed in chat'} — ${range.from}`,
		description: `Proposed by ${proposedBy} for ${range.from} to ${range.to}${release ? `, re-planning approved jobs from ${release.from} to ${release.to}` : ''}.`,
		actor: proposedBy
	});
}
