<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let uploading = $state(false);

	// NEW (2026-09-21): formats an order's live estimate summary (see
	// estimateForDisplay.ts) into one short string for the "Est. hours" column.
	function formatEstimate(estimate: { totalHours: number; estimableCount: number; unestimableCount: number }): string {
		if (estimate.estimableCount === 0) return '';
		return `~${estimate.totalHours.toFixed(1)}h`;
	}

	// NEW (2026-09-21): a few at-a-glance numbers across every active order, for the
	// stat row at the top of the page. Derived from data already on the page — no
	// extra server round-trip needed.
	const needsReviewCount = $derived(data.orders.filter((order) => order.status === 'NEEDS_REVIEW').length);
	const totalEstimatedHours = $derived(data.orders.reduce((sum, order) => sum + order.estimate.totalHours, 0));
	const fullyEstimableCount = $derived(data.orders.filter((order) => order.estimate.unestimableCount === 0 && order.lineItemCount > 0).length);
</script>

<svelte:head>
	<title>Orders — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<span class="eyebrow">Orders</span>
	<h1>Orders</h1>
	<p class="muted">
		Provisional — see CLAUDE.md's Known open items. Active orders (anything not yet complete). Completed
		orders live at <a href="/orders/archive">Archive</a>.
	</p>

	<!-- NEW (2026-09-21): a stat row, same pattern used on /admin — gives an
	     at-a-glance read on the active order book before scrolling into the table. -->
	{#if data.orders.length > 0}
		<div class="grid">
			<StatCard value={data.orders.length} label="active orders" />
			<StatCard value={needsReviewCount} label="waiting on review" tone={needsReviewCount > 0 ? 'warn' : 'default'} />
			<StatCard value={totalEstimatedHours} format={(n) => `~${n.toFixed(1)}h`} label="estimated hours (known so far)" />
			<StatCard value={fullyEstimableCount} label="orders fully estimated" />
		</div>
	{/if}

	{#if data.canImport}
		<section class="card">
			<div class="card__title"><h2>Import a Hoops export</h2></div>
			<p class="muted">
				One or more PDF job exports. Extraction reads each PDF with Claude and flags anything it's
				unsure of — nothing becomes schedulable until you review and confirm it below.
			</p>
			<form
				method="POST"
				action="?/upload"
				enctype="multipart/form-data"
				use:enhance={() => {
					uploading = true;
					return async ({ update }) => {
						await update();
						uploading = false;
					};
				}}
			>
				<input type="file" name="files" accept="application/pdf" multiple required />
				<button class="button" use:pressable type="submit" disabled={uploading}>
					{uploading ? 'Reading PDFs…' : 'Import'}
				</button>
			</form>

			{#if form?.message}
				<p class="error">{form.message}</p>
			{/if}
			{#if form?.imported}
				<p class="success">Imported {form.imported} order{form.imported === 1 ? '' : 's'} — needs review below.</p>
			{/if}
			{#if form?.confidenceFlags?.length}
				<div class="flags">
					<strong>Flagged for review:</strong>
					<ul>
						{#each form.confidenceFlags as flag (flag)}
							<li>{flag}</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if form?.extractionErrors?.length}
				<div class="flags flags--error">
					<strong>Could not extract:</strong>
					<ul>
						{#each form.extractionErrors as err (err)}
							<li>{err}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}

	<section class="card">
		{#if data.orders.length === 0}
			<p class="muted">No active orders.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Job</th>
						<th>Customer</th>
						<th>Due</th>
						<th>Status</th>
						<th>Line items</th>
						<!-- NEW (2026-09-21): a live "how long will this take" figure, computed
						     from whatever line items currently have enough data to estimate —
						     see estimateForDisplay.ts / summarizeOrderEstimate(). -->
						<th>Est. hours</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each data.orders as order (order.id)}
						<tr>
							<td class="job-cell">{order.hoopsOrderId}</td>
							<td>{order.customerName}</td>
							<td>{order.internalDueDate}</td>
							<td><span class="badge" class:badge--warn={order.status === 'NEEDS_REVIEW'}>{order.status}</span></td>
							<td>{order.lineItemCount}</td>
							<td>
								{#if order.estimate.estimableCount > 0}
									<span class="estimate">{formatEstimate(order.estimate)}</span>
									{#if order.estimate.unestimableCount > 0}
										<span
											class="badge badge--off estimate-pending"
											title="{order.estimate.unestimableCount} line item{order.estimate.unestimableCount === 1
												? ''
												: 's'} can't be estimated yet — open the order to see why."
										>
											+{order.estimate.unestimableCount} pending
										</span>
									{/if}
								{:else}
									<span
										class="badge badge--off"
										title="None of this order's line items can be estimated yet — open the order to see why."
									>
										Not yet estimable
									</span>
								{/if}
							</td>
							<td><a class="button button--secondary" href="/orders/{order.id}">{order.status === 'NEEDS_REVIEW' ? 'Review' : 'View'}</a></td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>

<style>
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

	.error {
		color: var(--danger-fg);
	}

	.success {
		color: var(--ink-900);
		font-weight: 550;
	}

	.flags {
		margin-top: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.flags--error {
		border-color: var(--danger-fg);
	}

	.flags ul {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
	}

	form {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.job-cell {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	.estimate {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.estimate-pending {
		margin-left: 0.4rem;
	}

	.grid {
		margin-bottom: 1.25rem;
	}
</style>
