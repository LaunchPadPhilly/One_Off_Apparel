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
		| { level: 'order'; field: 'blankOrderingStatus' | 'customerApprovalStatus' }
		| { level: 'lineItem'; lineItemId: string; field: 'artworkApprovalStatus' | MissingLineItemField };
}

export interface OrderInfoNote {
	key: string;
	text: string;
}

export interface OrderGaps {
	questions: OrderGapQuestion[];
	infoNotes: OrderInfoNote[];
}

export interface OrderGapLineItem extends EstimateHoursInput {
	id: string;
	design: string;
	itemType: 'DECORATION' | 'FINISHING';
	artworkApprovalStatus?: string | null;
}

// A handful of import-time flags describe a concern this codebase has since resolved
// structurally (internalDueDate used to be an independent, ambiguous field extracted
// from the same single "Deadline" date — see internalDueDate.ts / CLAUDE.md's Known open
// items). Orders imported before that fix still carry the old flag text in their audit
// log; there's no way to tell "this note is now stale" from free text in general, but
// this one specific, resolved concern is safe to filter by pattern rather than leaving it
// permanently displayed as if it were still an open question.
function isResolvedImportFlag(flag: string): boolean {
	const lower = flag.toLowerCase();
	return lower.includes('internalduedate') && /\b(single|same) date\b/.test(lower);
}

export function computeOrderGaps(
	order: { blankOrderingStatus: string; customerApprovalStatus: string; importFlags: readonly string[] },
	lineItems: readonly OrderGapLineItem[]
): OrderGaps {
	const questions: OrderGapQuestion[] = [];
	const infoNotes: OrderInfoNote[] = order.importFlags
		.filter((flag) => !isResolvedImportFlag(flag))
		.map((flag, i) => ({ key: `import-flag:${i}`, text: flag }));

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
		if (item.itemType === 'DECORATION' && item.artworkApprovalStatus !== 'APPROVED') {
			questions.push({
				key: `${item.id}:artwork`,
				question: `Has artwork been approved for "${item.design}"?`,
				target: { level: 'lineItem', lineItemId: item.id, field: 'artworkApprovalStatus' }
			});
		}

		const estimate = estimateForDisplay(item);
		if (estimate.ok) continue;

		if (estimate.category === 'missing_data') {
			questions.push({
				key: `${item.id}:${estimate.field}`,
				question: fieldQuestion(estimate.field, item.design),
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

	return { questions, infoNotes };
}

function fieldQuestion(field: MissingLineItemField, design: string): string {
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
	}
}
