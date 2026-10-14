/**
 * Patch Install rule (2026-10-14, client decision): patch installs are almost always
 * outsourced, but when done in-house One Off assumes 3 minutes per unit. The import
 * review surfaces that question for every patch install line item (orderGaps.ts asks
 * it); the answer sets LineItem.outsourced. In-house items get their hours
 * auto-computed by estimateOtherHours (3 min × quantity); outsourced items are filtered
 * from the scheduling backlog and flipped to COMPLETE on confirm so the order can
 * complete naturally.
 *
 * Detection is a case-insensitive match on `otherJobType` because the import stores the
 * Hoops export's own text there (see types.ts' lineItemCandidateBaseSchema); the client's
 * exports today write "Patch Install".
 */

/** Minutes the shop assumes per in-house patch install, per unit. */
export const PATCH_INSTALL_MINUTES_PER_UNIT = 3;

/** True when a LineItem is a Patch Install (an OTHER row whose otherJobType reads
 *  "patch install" after trim+lowercase). The shared single source of truth so the
 *  engine, orderGaps, order page and MCP tools can't drift on the match rule. */
export function isPatchInstall(item: { itemType?: string | null; otherJobType?: string | null }): boolean {
	if (item.itemType !== 'OTHER') return false;
	const raw = item.otherJobType;
	if (!raw) return false;
	return raw.trim().toLowerCase() === 'patch install';
}

/** Hours for an in-house patch install at the fixed 3 min/unit rate. */
export function patchInstallInHouseHours(quantity: number): number {
	return (quantity * PATCH_INSTALL_MINUTES_PER_UNIT) / 60;
}
