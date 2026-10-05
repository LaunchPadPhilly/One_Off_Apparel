import { FinishingStep } from '../../../../prisma/generated/prisma/enums';

/**
 * Which finishing steps have to wait, and on what (client decision, 2026-09-28).
 * Replaces the old "every finishing row waits on something":
 *
 * - MATTE waits on the specific decoration it finishes (it's done after the print), or
 *   on "all_decorations" when the import can't tell which one (see types.ts).
 * - FOLD_BAG waits on every other line item on the order ("all_siblings") — it's the
 *   last thing that happens to the job.
 * - RELABEL, HANG_TAG and WOVENS wait on nothing. They can be done any time, even
 *   before the print (relabel sometimes is).
 *
 * This is decided here in code, not left to the PDF extraction model: whatever
 * `dependsOn` the model proposes is overridden for FOLD_BAG and the no-wait steps.
 * Applied by importHoopsExport.ts (when rows are created) and fetchBacklog() (when
 * rows are read for scheduling).
 */

/** What a finishing step waits on: nothing, a decoration, or every other line item. */
export type FinishingDependencyRule = 'none' | 'decoration' | 'all_siblings';

/**
 * The dependency rule for one finishing step. Accepts a raw string or null too (e.g.
 * straight from extraction output); anything that isn't MATTE or FOLD_BAG — including
 * an unknown value or a decoration row's null — is 'none'.
 */
export function finishingDependencyRule(step: FinishingStep | string | null | undefined): FinishingDependencyRule {
	switch (step) {
		case FinishingStep.MATTE:
			return 'decoration';
		case FinishingStep.FOLD_BAG:
			return 'all_siblings';
		default:
			return 'none';
	}
}
