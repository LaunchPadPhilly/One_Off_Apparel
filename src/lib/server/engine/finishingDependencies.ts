import { FinishingStep } from '../../../../prisma/generated/prisma/enums';

/**
 * Which finishing steps have to wait, and on what (client decision, 2026-09-28).
 * Replaces the old "every finishing row waits on something":
 *
 * - MATTE waits on the specific decoration it finishes (it's done after the print).
 * - FOLD_BAG waits on every other line item on the order ("all_siblings") — it's the
 *   last thing that happens to the job.
 * - RELABEL, HANG_TAG and WOVENS wait on nothing. They can be done any time, even
 *   before the print (relabel sometimes is).
 *
 * This is decided here in code, not left to the PDF extraction model: whatever
 * `dependsOn` the model proposes is overridden for FOLD_BAG and the no-wait steps.
 */
export type FinishingDependencyRule = 'none' | 'decoration' | 'all_siblings';

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
