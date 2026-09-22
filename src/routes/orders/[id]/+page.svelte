<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import { computeInternalDueDate } from '$lib/internalDueDate';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Internal due date defaults to 14 days before external ship date (see
	// internalDueDate.ts) but stays a real, independently editable field — a human
	// reviewing the order can set it to whatever they want. This only re-suggests the
	// default when the ship date changes AND the due date still matches the default for
	// the *previous* ship date — so editing the ship date after someone has already
	// deliberately overridden the due date doesn't clobber their override.
	let externalShipDate = $state(data.order.externalShipDate);
	let internalDueDate = $state(data.order.internalDueDate);

	function onExternalShipDateChange(newValue: string) {
		const wasDefault = internalDueDate === computeInternalDueDate(externalShipDate);
		externalShipDate = newValue;
		if (wasDefault) internalDueDate = computeInternalDueDate(newValue);
	}

	// data.gaps (see orderGaps.ts, computed server-side and shared with the notes-box
	// fill-in action so both read the exact same outstanding-gap logic) splits into two
	// very differently-treated things:
	//
	// - `answerableQuestions`: map to a real, settable field — the whole point of the
	//   notes box below. Grouped for display (many line items can share the exact same
	//   outstanding field, e.g. two dozen embroidery rows all missing ink_color_count,
	//   and one bullet per line item defeated the point of a short list) — the full,
	//   ungrouped per-line-item question list still goes to Claude when the notes box is
	//   submitted (recomputed fresh server-side from the database), so grouping here only
	//   affects what's shown, never what an answer can target.
	// - `data.gaps.infoNotes` (rendered directly, further down, collapsed by default): the
	//   import-time context Claude flagged and estimate gaps with no backing field at all
	//   (a station with no formula yet) — nothing to answer here, so it stays out of the
	//   way rather than crowding the actual questions.
	const FIELD_QUESTION_LABELS: Record<string, string> = {
		inkColorCount: 'What is the ink/thread color count',
		stitchCount: 'What is the stitch count',
		garmentStyle: 'Is it a flat garment or a cap',
		capConstruction: 'Is it a structured or unstructured cap'
	};

	const answerableQuestions = $derived.by(() => {
		const items: { key: string; text: string }[] = [];

		for (const q of data.gaps.questions) {
			if (q.target.level === 'order') items.push({ key: q.key, text: q.question });
		}

		const lineItemQuestions = data.gaps.questions.filter((q) => q.target.level === 'lineItem');

		const artworkQs = lineItemQuestions.filter((q) => q.target.field === 'artworkApprovalStatus');
		if (artworkQs.length > 0) {
			items.push({
				key: 'artwork-group',
				text: artworkQs.length === 1 ? artworkQs[0].question : `Has artwork been approved for these ${artworkQs.length} line items?`
			});
		}

		const byField = new Map<string, typeof lineItemQuestions>();
		for (const q of lineItemQuestions) {
			if (q.target.field === 'artworkApprovalStatus') continue;
			const list = byField.get(q.target.field) ?? [];
			list.push(q);
			byField.set(q.target.field, list);
		}
		for (const [field, qs] of byField) {
			const label = FIELD_QUESTION_LABELS[field] ?? 'What is the answer';
			items.push({
				key: `field-group:${field}`,
				text: qs.length === 1 ? qs[0].question : `${label} for each of these ${qs.length} line items? (name them in your note if the answers differ)`
			});
		}

		return items;
	});
</script>

<svelte:head>
	<title>{data.order.hoopsOrderId} — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<a class="muted" href="/orders">&larr; Orders</a>
	<span class="eyebrow">{data.order.status === 'NEEDS_REVIEW' ? 'Review before confirming' : 'Order'}</span>
	<h1>{data.order.hoopsOrderId} — {data.order.customerName}</h1>

	{#if form?.message}
		<p class="error">{form.message}</p>
	{/if}

	<!-- NEW (2026-09-21): the order-level estimate at a glance — same live-computed
	     summary shown on the Orders list, expanded here into its own stat row. -->
	{#if data.lineItems.length > 0}
		<div class="grid">
			<StatCard value={data.estimateSummary.totalHours} format={(n) => `~${n.toFixed(1)}h`} label="estimated so far" />
			<StatCard
				value={data.estimateSummary.estimableCount}
				label="line items estimated"
				tone={data.estimateSummary.unestimableCount > 0 ? 'warn' : 'default'}
			/>
			{#if data.estimateSummary.unestimableCount > 0}
				<StatCard value={data.estimateSummary.unestimableCount} label="not yet estimable" tone="warn" />
			{/if}
		</div>
	{/if}

	<section class="card">
		<div class="card__title">
			<h2>Order</h2>
			<span
				class="badge"
				class:badge--warn={data.order.status === 'NEEDS_REVIEW'}
				class:badge--danger={data.order.status === 'CANCELLED'}
			>
				{data.order.status}
			</span>
		</div>
		<!-- The straight-to-the-point "what does this order still need" list — the
		     thing to actually look at before an order can move forward. Only shows
		     while something's outstanding; disappears on its own once everything's
		     resolved rather than needing to be dismissed. Split into the questions the
		     notes box can actually answer (prominent, right above it) and everything
		     else Claude flagged at import time (collapsed by default — context, not
		     something to act on). -->
		{#if answerableQuestions.length > 0}
			<div class="needs-attention">
				<strong>Needs attention:</strong>
				<ul>
					{#each answerableQuestions as { key, text } (key)}
						<li>{text}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<!-- NEW: answer the questions above in one note instead of filling in each field
		     by hand. Claude reads the note against the exact outstanding question list
		     (recomputed fresh from the database, not from anything sent by the browser)
		     and only fills in fields the note actually answers — see
		     fillNeedsAttentionFromNotes.ts. This never touches Confirm import (still a
		     separate, explicit click below) and never removes the per-field "Save"
		     forms further down — anything this gets wrong, or anything you'd rather
		     type directly, stays editable by hand exactly as before. -->
		{#if data.canEdit && answerableQuestions.length > 0}
			<form method="POST" action="?/fillFromNotes" use:enhance class="fill-from-notes">
				<label>
					Answer the questions above
					<textarea name="note" rows="3" placeholder="e.g. Blanks are in, customer approved it, and all four screen prints use 2 colors."
					></textarea>
				</label>
				<button class="button button--secondary" use:pressable type="submit">Fill in from note</button>
				{#if form?.filled}
					<p class="success">
						Answered {form.filled.answeredCount} question{form.filled.answeredCount === 1 ? '' : 's'}
						{#if form.filled.unansweredCount > 0}— {form.filled.unansweredCount} left unanswered.{/if}
					</p>
				{/if}
			</form>
		{/if}
		<!-- Import-time context — nothing here maps to a settable field, so it's not
		     part of the questions above and can't be answered via the notes box.
		     Collapsed by default so it reads as background, not a checklist. -->
		{#if data.gaps.infoNotes.length > 0}
			<details class="import-notes">
				<summary>Import notes ({data.gaps.infoNotes.length})</summary>
				<ul>
					{#each data.gaps.infoNotes as { key, text } (key)}
						<li>{text}</li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if data.canEdit}
			<form
				method="POST"
				action="?/updateOrder"
				use:enhance={() => async ({ update }) => update({ reset: false })}
				class="fields"
			>
				<label>Customer <input name="customerName" value={data.order.customerName} autocomplete="off" /></label>
				<label>
					External ship date
					<input
						name="externalShipDate"
						type="date"
						value={externalShipDate}
						onchange={(e) => onExternalShipDateChange(e.currentTarget.value)}
					/>
				</label>
				<!-- Defaults to 14 days before external ship date (see internalDueDate.ts /
				     onExternalShipDateChange above) but stays a real, editable field — a
				     person reviewing the order can set it to whatever they want. -->
				<label>
					Internal due date
					<input name="internalDueDate" type="date" bind:value={internalDueDate} title="Defaults to 14 days before external ship date; edit freely to override." />
				</label>
				<label>
					Blanks ordering
					<select name="blankOrderingStatus">
						<option value="NOT_ORDERED" selected={data.order.blankOrderingStatus === 'NOT_ORDERED'}>Not ordered</option>
						<option value="ORDERED" selected={data.order.blankOrderingStatus === 'ORDERED'}>Ordered</option>
						<option value="ISSUE" selected={data.order.blankOrderingStatus === 'ISSUE'}>Issue</option>
						<option value="RECEIVED" selected={data.order.blankOrderingStatus === 'RECEIVED'}>Received</option>
					</select>
				</label>
				<label>
					Customer approval
					<select name="customerApprovalStatus">
						<option value="NOT_SENT" selected={data.order.customerApprovalStatus === 'NOT_SENT'}>Not sent</option>
						<option value="PENDING_APPROVAL" selected={data.order.customerApprovalStatus === 'PENDING_APPROVAL'}>Pending</option>
						<option value="CHANGES_REQUESTED" selected={data.order.customerApprovalStatus === 'CHANGES_REQUESTED'}>Changes requested</option>
						<option value="APPROVED" selected={data.order.customerApprovalStatus === 'APPROVED'}>Approved</option>
					</select>
				</label>
				<button class="button button--secondary" use:pressable type="submit">Save</button>
			</form>
			<!-- Kept, but separate from the review flow above — this is a person's own
			     observation (e.g. why a job ran late), not something the review checklist
			     surfaces. See add_order_note (MCP) and the Reports page, which both read
			     this same field. -->
			<details class="production-notes">
				<summary>Production notes</summary>
				<form method="POST" action="?/updateOrder" use:enhance class="fields">
					<textarea name="notes" rows="3" autocomplete="off">{data.order.notes ?? ''}</textarea>
					<button class="button button--secondary" use:pressable type="submit">Save note</button>
				</form>
			</details>
		{:else}
			<dl>
				<div><dt>Ship date</dt><dd>{data.order.externalShipDate}</dd></div>
				<div><dt>Due date</dt><dd>{data.order.internalDueDate}</dd></div>
				<div><dt>Blanks</dt><dd>{data.order.blankOrderingStatus}</dd></div>
				<div><dt>Customer approval</dt><dd>{data.order.customerApprovalStatus}</dd></div>
			</dl>
			{#if data.order.notes}
				<p><strong>Notes:</strong> {data.order.notes}</p>
			{/if}
		{/if}

		{#if data.canEdit && data.order.status === 'NEEDS_REVIEW'}
			<form method="POST" action="?/confirm" use:enhance>
				<button class="button" use:pressable type="submit">Confirm import</button>
			</form>
		{/if}

		<!--
			NEW (2026-09-21): the "Cancel order" button — this is this app's version of
			"delete." It only shows up if the order isn't already COMPLETE or CANCELLED
			(no point cancelling something that's already done or already cancelled).
			`use:enhance` with a `confirm(...)` popup means the browser asks "are you
			sure?" before actually submitting the form, so a misclick can't
			accidentally cancel a real order. If the person clicks "Cancel" on that
			popup, `cancel()` stops the form submission from happening at all.
		-->
		{#if data.canEdit && data.order.status !== 'COMPLETE' && data.order.status !== 'CANCELLED'}
			<form
				method="POST"
				action="?/cancel"
				use:enhance={({ cancel }) => {
					if (!confirm('Cancel this order? Line items and any schedule stay as-is, but it drops out of the active list and the schedule backlog.')) cancel();
				}}
			>
				<button class="button button--danger" use:pressable type="submit">Cancel order</button>
			</form>
		{/if}
	</section>

	<!--
		NEW (2026-09-21): this whole section only renders when the order actually HAS
		scheduled jobs (data.schedule.length > 0) — if propose_schedule hasn't placed
		anything for this order yet, this section just doesn't show up at all instead
		of showing an empty table.
	-->
	{#if data.schedule.length > 0}
		<section class="card">
			<div class="card__title"><h2>Schedule ({data.schedule.length})</h2></div>
			<table>
				<thead>
					<tr>
						<th>Date</th>
						<th>Station</th>
						<th>Job</th>
						<th>Est. hrs</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{#each data.schedule as assignment (assignment.id)}
						<tr>
							<td>{assignment.date}</td>
							<td>{assignment.stationName}</td>
							<td>{assignment.lineItemDesign} <span class="muted">({assignment.lineItemLabel})</span></td>
							<td>{assignment.estimatedHours}</td>
							<td><span class="badge" class:badge--warn={assignment.status === 'PROPOSED'}>{assignment.status}</span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}

	<section class="card">
		<div class="card__title"><h2>Line items ({data.lineItems.length})</h2></div>
		{#each data.lineItems as item (item.id)}
			<div class="line-item">
				<div class="line-item__header">
					<strong>{item.design}</strong>
					<span class="badge">{item.itemType}</span>
					<span class="badge">{item.status}</span>
					{#if item.reviewConfidence !== null && item.reviewConfidence < 0.6}
						<span class="badge badge--warn">low confidence ({item.reviewConfidence})</span>
					{/if}
					{#if item.artworkApprovalStatus}
						<span class="badge" class:badge--success={item.artworkApprovalStatus === 'APPROVED'} class:badge--warn={item.artworkApprovalStatus !== 'APPROVED'}>
							artwork: {item.artworkApprovalStatus}
						</span>
					{/if}
					<!-- NEW (2026-09-21): this job's own live estimate — a plain success-toned
					     badge when we can compute it, or a warn-toned badge with the reason in
					     a hover tooltip when we can't yet (missing formula vs missing job data;
					     see estimateForDisplay.ts). -->
					{#if item.estimate.ok}
						<span class="badge badge--success">~{item.estimate.hours.toFixed(2)}h</span>
					{:else}
						<span class="badge badge--warn" title={item.estimate.reason}>
							{item.estimate.category === 'missing_formula' ? 'No formula yet' : 'Missing job details'}
						</span>
					{/if}
				</div>
				<p class="muted">
					{item.decorationType ?? item.finishingStep} · {item.apparelColor} · {item.weightClass} ·
					qty {item.quantity}
					{#if item.printLocation}· {item.printLocation}{/if}
					{#if item.inkColorCount}· {item.inkColorCount} color{item.inkColorCount === 1 ? '' : 's'}{/if}
					{#if item.screens}· {item.screens} screen{item.screens === 1 ? '' : 's'}{/if}
					{#if item.stitchCount}· {item.stitchCount} stitches{/if}
					{#if item.garmentStyle}· {item.garmentStyle}{#if item.capConstruction} ({item.capConstruction}){/if}{/if}
				</p>
				{#if data.canEdit}
					<!--
						KEYED on the item's own editable fields: every line-item form on this
						page reuses the same input `name`s ("design", "apparelColor", "quantity")
						since each form posts independently server-side — but that also makes
						them look identical to the browser's own form-autofill/restore heuristics,
						which key off name alone, not which <form> an input belongs to. That let
						the browser silently swap in a blank (or another row's) remembered value
						after a save-triggered reload, even though the real data in the database
						was never touched. Keying the block forces Svelte to tear down and rebuild
						these exact DOM nodes whenever the item's own data changes, so there's
						nothing stale left for the browser to "restore" into.
					-->
					{#key `${item.id}:${item.design}:${item.apparelColor}:${item.quantity}`}
						<form method="POST" action="?/updateLineItem" use:enhance class="fields">
							<input type="hidden" name="lineItemId" value={item.id} />
							<label>Design <input name="design" value={item.design} autocomplete="off" /></label>
							<label>Color <input name="apparelColor" value={item.apparelColor} autocomplete="off" /></label>
							<label>Qty <input name="quantity" type="number" value={item.quantity} autocomplete="off" /></label>
						<!--
							NEW (2026-09-21): these two dropdowns let someone set
							garmentStyle/capConstruction by hand. They only show for
							DECORATION line items (finishing steps like "matte" or
							"relabel" don't have a garment style). Leaving a dropdown
							on its blank "—" option and hitting Save won't clear an
							existing value — the server only updates a field if you
							pick something other than blank (see +page.server.ts).
						-->
						{#if item.itemType === 'DECORATION'}
							<label>
								Garment style
								<select name="garmentStyle">
									<option value="" selected={!item.garmentStyle}>—</option>
									<option value="FLAT" selected={item.garmentStyle === 'FLAT'}>Flat</option>
									<option value="CAP" selected={item.garmentStyle === 'CAP'}>Cap</option>
								</select>
							</label>
							<label>
								Cap construction
								<select name="capConstruction">
									<option value="" selected={!item.capConstruction}>—</option>
									<option value="STRUCTURED" selected={item.capConstruction === 'STRUCTURED'}>Structured</option>
									<option value="UNSTRUCTURED" selected={item.capConstruction === 'UNSTRUCTURED'}>Unstructured</option>
								</select>
							</label>
							<!-- NEW: the artwork-approval gate fetchBacklog() requires before this
							     row can be scheduled. Blank "—" means "don't change," same pattern
							     as garmentStyle/capConstruction above. -->
							<label>
								Artwork approval
								<select name="artworkApprovalStatus">
									<option value="" selected={!item.artworkApprovalStatus}>—</option>
									<option value="NOT_SUBMITTED" selected={item.artworkApprovalStatus === 'NOT_SUBMITTED'}>Not submitted</option>
									<option value="PENDING_APPROVAL" selected={item.artworkApprovalStatus === 'PENDING_APPROVAL'}>Pending</option>
									<option value="REVISION_REQUESTED" selected={item.artworkApprovalStatus === 'REVISION_REQUESTED'}>Revision requested</option>
									<option value="APPROVED" selected={item.artworkApprovalStatus === 'APPROVED'}>Approved</option>
								</select>
							</label>
						{/if}
						<button class="button button--secondary" use:pressable type="submit">Save</button>
					</form>
					{/key}
				{/if}
			</div>
		{/each}
	</section>
</div>

<style>
	.fields {
		display: flex;
		gap: 0.75rem;
		align-items: end;
		flex-wrap: wrap;
		margin: 0.75rem 0;
	}

	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	dl {
		display: flex;
		gap: 1.5rem;
		margin: 0.5rem 0;
	}

	dl div {
		display: flex;
		flex-direction: column;
	}

	dt {
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	dd {
		margin: 0;
		font-weight: 600;
	}

	.line-item {
		padding: 0.75rem 0;
		border-top: 1px solid var(--border);
	}

	.line-item:first-of-type {
		border-top: none;
	}

	.line-item__header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.error {
		color: var(--danger-fg);
	}

	.needs-attention {
		margin: 0.4rem 0 0.75rem;
		padding: 0.65rem 0.85rem;
		font-size: 0.9rem;
		border: 1px solid var(--warm-300);
		background: var(--warm-100);
		border-radius: var(--radius-sm);
	}

	.needs-attention ul {
		margin: 0.3rem 0 0;
		padding-left: 1.1rem;
	}

	.fill-from-notes {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0 0 1rem;
	}

	.fill-from-notes label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	.fill-from-notes textarea {
		width: 100%;
		font-family: inherit;
	}

	.fill-from-notes button {
		align-self: start;
	}

	.import-notes {
		margin: 0 0 1rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	.import-notes summary {
		cursor: pointer;
	}

	.import-notes ul {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
	}

	.production-notes {
		margin-top: 0.75rem;
	}

	.production-notes summary {
		cursor: pointer;
		font-size: 0.9rem;
		color: var(--ink-500);
	}

	.production-notes .fields {
		margin-top: 0.5rem;
	}

	.production-notes textarea {
		width: 100%;
		font-family: inherit;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	th {
		color: var(--ink-500);
		font-size: 0.85rem;
		font-weight: 550;
	}

	tbody tr:last-child td {
		border-bottom: none;
	}

	.grid {
		margin-bottom: 1.25rem;
	}
</style>
