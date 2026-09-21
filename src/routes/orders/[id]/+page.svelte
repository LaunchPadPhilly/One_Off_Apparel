<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
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
		{#if data.order.importFlags.length > 0}
			<p class="import-flags">
				<strong>Flagged at import:</strong> {data.order.importFlags.join(' · ')}
			</p>
		{/if}
		{#if data.canEdit}
			<form method="POST" action="?/updateOrder" use:enhance class="fields">
				<label>Customer <input name="customerName" value={data.order.customerName} /></label>
				<label>External ship date <input name="externalShipDate" type="date" value={data.order.externalShipDate} /></label>
				<label>Internal due date <input name="internalDueDate" type="date" value={data.order.internalDueDate} /></label>
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
				<label class="notes-field">
					Notes (e.g. why a job ran late — Nate/Toby's call, nothing infers this)
					<textarea name="notes" rows="3">{data.order.notes ?? ''}</textarea>
				</label>
				<button class="button button--secondary" use:pressable type="submit">Save</button>
			</form>
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
					<form method="POST" action="?/updateLineItem" use:enhance class="fields">
						<input type="hidden" name="lineItemId" value={item.id} />
						<label>Design <input name="design" value={item.design} /></label>
						<label>Color <input name="apparelColor" value={item.apparelColor} /></label>
						<label>Qty <input name="quantity" type="number" value={item.quantity} /></label>
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

	.notes-field {
		flex-basis: 100%;
	}

	.notes-field textarea {
		width: 100%;
		font-family: inherit;
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

	.import-flags {
		margin: 0.4rem 0 0.75rem;
		font-size: 0.9rem;
		color: var(--ink-500);
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
