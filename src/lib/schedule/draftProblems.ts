import { WORKING_MIN, SHIFT_START_MIN, wallClockEnd, workingMinutesUntilShiftEnd } from './shift';
import { isPressKind } from './stationKinds';
import { isWeekendDay } from './defaultCapacity';

/**
 * What's wrong with a draft schedule (2026-10-16, client decision: manual moves are
 * allowed and flagged rather than refused). The ONE checker shared by the draft board
 * (live, as jobs are dragged), the Approve gate (commitDraft callers) and Claude's
 * draft tools (get_draft / move_assignment / set_draft_crew / shift_draft), so the
 * board's highlights, the server's refusal to approve and what Claude is told can't
 * disagree. Pure — no server imports — so the browser can run it.
 *
 * Severity:
 * - **red** blocks approval while it involves a proposed job: two jobs overlapping on a
 *   station, a job running past the end of the shift, a finishing step before the job it
 *   waits on, a station with jobs and nobody on it, a press crew without a main or
 *   operator, a person on two stations (or marked out) that day, a job late for a firm
 *   (tight) deadline, an order only partly on the schedule, a station over its open hours.
 * - **orange** is a warning only: late for an internal (loose) deadline, a weekend day,
 *   a job longer than a whole shift.
 * Problems that only involve approved / started jobs are listed but never block — they
 * can't be fixed by approving or not approving this draft.
 */

export type ProblemSeverity = 'red' | 'orange';

export type ProblemKind =
	| 'overlap'
	| 'past_shift_end'
	| 'longer_than_shift'
	| 'before_dependency'
	| 'dependency_missing'
	| 'no_crew'
	| 'press_no_lead'
	| 'worker_double_booked'
	| 'worker_out'
	| 'late'
	| 'order_incomplete'
	| 'over_capacity'
	| 'weekend';

export interface DraftProblem {
	/** Stable across recomputes, for keyed lists. */
	key: string;
	severity: ProblemSeverity;
	kind: ProblemKind;
	/** Plain words for the person (and for Claude to repeat). */
	message: string;
	/** Jobs in this draft to highlight. */
	placementIds: string[];
	date?: string;
	stationName?: string;
	orderId?: string;
	/** Red and touching at least one proposed job: approval is refused until it's fixed. */
	blocking: boolean;
}

export interface ProblemCrewMember {
	id: string;
	name: string;
	role: 'MAIN' | 'OPERATOR' | 'CATCH';
}

/** One job in the draft being checked. */
export interface ProblemPlacement {
	id: string;
	lineItemId: string;
	orderId: string;
	date: string;
	stationName: string;
	startMin: number;
	durationMin: number;
	status: string;
	crew: readonly ProblemCrewMember[];
	/** A press job whose planned crew had no lead (boardData hides that crew). */
	noLead?: boolean;
}

/** Committed work outside this draft (approved / started, other drafts) — it occupies stations and people too. */
export interface ProblemBusyBlock {
	id: string;
	lineItemId: string;
	date: string;
	stationName: string;
	startMin: number;
	durationMin: number;
	crewIds: readonly string[];
	label: string;
}

export interface ProblemLineItem {
	id: string;
	orderId: string;
	itemType: string;
	dependsOn: string | null;
	status: string;
	label: string;
	/** Needs a slot on a schedule: estimable, not outsourced, not already complete. */
	needsSlot: boolean;
}

export interface ProblemOrder {
	id: string;
	hoopsOrderId: string;
	/** YYYY-MM-DD, or null/'' when not set. */
	deadline: string | null;
	deadlineIsTight: boolean;
}

export interface ProblemContext {
	placements: readonly ProblemPlacement[];
	elsewhere: readonly ProblemBusyBlock[];
	lineItems: readonly ProblemLineItem[];
	orders: readonly ProblemOrder[];
	stations: readonly { name: string; label: string; kind: string }[];
	/** People on the roster; with none, nobody is ever "missing" from a station. */
	rosterSize: number;
	out: readonly { date: string; workerId: string }[];
	/** Open hours per "date::stationName" (capacity calendar / default). Missing = a full shift. */
	availableHours?: ReadonlyMap<string, number>;
	/** Display name per worker id, for messages about people. */
	workerNames?: ReadonlyMap<string, string>;
}

