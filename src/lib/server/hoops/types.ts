import { z } from 'zod';
import { ALL_SIBLINGS_DEPENDENCY } from '$lib/server/engine/types';
import { ArtworkApprovalStatus, BlankOrderingStatus, CustomerApprovalStatus } from '../../../../prisma/generated/prisma/enums';

/**
 * Candidate data for one line item, as already extracted from a Hoops export — by
 * whatever does that extraction (today: Claude reading the file in conversation; see
 * CLAUDE.md's "Import confirmation" gate). This module only persists already-structured
 * candidates; it does not parse a file itself — there is no documented Hoops export
 * format anywhere in this repo to parse against (see CLAUDE.md's Known open items:
 * "PDF/export import accuracy has not been validated against a real Hoops export sample").
 *
 * `localId` exists only to let a finishing row's `dependsOn` reference a sibling
 * decoration row *within this same call*, before either has a real database id.
 * It never reaches storage.
 */
export const lineItemCandidateBaseSchema = z.object({
	localId: z.string().min(1),
	itemType: z.enum(['DECORATION', 'FINISHING']),
	design: z.string().min(1),
	printLocation: z.enum(['FRONT', 'BACK', 'LEFT', 'RIGHT']).nullish(),
	decorationType: z.enum(['SCREEN_PRINT', 'EMBROIDERY', 'DTF', 'DTG']).nullish(),
	finishingStep: z.enum(['MATTE', 'RELABEL', 'FOLD_BAG', 'HANG_TAG']).nullish(),
	// NEW (2026-09-21): flat garment vs headwear — decoration-only, meaningful today for
	// embroidery's estimate_hours formula. See prisma/schema.prisma's
	// LineItem.garmentStyle comment. `.nullish()` means this field is optional and can
	// be null/undefined — most existing line items won't have it set yet.
	garmentStyle: z.enum(['FLAT', 'CAP']).nullish(),
	// NEW (2026-09-21): only meaningful when garmentStyle above is 'CAP'.
	capConstruction: z.enum(['STRUCTURED', 'UNSTRUCTURED']).nullish(),
	// Another line item's `localId` in this same order candidate, or the literal
	// "all_siblings" sentinel — never a real LineItem.id (none exist yet at import time).
	dependsOn: z.string().nullish(),
	weightClass: z.enum(['THIN', 'POLY', 'BULKY']),
	apparelColor: z.string().min(1),
	inkColorCount: z.number().int().nonnegative().nullish(),
	screens: z.number().int().nonnegative().nullish(),
	stitchCount: z.number().int().nonnegative().nullish(),
	quantity: z.number().int().positive(),
	sizeBreakdown: z.record(z.string(), z.number().int().nonnegative()),
	reviewConfidence: z.number().min(0).max(1).nullish()
});

export const lineItemCandidateSchema = lineItemCandidateBaseSchema
	.refine((item) => (item.itemType === 'DECORATION' ? item.decorationType != null : item.finishingStep != null), {
		message: 'decorationType is required for DECORATION rows, finishingStep is required for FINISHING rows'
	})
	.refine((item) => item.itemType !== 'DECORATION' || item.finishingStep == null, {
		message: 'finishingStep must be null on DECORATION rows'
	})
	.refine((item) => item.itemType !== 'FINISHING' || item.decorationType == null, {
		message: 'decorationType must be null on FINISHING rows'
	})
	.refine((item) => item.itemType !== 'DECORATION' || item.dependsOn == null, {
		message: 'dependsOn is finishing-rows-only — see CLAUDE.md'
	})
	.refine((item) => item.itemType !== 'FINISHING' || (item.dependsOn != null && item.dependsOn.length > 0), {
		message: 'FINISHING rows must set dependsOn (another localId, or "all_siblings") or they can never be unlocked'
	});

export type LineItemCandidate = z.infer<typeof lineItemCandidateSchema>;

export const orderCandidateSchema = z.object({
	hoopsOrderId: z.string().min(1),
	customerName: z.string().min(1),
	externalShipDate: z.iso.date(),
	internalDueDate: z.iso.date(),
	importedBy: z.string().min(1),
	lineItems: z.array(lineItemCandidateSchema).min(1),
	// Free-text notes on anything Claude was unsure about reading this order — not a
	// schema column, just carried through to the tool's returned confidence_flags[]
	// (and into the audit log) for the human confirming the import to see.
	confidenceFlags: z.array(z.string()).optional()
});

export type OrderCandidate = z.infer<typeof orderCandidateSchema>;

export const ALL_SIBLINGS = ALL_SIBLINGS_DEPENDENCY;

// confirm_import's `corrections?` — field-level edits a human made while reviewing an
// already-created (needs_review) order/line item, applied just before it's confirmed.
// Partial and unrefined on purpose: a correction only touching `quantity` shouldn't have
// to resupply every itemType-consistency invariant lineItemCandidateSchema enforces at
// creation time.
export const orderCorrectionSchema = z
	.object({
		customerName: z.string().min(1),
		externalShipDate: z.iso.date(),
		internalDueDate: z.iso.date(),
		// Free-text, human-entered only — e.g. why a job ran late. See CLAUDE.md.
		notes: z.string(),
		// NEW: the pre-production approval gates buildBacklogAndCapacity.ts's
		// fetchBacklog() requires (adopted from the schedule-creation-workflow branch).
		// Not part of the Hoops import candidate — these aren't read off the export,
		// they're set afterward as the shop actually orders blanks / gets customer
		// sign-off. Without a way to set them, no order could ever reach the schedule
		// backlog through the UI.
		blankOrderingStatus: z.enum(BlankOrderingStatus),
		customerApprovalStatus: z.enum(CustomerApprovalStatus)
	})
	.partial();

// This line builds a "correction" schema by starting from the base schema above and
// removing two fields that don't make sense to edit after the fact (localId,
// dependsOn), then making everything else optional (.partial()) so a correction can
// touch just one field without having to resupply every other one. Because it's
// DERIVED from lineItemCandidateBaseSchema rather than a separate hand-written list of
// fields, the new garmentStyle/capConstruction fields added above automatically became
// editable here too — nothing extra had to be added in this specific line.
export const lineItemCorrectionSchema = lineItemCandidateBaseSchema
	.omit({ localId: true, dependsOn: true })
	.extend({
		// NEW: same reasoning as Order.blankOrderingStatus/customerApprovalStatus above —
		// the artwork-approval gate, but per decoration line item rather than per order.
		// Null on finishing rows (checked by the caller, not enforced here — same pattern
		// updateLineItemFields already uses for every other field).
		artworkApprovalStatus: z.enum(ArtworkApprovalStatus)
	})
	.partial();

export type OrderCorrection = z.infer<typeof orderCorrectionSchema>;
export type LineItemCorrection = z.infer<typeof lineItemCorrectionSchema>;

export const importCorrectionsSchema = z.object({
	/** Keyed by real Order.id. */
	orders: z.record(z.string(), orderCorrectionSchema).optional(),
	/** Keyed by real LineItem.id. dependsOn is deliberately not correctable here — it's
	 *  cross-row wiring set at import time, not a simple field edit. */
	lineItems: z.record(z.string(), lineItemCorrectionSchema).optional()
});

export type ImportCorrections = z.infer<typeof importCorrectionsSchema>;
