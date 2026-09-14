<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Schedule — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<span class="eyebrow">Production board</span>
	<h1>Schedule</h1>
	<p class="muted">
		Provisional scaffolding — no layout, grouping or route path has been decided yet. See
		CLAUDE.md's "Production board (provisional)" open item.
	</p>

	{#if form?.message}
		<p class="error">{form.message}</p>
	{/if}

	<section class="card">
		{#if data.assignments.length === 0}
			<p class="muted">Nothing approved or in progress right now.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Station</th>
						<th>Design</th>
						<th>Date</th>
						<th>Status</th>
						{#if data.canAct}<th></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each data.assignments as assignment (assignment.id)}
						<tr>
							<td>{assignment.station.name}</td>
							<td>{assignment.lineItem.design}</td>
							<td>{assignment.date}</td>
							<td><span class="badge">{assignment.status}</span></td>
							{#if data.canAct}
								<td>
									{#if assignment.status === 'APPROVED'}
										<form method="POST" action="?/start" use:enhance>
											<input type="hidden" name="assignmentId" value={assignment.id} />
											<button class="button" use:pressable type="submit">Start</button>
										</form>
									{:else if assignment.status === 'IN_PROGRESS'}
										<form method="POST" action="?/stop" use:enhance>
											<input type="hidden" name="assignmentId" value={assignment.id} />
											<button class="button button--secondary" use:pressable type="submit">Stop</button>
										</form>
									{/if}
								</td>
							{/if}
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
</style>
