import { prisma } from '$lib/server/prisma';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import type { PlacementChange } from './draftDependencies';
import { loadDraftProblems } from './draftProblemsServer';
import { clockLabel, dayLabel, problemJobLabel, type DraftProblem } from '$lib/schedule/draftProblems';

/**
 * One wrapper for every edit to a draft from Claude's tools (and the board's moves)
 * (2026-10-16), so each one:
 * - can be **checked without saving** (`dryRun`): the edit runs in a transaction that's
 *   rolled back, and what it would do — other jobs moved, problems it would create —
 *   comes back. Claude uses this to question a change before making it.
 * - says in plain words what **else** it moved (`changes`), for Claude to tell the person
 *   and for the board's "what else changed" pop-up.
 * - reports the draft's **problems** after it (draftProblems.ts) and which ones it added.
 * - leaves a `draft_edited` audit entry when made through Claude — the board polls these
 *   (routes/schedule/drafts/[id]/activity) to show the pop-up to whoever has it open.
 */

type Tx = Prisma.TransactionClient;

export interface DraftEditOptions {
	via: 'board' | 'claude';
	/** Work out what the edit would do, then undo it. */
	dryRun?: boolean;
	/** Check the draft after the edit (costs a board load; Claude's tools only). */
	withProblems?: boolean;
}

export interface DraftEditOutcome<T> {
	result: T;
	/** Other jobs this edit moved, in plain words. */
	changes: string[];
	/** Every problem on the draft after the edit (withProblems). */
	problems?: DraftProblem[];
	/** The problems this edit added (withProblems). */
	newProblems?: DraftProblem[];
	/** True when nothing was saved. */
	dryRun: boolean;
}

class DryRunRollback extends Error {
	constructor(readonly payload: unknown) {
		super('dry run');
	}
}

/** `"Front logo" (screen print, #100127): Press 1 Tue Oct 20 9:00am → Wed Oct 21 8:00am`. */
export async function describeChanges(db: Tx, changes: readonly PlacementChange[]): Promise<string[]> {
	if (changes.length === 0) return [];
	const [items, stations] = await Promise.all([
		db.lineItem.findMany({
			where: { id: { in: [...new Set(changes.map((c) => c.lineItemId))] } },
			select: { id: true, design: true, decorationType: true, finishingStep: true, otherJobType: true, order: { select: { hoopsOrderId: true } } }
		}),
		db.station.findMany({ select: { id: true, label: true } })
	]);
	const itemById = new Map(items.map((item) => [item.id, item]));
	const stationLabel = new Map(stations.map((s) => [s.id, s.label]));
	return changes.map((c) => {
		const item = itemById.get(c.lineItemId);
		const job = item ? problemJobLabel(item, item.order.hoopsOrderId) : 'A job';
		const from = `${stationLabel.get(c.from.stationId) ?? 'a station'} ${dayLabel(c.from.date)} ${clockLabel(c.from.startMin)}`;
		const toStation = c.to.stationId === c.from.stationId ? '' : `${stationLabel.get(c.to.stationId) ?? 'a station'} `;
		return `${job}: ${from} → ${toStation}${dayLabel(c.to.date)} ${clockLabel(c.to.startMin)}`;
	});
}

/**
 * Runs `edit` in one transaction and returns what it did (see the file comment).
 * `summary` is the one line recorded for the board's pop-up, e.g. "Moved … to Press 2".
 */
export async function runDraftEdit<T extends { changes: readonly PlacementChange[] }>(
	draftId: string,
	actor: string,
	summary: (result: T) => string,
	options: DraftEditOptions,
	edit: (tx: Tx) => Promise<T>
): Promise<DraftEditOutcome<T>> {
	const beforeKeys = options.withProblems ? new Set((await loadDraftProblems(draftId)).map((p) => p.key)) : null;
	try {
		return await prisma.$transaction(
			async (tx) => {
				const result = await edit(tx);
				const changes = await describeChanges(tx, result.changes);
				const problems = options.withProblems ? await loadDraftProblems(draftId, tx) : undefined;
				const outcome: DraftEditOutcome<T> = {
					result,
					changes,
					problems,
					newProblems: problems && beforeKeys ? problems.filter((p) => !beforeKeys.has(p.key)) : undefined,
					dryRun: options.dryRun === true
				};
				if (options.dryRun) throw new DryRunRollback(outcome);
				if (options.via === 'claude') {
					await tx.domainAuditLog.create({
						data: { entity: 'ScheduleDraft', entityId: draftId, action: 'draft_edited', actor, diff: { via: options.via, summary: summary(result), changes } }
					});
				}
				return outcome;
			},
			{ timeout: 30_000 }
		);
	} catch (error) {
		if (error instanceof DryRunRollback) return error.payload as DraftEditOutcome<T>;
		throw error;
	}
}

/** What Claude's draft tools return about problems: short, and only what matters. */
export function problemsForTool(outcome: { problems?: DraftProblem[]; newProblems?: DraftProblem[] }) {
	const slim = (p: DraftProblem) => ({ severity: p.severity, blocksApproval: p.blocking, message: p.message, assignmentIds: p.placementIds });
	const problems = outcome.problems ?? [];
	return {
		canApprove: !problems.some((p) => p.blocking),
		newProblems: (outcome.newProblems ?? []).map(slim),
		allProblems: problems.map(slim)
	};
}
