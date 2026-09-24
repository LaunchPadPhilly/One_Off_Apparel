import {
	DecorationType,
	FinishingStep,
	LineItemType
} from '../../../prisma/generated/prisma/enums';

/**
 * The station a line item is allowed to be placed on. Same value the engine's
 * estimate_hours picks per branch (see estimateHours.ts's `station:` returns), but
 * computed straight from the line item's type — no formula, no runtime data required.
 * Both client and server import this so the draft board's drop-restriction rule
 * ("embroidery can't go on a print or finishing row, and so on") is enforced from
 * exactly one table.
 *
 * Returns null for a row whose type isn't recognized (e.g. an as-yet-uncategorized
 * "Patch Install" line — see CLAUDE.md Known open items). Callers treat null as
 * "no restriction," because there's no correct row to enforce yet.
 */
export function expectedStationFor(item: {
	itemType: LineItemType | string;
	decorationType?: DecorationType | string | null;
	finishingStep?: FinishingStep | string | null;
}): string | null {
	if (item.itemType === LineItemType.DECORATION) {
		switch (item.decorationType) {
			case DecorationType.SCREEN_PRINT:
				return 'screen_print_auto';
			case DecorationType.EMBROIDERY:
				return 'embroidery';
			case DecorationType.DTF:
				return 'dtf';
			case DecorationType.DTG:
				return 'dtg';
			default:
				return null;
		}
	}
	if (item.itemType === LineItemType.FINISHING) {
		switch (item.finishingStep) {
			case FinishingStep.RELABEL:
				return 'printed_relabel';
			case FinishingStep.HANG_TAG:
				return 'hang_tags';
			case FinishingStep.FOLD_BAG:
				return 'fold_bag';
			case FinishingStep.MATTE:
				return 'matte_finish';
			case FinishingStep.WOVENS:
				return 'wovens';
			default:
				return null;
		}
	}
	return null;
}

/** A human-readable label for the mismatch refusal message on the board. */
export function stationDisplayLabel(name: string): string {
	return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
