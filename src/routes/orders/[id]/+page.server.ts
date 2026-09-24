import { error, fail } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { hasGrantedScope, requireScopePage } from '$lib/server/auth/guards';
import { estimateForDisplay, summarizeOrderEstimate } from '$lib/server/engine/estimateForDisplay';
import { cancelOrder, CancelOrderError } from '$lib/server/hoops/cancelOrder';
import { confirmImport } from '$lib/server/hoops/confirmImport';
import { fillNeedsAttentionFromNotes, FillFromNotesError } from '$lib/server/hoops/fillNeedsAttentionFromNotes';
import { computeOrderGaps } from '$lib/server/hoops/orderGaps';
import { updateLineItemFields, updateOrderFields } from '$lib/server/hoops/updateOrderFields';
import { getScheduleForOrder } from '$lib/server/schedule/getScheduleForOrder';
import type { Actions, PageServerLoad } from './$types';

/**
 * The order review screen — CLAUDE.md's first human approval gate ("Import
 * confirmation"). Confirm is only offered while the order is needs_review; editing
 * fields works regardless of status, per the Orders page spec.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	requireScopePage(locals.user, 'ORDERS_READ', url.pathname);

	const order = await prisma.order.findUnique({
		where: { id: params.id },
		include: { lineItems: { orderBy: { design: 'asc' } } }
	});
	if (!order) throw error(404, 'Order not found');

	// NEW (2026-09-21): fetch every ScheduleAssignment row for this order's line items
	// (see getScheduleForOrder.ts), so the page below can show a "Schedule" section —
	// "here's when/where each job in this order is scheduled to run" — even before a
	// human has approved the schedule (unlike the main Schedule page, which only shows
	// approved jobs).
	const scheduleAssignments = await getScheduleForOrder(params.id);

	// The confidence flags Claude raised while reading this order's Hoops export —
	// written into the audit log's diff at import time (importHoopsExport.ts), not a
	// separate column. Per-order display replaces the old batch-wide "flagged for
	// review" list shown right after upload: reading it back per-order here, from
	// whichever import action (created or a later re-import) is most recent, means it
	// naturally reflects the last time this specific order was imported.
	const lastImportLog = await prisma.domainAuditLog.findFirst({
		where: { entity: 'Order', entityId: params.id, action: { in: ['hoops_import_created', 'hoops_import_reopened'] } },
		orderBy: { at: 'desc' }
	});
	const importFlags = ((lastImportLog?.diff as { confidenceFlags?: string[] } | null)?.confidenceFlags ?? []) as string[];

	// NEW: split into `questions` (map to a real, settable field — order approval gates,
	// artwork approval, missing estimate data) and `infoNotes` (everything else — import
	// flags, and estimate gaps with no backing field yet). Only `questions` are answerable
	// via the notes box below; `infoNotes` are shown for awareness only. See orderGaps.ts.
	const gaps = computeOrderGaps({ blankOrderingStatus: order.blankOrderingStatus, customerApprovalStatus: order.customerApprovalStatus, importFlags }, order.lineItems);

	return {
		canEdit: hasGrantedScope(locals.user, 'IMPORT_WRITE'),
		order: {
			id: order.id,
			hoopsOrderId: order.hoopsOrderId,
			customerName: order.customerName,
			externalShipDate: order.externalShipDate.toISOString().slice(0, 10),
			internalDueDate: order.internalDueDate.toISOString().slice(0, 10),
			status: order.status,
			importedBy: order.importedBy,
			notes: order.notes,
			// NEW: pre-production approval gates — see buildBacklogAndCapacity.ts's
			// fetchBacklog(). Until these are set, a CONFIRMED order still can't be
			// scheduled; exposed here so there's actually a way to set them.
			blankOrderingStatus: order.blankOrderingStatus,
			customerApprovalStatus: order.customerApprovalStatus,
			importFlags
		},
		gaps,
		// NEW (2026-09-21): shape each raw database row into exactly the fields the
		// Svelte template needs, in plain, display-ready formats (e.g. the date gets
		// turned from a full timestamp into a simple "YYYY-MM-DD" string).
		schedule: scheduleAssignments.map((assignment) => ({
			id: assignment.id,
			date: assignment.date.toISOString().slice(0, 10),
			status: assignment.status,
			estimatedHours: assignment.estimatedHours,
			stationName: assignment.station.name,
			lineItemDesign: assignment.lineItem.design,
			// A line item is either a "decoration" (has a decorationType) or a
			// "finishing" step (has a finishingStep) — never both. This just picks
			// whichever one is actually set, falling back to the generic itemType if
			// somehow neither is (shouldn't happen, but keeps this safe either way).
			lineItemLabel: assignment.lineItem.decorationType ?? assignment.lineItem.finishingStep ?? assignment.lineItem.itemType
		})),
		// NEW (2026-09-21): one live estimate per line item, plus a rolled-up order
		// total — see estimateForDisplay.ts. Computed fresh on every page load (not
		// stored), so it's always in sync with whatever's currently on each line item.
		estimateSummary: summarizeOrderEstimate(order.lineItems),
		lineItems: order.lineItems.map((item) => ({
			id: item.id,
			itemType: item.itemType,
			design: item.design,
			printLocation: item.printLocation,
			decorationType: item.decorationType,
			finishingStep: item.finishingStep,
			dependsOn: item.dependsOn,
			status: item.status,
			weightClass: item.weightClass,
			// NEW (2026-09-21): pass these through so the edit form below can show and
			// change them. They'll be null for line items nobody has set them on yet.
			garmentStyle: item.garmentStyle,
			capConstruction: item.capConstruction,
			// NEW (2026-09-23): finishing-only formula inputs (matte / fold & bag).
			matteSurface: item.matteSurface,
			foldBagGarment: item.foldBagGarment,
			manualEstimatedHours: item.manualEstimatedHours,
			// NEW: the artwork-approval gate — decoration rows only, null on finishing
			// rows. Same fetchBacklog() reasoning as Order.blankOrderingStatus above.
			artworkApprovalStatus: item.artworkApprovalStatus,
			apparelColor: item.apparelColor,
			inkColorCount: item.inkColorCount,
			screens: item.screens,
			stitchCount: item.stitchCount,
			quantity: item.quantity,
			sizeBreakdown: item.sizeBreakdown as Record<string, number>,
			reviewConfidence: item.reviewConfidence,
			estimate: estimateForDisplay(item)
		}))
	};
};

export const actions: Actions = {
	confirm: async ({ params, locals, url }) => {
		const user = requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		try {
			await confirmImport([params.id], user.email);
		} catch (err) {
			return fail(400, { message: (err as Error).message });
		}
	},
	// NEW: the "answer these to fill in what's needed" notes box below the Needs
	// attention checklist. Applies through the same updateOrderFields/updateLineItemFields
	// this page's per-field forms already use — see fillNeedsAttentionFromNotes.ts for why
	// that keeps this a faster way to fill in those forms, not a second write path or a
	// bypass of Confirm import.
	fillFromNotes: async ({ params, request, locals, url }) => {
		const user = requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		const data = await request.formData();
		const note = data.get('note');
		if (typeof note !== 'string') return fail(400, { message: 'note is required' });
		try {
			const result = await fillNeedsAttentionFromNotes(params.id, note, user.email);
			return { filled: result };
		} catch (err) {
			const message = err instanceof FillFromNotesError ? err.message : 'Could not answer questions from that note.';
			return fail(400, { message });
		}
	},
	updateOrder: async ({ params, request, locals, url }) => {
		const user = requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		const data = await request.formData();
		const patch: Record<string, string> = {};
		for (const key of ['customerName', 'externalShipDate', 'internalDueDate', 'blankOrderingStatus', 'customerApprovalStatus']) {
			const value = data.get(key);
			if (typeof value === 'string' && value.trim()) patch[key] = value.trim();
		}
		// notes may be intentionally cleared, unlike the other fields above.
		const notes = data.get('notes');
		if (typeof notes === 'string') patch.notes = notes.trim();
		try {
			await updateOrderFields(params.id, patch, user.email);
		} catch (err) {
			return fail(400, { message: (err as Error).message });
		}
	},
	updateLineItem: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		const data = await request.formData();
		const lineItemId = data.get('lineItemId');
		if (typeof lineItemId !== 'string' || !lineItemId) return fail(400, { message: 'lineItemId is required' });

		const patch: Record<string, unknown> = {};
		// garmentStyle and capConstruction added NEW (2026-09-21) — this loop only picks
		// up a field if the form actually sent a non-empty value for it, so leaving a
		// dropdown on its blank "—" option just means "don't change this field," not
		// "set it to empty."
		for (const key of ['design', 'apparelColor', 'weightClass', 'garmentStyle', 'capConstruction', 'matteSurface', 'foldBagGarment', 'artworkApprovalStatus']) {
			const value = data.get(key);
			if (typeof value === 'string' && value.trim()) patch[key] = value.trim();
		}
		for (const key of ['quantity', 'inkColorCount', 'screens', 'stitchCount', 'manualEstimatedHours']) {
			const value = data.get(key);
			if (typeof value === 'string' && value.trim()) patch[key] = Number(value);
		}

		try {
			await updateLineItemFields(lineItemId, patch, user.email);
		} catch (err) {
			return fail(400, { message: (err as Error).message });
		}
	},
	// NEW (2026-09-21): this is what runs when someone clicks the "Cancel order"
	// button in the browser. `cancel` here is the action's name, which has to match
	// the `action="?/cancel"` attribute on the <form> in +page.svelte for SvelteKit to
	// know to call this function when that form is submitted.
	cancel: async ({ params, locals, url }) => {
		const user = requireScopePage(locals.user, 'IMPORT_WRITE', url.pathname);
		try {
			// All the actual logic (and the safety checks, like "you can't cancel an
			// already-completed order") lives in cancelOrder.ts, not here — this action
			// is just the thin "web page" layer that calls it and reports success/failure
			// back to the browser.
			await cancelOrder(params.id, user.email);
		} catch (err) {
			// If cancelOrder.ts threw one of its own expected errors (CancelOrderError),
			// show its specific message (e.g. "Order is already cancelled"). Otherwise,
			// something unexpected went wrong, so show a generic message instead of
			// leaking internal error details to the browser.
			const message = err instanceof CancelOrderError ? err.message : 'Could not cancel this order.';
			return fail(400, { message });
		}
	}
};