// Same literals as $lib/server/engine/types.ts (not importable from the browser).
const ALL_SIBLINGS = 'all_siblings';
const ALL_DECORATIONS = 'all_decorations';

/** "Tue Oct 20" for a YYYY-MM-DD day. */
export function dayLabel(isoDay: string): string {
	return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Minutes after midnight as "9:15am". */
export function clockLabel(minute: number): string {
	const h24 = Math.floor(minute / 60);
	const m = minute % 60;
	const h12 = ((h24 + 11) % 12) + 1;
	return `${h12}:${String(m).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`;
}

function endOf(p: { startMin: number; durationMin: number }): number {
	return wallClockEnd(p.startMin, p.durationMin);
}

/** Working minutes of a job that don't fit between its start and the end of the shift. */
export function overflowMinutes(p: { startMin: number; durationMin: number }): number {
	return Math.max(0, p.durationMin - workingMinutesUntilShiftEnd(p.startMin));
}

export function findDraftProblems(ctx: ProblemContext): DraftProblem[] {
	const problems: DraftProblem[] = [];
	const stationByName = new Map(ctx.stations.map((s) => [s.name, s]));
	const stationLabel = (name: string) => stationByName.get(name)?.label ?? name;
	const lineItemById = new Map(ctx.lineItems.map((li) => [li.id, li]));
	const orderById = new Map(ctx.orders.map((o) => [o.id, o]));
	const jobLabel = (lineItemId: string) => lineItemById.get(lineItemId)?.label ?? 'A job';
	const placementById = new Map(ctx.placements.map((p) => [p.id, p]));
	const isProposed = (id: string) => placementById.get(id)?.status === 'PROPOSED';
	const workerName = (id: string, fallback?: string) => ctx.workerNames?.get(id) ?? fallback ?? 'Someone';

	function add(problem: Omit<DraftProblem, 'blocking'>) {
		problems.push({ ...problem, blocking: problem.severity === 'red' && problem.placementIds.some(isProposed) });
	}

	// Jobs this draft re-places: their old committed slot is replaced on approval, so it
	// neither occupies the station nor counts as "scheduled elsewhere".
	const lineItemsInDraft = new Set(ctx.placements.map((p) => p.lineItemId));
	const elsewhere = ctx.elsewhere.filter((b) => !lineItemsInDraft.has(b.lineItemId));

	// ── Per station-day: overlap, past the shift, over open hours, crew ──────────
	type Slot = { date: string; stationName: string; jobs: ProblemPlacement[]; busy: ProblemBusyBlock[] };
	const slots = new Map<string, Slot>();
	const slotOf = (date: string, stationName: string) => {
		const key = `${date}::${stationName}`;
		let slot = slots.get(key);
		if (!slot) slots.set(key, (slot = { date, stationName, jobs: [], busy: [] }));
		return slot;
	};
	for (const p of ctx.placements) slotOf(p.date, p.stationName).jobs.push(p);
	for (const b of elsewhere) slotOf(b.date, b.stationName).busy.push(b);

	for (const [key, slot] of slots) {
		if (slot.jobs.length === 0) continue;
		const where = `${stationLabel(slot.stationName)} on ${dayLabel(slot.date)}`;

		const timeline = [
			...slot.jobs.map((p) => ({ id: p.id, inDraft: true, label: jobLabel(p.lineItemId), startMin: p.startMin, durationMin: p.durationMin })),
			...slot.busy.map((b) => ({ id: b.id, inDraft: false, label: `${b.label} (already approved)`, startMin: b.startMin, durationMin: b.durationMin }))
		].sort((a, b) => a.startMin - b.startMin);
		for (let i = 0; i < timeline.length; i++) {
			for (let j = i + 1; j < timeline.length; j++) {
				const a = timeline[i];
				const b = timeline[j];
				if (b.startMin >= endOf(a)) break;
				if (!a.inDraft && !b.inDraft) continue;
				add({
					key: `overlap:${a.id}:${b.id}`,
					severity: 'red',
					kind: 'overlap',
					message: `${a.label} and ${b.label} overlap on ${where} (${clockLabel(b.startMin)}–${clockLabel(Math.min(endOf(a), endOf(b)))}).`,
					placementIds: [a, b].filter((x) => x.inDraft).map((x) => x.id),
					date: slot.date,
					stationName: slot.stationName
				});
			}
		}

		for (const p of slot.jobs) {
			const over = overflowMinutes(p);
			if (over <= 0) continue;
			if (p.durationMin > WORKING_MIN && p.startMin <= SHIFT_START_MIN) {
				add({
					key: `long:${p.id}`,
					severity: 'orange',
					kind: 'longer_than_shift',
					message: `${jobLabel(p.lineItemId)} takes ${Math.round((p.durationMin / 60) * 10) / 10}h — longer than one shift on ${where}; it carries over.`,
					placementIds: [p.id],
					date: slot.date,
					stationName: slot.stationName
				});
				continue;
			}
			add({
				key: `pastend:${p.id}`,
				severity: 'red',
				kind: 'past_shift_end',
				message: `${jobLabel(p.lineItemId)} runs ${over} min past the end of the shift (4:30pm) on ${where}.`,
				placementIds: [p.id],
				date: slot.date,
				stationName: slot.stationName
			});
		}

		const open = ctx.availableHours?.get(key);
		if (open !== undefined && open * 60 < WORKING_MIN) {
			const used = [...slot.jobs, ...slot.busy].reduce((sum, x) => sum + x.durationMin, 0);
			if (used > open * 60 + 1) {
				add({
					key: `capacity:${key}`,
					severity: 'red',
					kind: 'over_capacity',
					message:
						open === 0
							? `${where} is closed that day, but has jobs on it.`
							: `${where} is only open ${open}h that day, but has ${Math.round((used / 60) * 10) / 10}h of work.`,
					placementIds: slot.jobs.map((p) => p.id),
					date: slot.date,
					stationName: slot.stationName
				});
			}
		}

		if (isWeekendDay(slot.date)) {
			add({
				key: `weekend:${key}`,
				severity: 'orange',
				kind: 'weekend',
				message: `${where} is a weekend day — the shop is normally closed.`,
				placementIds: slot.jobs.map((p) => p.id),
				date: slot.date,
				stationName: slot.stationName
			});
		}

		// Crew: one person works one station all day, so the row's crew is everyone on any of its jobs.
		const proposed = slot.jobs.filter((p) => p.status === 'PROPOSED');
		if (ctx.rosterSize > 0 && proposed.length > 0) {
			const crew = new Map<string, ProblemCrewMember>();
			for (const p of slot.jobs) for (const m of p.crew) crew.set(m.id, m);
			const press = isPressKind(stationByName.get(slot.stationName)?.kind);
			const noLead = press && (slot.jobs.some((p) => p.noLead) || (crew.size > 0 && ![...crew.values()].some((m) => m.role === 'MAIN' || m.role === 'OPERATOR')));
			if (noLead) {
				add({
					key: `nolead:${key}`,
					severity: 'red',
					kind: 'press_no_lead',
					message: `${where} has no main printer or operator — a press can't run on catches alone.`,
					placementIds: proposed.map((p) => p.id),
					date: slot.date,
					stationName: slot.stationName
				});
			} else if (crew.size === 0) {
				add({
					key: `nocrew:${key}`,
					severity: 'red',
					kind: 'no_crew',
					message: `Nobody is on ${where} — drag someone from People onto it, or use Re-plan crews.`,
					placementIds: proposed.map((p) => p.id),
					date: slot.date,
					stationName: slot.stationName
				});
			}
		}
	}

	// ── People: on two stations in one day, or marked out ───────────────────────
	const outSet = new Set(ctx.out.map((o) => `${o.workerId}|${o.date}`));
	const stationsByWorkerDay = new Map<string, { stations: Set<string>; placementIds: Set<string>; name: string }>();
	const note = (workerId: string, date: string, stationName: string, placementId: string | null, name?: string) => {
		const key = `${workerId}|${date}`;
		let entry = stationsByWorkerDay.get(key);
		if (!entry) stationsByWorkerDay.set(key, (entry = { stations: new Set(), placementIds: new Set(), name: workerName(workerId, name) }));
		entry.stations.add(stationName);
		if (placementId) entry.placementIds.add(placementId);
	};
	for (const p of ctx.placements) for (const m of p.crew) note(m.id, p.date, p.stationName, p.id, m.name);
	for (const b of elsewhere) for (const id of b.crewIds) note(id, b.date, b.stationName, null);
	for (const [key, entry] of stationsByWorkerDay) {
		const [workerId, date] = key.split('|');
		if (entry.placementIds.size === 0) continue;
		if (entry.stations.size > 1) {
			add({
				key: `double:${key}`,
				severity: 'red',
				kind: 'worker_double_booked',
				message: `${entry.name} is on ${[...entry.stations].map(stationLabel).join(' and ')} on ${dayLabel(date)} — one person works one station a day.`,
				placementIds: [...entry.placementIds],
				date
			});
		}
		if (outSet.has(key)) {
			add({
				key: `out:${key}`,
				severity: 'red',
				kind: 'worker_out',
				message: `${entry.name} is marked out on ${dayLabel(date)} but is on the crew.`,
				placementIds: [...entry.placementIds],
				date
			});
		}
	}

	// ── Orders: late, only partly placed ────────────────────────────────────────
	for (const p of ctx.placements) {
		const order = orderById.get(p.orderId);
		if (!order?.deadline || p.date <= order.deadline) continue;
		add({
			key: `late:${p.id}`,
			severity: order.deadlineIsTight ? 'red' : 'orange',
			kind: 'late',
			message: `${jobLabel(p.lineItemId)} is on ${dayLabel(p.date)}, after Job ${order.hoopsOrderId}'s ${order.deadlineIsTight ? 'firm' : 'internal'} deadline (${dayLabel(order.deadline)}).`,
			placementIds: [p.id],
			date: p.date,
			stationName: p.stationName,
			orderId: order.id
		});
	}

	const scheduled = new Set([...ctx.placements.map((p) => p.lineItemId), ...elsewhere.map((b) => b.lineItemId)]);
	const incompleteOrders = new Set<string>();
	const proposedOrderIds = new Set(ctx.placements.filter((p) => p.status === 'PROPOSED').map((p) => p.orderId));
	for (const orderId of proposedOrderIds) {
		const missing = ctx.lineItems.filter((li) => li.orderId === orderId && li.needsSlot && !scheduled.has(li.id));
		if (missing.length === 0) continue;
		incompleteOrders.add(orderId);
		const order = orderById.get(orderId);
		add({
			key: `incomplete:${orderId}`,
			severity: 'red',
			kind: 'order_incomplete',
			message: `Job ${order?.hoopsOrderId ?? ''} is only partly on this schedule — not placed: ${missing.map((li) => li.label).join(', ')}.`,
			placementIds: ctx.placements.filter((p) => p.orderId === orderId).map((p) => p.id),
			orderId
		});
	}

	// ── Finishing steps after what they wait on ─────────────────────────────────
	const slotByLineItem = new Map<string, { date: string; startMin: number; durationMin: number }>();
	for (const b of elsewhere) slotByLineItem.set(b.lineItemId, b);
	for (const p of ctx.placements) slotByLineItem.set(p.lineItemId, p);
	for (const p of ctx.placements) {
		const item = lineItemById.get(p.lineItemId);
		if (!item || item.itemType !== 'FINISHING' || !item.dependsOn) continue;
		const deps =
			item.dependsOn === ALL_SIBLINGS
				? ctx.lineItems.filter((li) => li.orderId === item.orderId && li.id !== item.id)
				: item.dependsOn === ALL_DECORATIONS
					? ctx.lineItems.filter((li) => li.orderId === item.orderId && li.itemType === 'DECORATION')
					: ctx.lineItems.filter((li) => li.id === item.dependsOn);
		for (const dep of deps) {
			if (dep.status === 'COMPLETE' || !dep.needsSlot) continue;
			const depSlot = slotByLineItem.get(dep.id);
			if (!depSlot) {
				if (incompleteOrders.has(item.orderId)) continue; // already said
				add({
					key: `depmissing:${p.id}:${dep.id}`,
					severity: 'red',
					kind: 'dependency_missing',
					message: `${item.label} waits on ${dep.label}, which isn't scheduled.`,
					placementIds: [p.id],
					date: p.date,
					orderId: item.orderId
				});
				continue;
			}
			const depEnd = endOf(depSlot);
			const before = p.date < depSlot.date || (p.date === depSlot.date && p.startMin < depEnd);
			if (!before) continue;
			const depPlacement = ctx.placements.find((q) => q.lineItemId === dep.id);
			add({
				key: `before:${p.id}:${dep.id}`,
				severity: 'red',
				kind: 'before_dependency',
				message: `${item.label} starts ${dayLabel(p.date)} ${clockLabel(p.startMin)}, before ${dep.label} finishes (${dayLabel(depSlot.date)} ${clockLabel(depEnd)}).`,
				placementIds: depPlacement ? [p.id, depPlacement.id] : [p.id],
				date: p.date,
				stationName: p.stationName,
				orderId: item.orderId
			});
		}
	}

	return problems.sort((a, b) => Number(b.severity === 'red') - Number(a.severity === 'red') || (a.date ?? '').localeCompare(b.date ?? ''));
}

/** Problems that stop this draft being approved. */
export function blockingProblems(problems: readonly DraftProblem[]): DraftProblem[] {
	return problems.filter((p) => p.blocking);
}

/** Highest severity per placement id, for highlighting. */
export function severityByPlacement(problems: readonly DraftProblem[]): Map<string, ProblemSeverity> {
	const map = new Map<string, ProblemSeverity>();
	for (const problem of problems) {
		for (const id of problem.placementIds) {
			if (map.get(id) !== 'red') map.set(id, problem.severity);
		}
	}
	return map;
}

/** The parts of the board's data (boardData.ts) the checker reads. */
export interface ProblemBoardData {
	orders: readonly {
		id: string;
		hoopsOrderId: string;
		deadline: string;
		deadlineIsTight: boolean;
		lineItems: readonly {
			id: string;
			design: string;
			itemType: string;
			decorationType: string | null;
			finishingStep: string | null;
			otherJobType?: string | null;
			dependsOn: string | null;
			status: string;
			outsourced?: boolean | null;
			estimate: { ok: boolean };
		}[];
	}[];
	stations: readonly { name: string; label: string; kind: string }[];
	people: readonly { id: string; name: string }[];
	peopleOut: readonly { date: string; workerId: string }[];
	capacity: readonly { date: string; stations: readonly { name: string; availableHrs: number }[] }[];
	elsewhere: readonly ProblemBusyBlock[];
}

/** `"Front logo" (#100127)` — how a job is named in problem messages. */
export function problemJobLabel(item: { design: string; decorationType: string | null; finishingStep: string | null; otherJobType?: string | null }, hoopsOrderId: string): string {
	const step = (item.decorationType ?? item.finishingStep ?? item.otherJobType ?? 'job').toLowerCase().replace(/_/g, ' ');
	return `"${item.design || step}" ${item.design ? `(${step}, #${hoopsOrderId})` : `(#${hoopsOrderId})`}`;
}

/** Builds the checker's input from board data plus the jobs as they are now (the board passes its live copy). */
export function problemContextFromBoard(board: ProblemBoardData, placements: readonly ProblemPlacement[]): ProblemContext {
	const availableHours = new Map<string, number>();
	for (const day of board.capacity) for (const s of day.stations) availableHours.set(`${day.date}::${s.name}`, s.availableHrs);
	return {
		placements,
		elsewhere: board.elsewhere,
		lineItems: board.orders.flatMap((order) =>
			order.lineItems.map((item) => ({
				id: item.id,
				orderId: order.id,
				itemType: item.itemType,
				dependsOn: item.dependsOn,
				status: item.status,
				label: problemJobLabel(item, order.hoopsOrderId),
				needsSlot: item.estimate.ok && item.status !== 'COMPLETE' && item.outsourced !== true
			}))
		),
		orders: board.orders.map((order) => ({ id: order.id, hoopsOrderId: order.hoopsOrderId, deadline: order.deadline || null, deadlineIsTight: order.deadlineIsTight })),
		stations: board.stations,
		rosterSize: board.people.length,
		out: board.peopleOut,
		availableHours,
		workerNames: new Map(board.people.map((p) => [p.id, p.name]))
	};
}
