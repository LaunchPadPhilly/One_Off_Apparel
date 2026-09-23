import { z } from 'zod';
import { proposeSchedule } from '$lib/server/engine/proposeSchedule';
import type { ProposeScheduleResult } from '$lib/server/engine/types';
import { fetchBacklog, fetchCapacity } from './buildBacklogAndCapacity';
import { dateRangeSchema } from './types';

/**
 * CLAUDE.md names exactly two examples ("a rush order, a moved job") and no general
 * shape. Modeled narrowly as those two cases rather than a generic patch/diff format —
 * extend this union if a real third case shows up, don't generalize ahead of need.
 */
export const simulateChangeSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('rush_order'),
		// A hypothetical line item, not yet in the backlog, to test against real capacity.
		lineItem: z.object({
			itemType: z.enum(['DECORATION', 'FINISHING']),
			decorationType: z.enum(['SCREEN_PRINT', 'EMBROIDERY', 'DTF', 'DTG']).nullish(),
			finishingStep: z.enum(['MATTE', 'RELABEL', 'FOLD_BAG', 'HANG_TAG', 'WOVENS']).nullish(),
			inkColorCount: z.number().int().nonnegative().nullish(),
			screens: z.number().int().nonnegative().nullish(),
			stitchCount: z.number().int().nonnegative().nullish(),
			garmentStyle: z.enum(['FLAT', 'CAP']).nullish(),
			capConstruction: z.enum(['STRUCTURED', 'UNSTRUCTURED']).nullish(),
			matteSurface: z.enum(['FLAT', 'SPECIALTY']).nullish(),
			foldBagGarment: z.enum(['SS_TEE', 'OTHER']).nullish(),
			quantity: z.number().int().positive(),
			weightClass: z.enum(['THIN', 'POLY', 'BULKY']),
			dueDate: z.iso.date()
		}),
		range: dateRangeSchema
	}),
	z.object({
		type: z.literal('move_job'),
		// An existing (real) backlog line item, with a hypothetical due date in place of
		// its real order's internal_due_date — "what if this needs to move to <date>?"
		lineItemId: z.string(),
		hypotheticalDueDate: z.iso.date(),
		range: dateRangeSchema
	})
]);

export type SimulateChangeInput = z.infer<typeof simulateChangeSchema>;

/**
 * Checks a "what if" against real capacity without changing anything — no database
 * write of any kind, ever (unlike propose_schedule, which persists drafts). Reuses the
 * same pure engine function propose_schedule does, against a hypothetically-modified
 * copy of the real backlog.
 */
export async function simulateChange(input: SimulateChangeInput): Promise<ProposeScheduleResult> {
	const [{ backlog, externalDependencies }, capacity] = await Promise.all([fetchBacklog(), fetchCapacity(input.range)]);

	if (input.type === 'rush_order') {
		// dueDate arrives as an ISO date string (z.iso.date(), so the tool's advertised
		// input schema stays representable in JSON Schema) — the engine needs a real Date.
		const hypothetical = { ...input.lineItem, dueDate: new Date(input.lineItem.dueDate), id: `simulated-rush-${Date.now()}` };
		return proposeSchedule([...backlog, hypothetical], capacity, externalDependencies);
	}

	const target = backlog.find((item) => item.id === input.lineItemId);
	if (!target) {
		throw new Error(`simulate_change: line item "${input.lineItemId}" is not in the current backlog (not needs_review, or its order isn't confirmed)`);
	}
	const hypotheticalDueDate = new Date(input.hypotheticalDueDate);
	const modifiedBacklog = backlog.map((item) => (item.id === input.lineItemId ? { ...item, dueDate: hypotheticalDueDate } : item));
	return proposeSchedule(modifiedBacklog, capacity, externalDependencies);
}
