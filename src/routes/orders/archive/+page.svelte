<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let search = $state('');

	const filtered = $derived(
		search.trim()
			? data.orders.filter(
					(order) =>
						order.customerName.toLowerCase().includes(search.toLowerCase()) ||
						order.hoopsOrderId.toLowerCase().includes(search.toLowerCase())
				)
			: data.orders
	);
</script>

<svelte:head>
	<title>Archive — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<a class="muted" href="/orders">&larr; Orders</a>
	<span class="eyebrow">Archive</span>
	<h1>Completed &amp; cancelled orders</h1>
	<p class="muted">Read-only. Same order/line-item data as Orders, filtered to status: complete or cancelled.</p>

	<input class="search" placeholder="Search by customer or job number" bind:value={search} />

	<section class="card">
		{#if filtered.length === 0}
			<p class="muted">{data.orders.length === 0 ? 'No completed orders yet.' : 'No matches.'}</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Job</th>
						<th>Customer</th>
						<th>Due date</th>
						<!-- NEW (2026-09-21): this page used to only ever show COMPLETE orders,
						     so a status column wasn't needed. Now it shows both COMPLETE and
						     CANCELLED, so this column is needed to tell them apart. -->
						<th>Status</th>
						<th>Line items</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as order (order.id)}
						<tr>
							<td>{order.hoopsOrderId}</td>
							<td>{order.customerName}</td>
							<td>{order.internalDueDate}</td>
							<!-- Red "danger" badge styling only kicks in for CANCELLED orders,
							     so COMPLETE orders keep the plain, neutral badge look. -->
							<td><span class="badge" class:badge--danger={order.status === 'CANCELLED'}>{order.status}</span></td>
							<td>{order.lineItemCount}</td>
							<td><a class="button button--secondary" href="/orders/{order.id}">View</a></td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>

<style>
	.search {
		margin: 0.75rem 0;
		max-width: 24rem;
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
</style>
