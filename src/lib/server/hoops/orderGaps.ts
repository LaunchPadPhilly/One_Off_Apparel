import { estimateForDisplay } from '$lib/server/engine/estimateForDisplay';
import type { EstimateHoursInput } from '$lib/server/engine/types';
import type { MissingLineItemField } from '$lib/server/engine/estimateHours';

/**
 * What's outstanding on an order, split into two kinds:
 *
 * - `questions`: gaps that map to a real, settable field (an order-level approval gate,
 *   or a specific line item's artwork-approval / missing estimate data). Each one names
 *   its exact target field, so an answer — whether typed by hand into the per-item edit
 *   form, or extracted from a reviewer's free-text note by fillNeedsAttentionFromNotes —
 *   can be applied precisely rather than guessed from prose.
 * - `infoNotes`: everything else Claude flagged at import time, plus estimate gaps with
 *   no backing field at all yet (a station with no formula — see CLAUDE.md's Known open
 *   items). No note can resolve these; they're surfaced for awareness only.
 *
 * Shared by the order page's load (to render "Needs attention") and
 * fillNeedsAttentionFromNotes.ts (to build the exact question set Claude is allowed to
 * answer, and to apply its answers to the right field) — one source of truth for what
 * counts as an outstanding gap.
 */
export interface OrderGapQuestion {
	key: string;
	question: string;
	target:
		| { level: 'order'; field: 'deadline' | 'blankOrderingStatus' | 'customerApprovalStatus' }
		| { level: 'lineItem'; lineItemId: string; field: 'artworkApprovalStatus' | MissingLineItemField };
}

export interface OrderInfoNote {
	key: string;
	text: string;
}

export interface OrderGaps {
	questions: OrderGapQuestion[];
	infoNotes: OrderInfoNote[];
	/**
	 * NEW (2026-09-23): how many things stop this order from being valid — every
	 * question above (approvals, artwork, missing estimate data) plus every line item
	 * with no formula at all. Import-time flags don't count (they're context). Zero
	 * means ready: confirmImport.ts refuses to confirm while this is > 0, and a
	 * CONFIRMED order with this > 0 is shown as "Needs re-review".
	 */
	blockingCount: number;
}

export interface OrderGapLineItem extends EstimateHoursInput {
	id: string;
	design: string;
	itemType: 'DECORATION' | 'FINISHING' | 'OTHER';
	artworkApprovalStatus?: string | null;
}

// Old import-time flags describe a concern this codebase has since resolved structurally
// (internalDueDate used to be extracted independently from the same single "Deadline"
// date, and later — briefly — computed from it deterministically; both are gone now,
// see the 2026-09-28 deadline-tightness change). Orders imported before those fixes
// still carry the old flag text in their audit log; there's no way to tell "this note is
// now stale" from free text in general, but these one-off resolved concerns are safe to
// filter by pattern rather than leaving them permanently displayed as open questions.
function isResolvedImportFlag(flag: string): boolean {
	const lower = flag.toLowerCase();
	return lower.includes('internalduedate') || lower.includes('internal due date');
}

export function computeOrderGaps(
	// deadline is required (not optional) on purpose: an order with no deadline must
	// always come back with that question, so no caller can forget to pass it.
	order: { deadline: Date | string | null; blankOrderingStatus: string; customerApprovalStatus: string; importFlags: readonly string[] },
	lineItems: readonly OrderGapLineItem[]
): OrderGaps {
	const questions: OrderGapQuestion[] = [];
	const infoNotes: OrderInfoNote[] = order.importFlags
		.filter((flag) => !isResolvedImportFlag(flag))
		.map((flag, i) => ({ key: `import-flag:${i}`, text: flag }));

	// An export with no Deadline imports with no deadline set.
	if (!order.deadline) {
		questions.push({
			key: 'deadline',
			question: 'What is the deadline for this order? The export didn’t have one.',
			target: { level: 'order', field: 'deadline' }
		});
	}
	if (order.blankOrderingStatus !== 'RECEIVED') {
		questions.push({
			key: 'blanks',
			question: 'Have blanks for this order been ordered, and have they arrived yet?',
			target: { level: 'order', field: 'blankOrderingStatus' }
		});
	}
	if (order.customerApprovalStatus !== 'APPROVED') {
		questions.push({
			key: 'customer-approval',
			question: 'Has the customer approved this order yet?',
			target: { level: 'order', field: 'customerApprovalStatus' }
		});
	}

	// Two line items easily share the exact same missing-formula reason (e.g. two
	// "Matte Finish" rows, same station, same "no formula yet" message) — counted by
	// exact reason text instead of one bullet per line item, same reasoning as the
	// grouped display already used for questions below.
	const missingFormulaByReason = new Map<string, { count: number; firstDesign: string }>();

	for (const item of lineItems) {
		// No artwork-approval question (client decision, 2026-09-28): artwork is always
		// considered done, so it never blocks confirming or scheduling.
		const estimate = estimateForDisplay(item);
		if (estimate.ok) continue;

		if (estimate.category === 'missing_data') {
			questions.push({
				key: `${item.id}:${estimate.field}`,
				question: fieldQuestion(estimate.field, item),
				target: { level: 'lineItem', lineItemId: item.id, field: estimate.field }
			});
		} else {
			// missing_formula — the station itself has no formula yet (or needs a client
			// decision per CLAUDE.md's Known open items). No field exists to answer this
			// with, so it stays informational, never a question.
			const entry = missingFormulaByReason.get(estimate.reason);
			if (entry) entry.count += 1;
			else missingFormulaByReason.set(estimate.reason, { count: 1, firstDesign: item.design });
		}
	}

	for (const [reason, { count, firstDesign }] of missingFormulaByReason) {
		infoNotes.push({ key: `estimate:${reason}`, text: count === 1 ? `${firstDesign}: ${reason}` : `${reason} (${count} line items)` });
	}

	let noFormulaCount = 0;
	for (const { count } of missingFormulaByReason.values()) noFormulaCount += count;

	return { questions, infoNotes, blockingCount: questions.length + noFormulaCount };
}

/** "Can't confirm yet" copy shared by the confirm gate and the pages that show it. */
export function describeBlockers(blockingCount: number): string {
	return `${blockingCount} open item${blockingCount === 1 ? '' : 's'} to resolve (see Needs attention)`;
}

function fieldQuestion(field: MissingLineItemField, item: OrderGapLineItem): string {
	const design = item.design;
	switch (field) {
		case 'inkColorCount':
			return `What is the ink/thread color count for "${design}"?`;
		case 'stitchCount':
			return `What is the stitch count for "${design}"?`;
		case 'garmentStyle':
			return `Is "${design}" a flat garment or a cap?`;
		case 'capConstruction':
			return `Is "${design}" a structured or unstructured cap?`;
		case 'matteSurface':
			return `Is the matte finish on "${design}" a flat or specialty surface?`;
		case 'foldBagGarment':
			return `Is "${design}" being folded & bagged a short-sleeve tee or another garment?`;
		case 'manualEstimatedHours':
			return item.itemType === 'OTHER'
				? `How many hours does "${design}" need? (${item.otherJobType ?? 'This job type'} has no formula yet.)`
				: `How many hours does "${design}" need? (DTF/DTG has no formula — time depends on the artwork.)`;
		case 'assignedStationId':
			return `What station is "${design}" assigned to? (${item.otherJobType ?? 'This job type'} isn't a job type the system knows yet.)`;
	}
}
