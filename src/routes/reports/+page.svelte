<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Reports — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<span class="eyebrow">Reports</span>
	<h1>Reports</h1>
	<p class="muted">
		Minimal, per CLAUDE.md's Known open items — only what the schema already supports (actuals vs.
		estimated_hours, on-time completion, currently-blocked line items, recent changes). No historical
		at-risk trend yet — that isn't persisted anywhere today.
	</p>

	<section class="card">
		<div class="card__title"><h2>Window</h2></div>
		<form method="GET" class="fields">
			<label>From <input type="date" name="from" value={data.from} /></label>
			<label>To <input type="date" name="to" value={data.to} /></label>
			<button class="button button--secondary" type="submit">View</button>
		</form>
		<a class="button" href="/reports/export?from={data.from}&to={data.to}">Export CSV (estimate accuracy)</a>
	</section>

	<section class="card">
		<div class="card__title"><h2>Estimate accuracy by station</h2></div>
		{#if data.perStation.length === 0}
			<p class="muted">No completed jobs with matched actuals in this window.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Station</th>
						<th>Estimated hrs</th>
						<th>Actual hrs</th>
						<th>Variance</th>
					</tr>
				</thead>
				<tbody>
					{#each data.perStation as row (row.stationName)}
						<tr>
							<td>{row.stationName}</td>
							<td>{row.estimatedHours.toFixed(1)}</td>
							<td>{row.actualHours.toFixed(1)}</td>
							<td>{(row.actualHours - row.estimatedHours).toFixed(1)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Worst variance (top 10)</h2></div>
		{#if data.lineItemVariance.length === 0}
			<p class="muted">Nothing to compare yet.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Design</th>
						<th>Station</th>
						<th>Estimated</th>
						<th>Actual</th>
						<th>Variance</th>
					</tr>
				</thead>
				<tbody>
					{#each data.lineItemVariance.slice(0, 10) as row (row.lineItemId)}
						<tr>
							<td>{row.design}</td>
							<td>{row.stationName}</td>
							<td>{row.estimatedHours.toFixed(2)}</td>
							<td>{row.actualHours.toFixed(2)}</td>
							<td>{row.varianceHours.toFixed(2)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>On-time completion</h2></div>
		<p>
			{data.onTime.onTimeCount} of {data.onTime.total} completed order{data.onTime.total === 1 ? '' : 's'} finished on
			or before their internal due date.
		</p>
		{#if data.onTime.late.length > 0}
			<p class="muted">
				Notes are entered on the order's page (Orders/Archive → open the order) — nothing here
				infers a reason on its own.
			</p>
			<ul class="plain">
				{#each data.onTime.late as order (order.orderId)}
					<li>
						<a href="/orders/{order.orderId}">{order.hoopsOrderId}</a> — due {order.dueDate.toISOString().slice(0, 10)}, completed {order.completedAt?.toISOString().slice(0, 10) ?? '—'}
						{#if order.notes}
							<br /><span class="muted">"{order.notes}"</span>
						{:else}
							<br /><span class="muted">No notes yet.</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Currently blocked</h2></div>
		<p>{data.blockedCount} line item{data.blockedCount === 1 ? '' : 's'} waiting on a dependency right now.</p>
	</section>

	<section class="card">
		<div class="card__title"><h2>Recent changes</h2></div>
		{#if data.recentChanges.length === 0}
			<p class="muted">Nothing in this window.</p>
		{:else}
			<ul class="plain">
				{#each data.recentChanges as change (change.id)}
					<li>{change.at.toISOString().slice(0, 16).replace('T', ' ')} — {change.action} ({change.entity}) by {change.actor}</li>
				{/each}
			</ul>
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

	.fields {
		display: flex;
		gap: 0.75rem;
		align-items: end;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}
</style>
