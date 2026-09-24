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
	<div class="header-row">
		<div>
			<span class="eyebrow">Production board</span>
			<h1>Schedule</h1>
		</div>
		{#if data.canCreate}
			<div class="header-actions">
				<a class="button button--secondary" use:pressable href="/schedule/new">Create schedule</a>
				<!-- NEW: runs the deterministic propose_schedule engine against confirmed,
				     approval-gated orders and drops the result into a brand-new draft — see
				     proposeIntoNewDraft.ts. No live LLM call decides placements, per
				     CLAUDE.md's non-negotiable "Claude never computes a schedule" rule. -->
				<form method="POST" action="?/createAutomatic" use:enhance>
					<button class="button" use:pressable type="submit">Create automatic schedule</button>
				</form>
			</div>
		{/if}
	</div>
	<p class="muted">
		Provisional scaffolding — no layout, grouping or route path has been decided yet. See
		CLAUDE.md's "Production board (provisional)" open item.
	</p>

	{#if form?.message}
		<p class="error">{form.message}</p>
	{/if}

	<section class="card">
		<div class="card__title">
			<h2>Drafts</h2>
			<span class="muted">{data.drafts.length} {data.drafts.length === 1 ? 'draft' : 'drafts'}</span>
		</div>
		{#if data.drafts.length === 0}
			<p class="muted">
				No drafts yet.
				{#if data.canCreate}
					<a href="/schedule/new">Create one</a> to hold a candidate schedule window.
				{/if}
			</p>
		{:else}
			<ul class="draft-list">
				{#each data.drafts as draft (draft.id)}
					<li class="draft-card">
						<a href="/schedule/drafts/{draft.id}" class="draft-card__link">
							<div class="draft-card__head">
								<span class="draft-card__name">{draft.name}</span>
								<span class="badge">{draft.status}</span>
							</div>
							<div class="draft-card__meta muted">
								{draft.startDate} · {draft.weeks} {draft.weeks === 1 ? 'week' : 'weeks'} ·
								{draft.strategy === 'BATCH_OPTIMIZE' ? 'Batch-optimize' : 'Strict due-date'}
							</div>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

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
									{#if assignment.status === 'APPROVED' && assignment.lineItem.status === 'BLOCKED'}
										<!-- Scheduled ahead of time, but locked on the floor until the job it
										     waits on is Stopped (startAssignment.ts enforces this server-side). -->
										<span class="badge" title="Stop the job this waits on first — then this unlocks.">Waiting on print</span>
									{:else if assignment.status === 'APPROVED'}
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

	.header-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.25rem;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.draft-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.6rem;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
	}

	.draft-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		transition: border-color var(--motion-fast) var(--ease-standard), background-color var(--motion-fast) var(--ease-standard);
	}

	.draft-card:hover {
		border-color: var(--brand-300);
		background: var(--brand-100);
	}

	.draft-card__link {
		display: block;
		padding: 0.85rem 1rem;
		color: inherit;
		text-decoration: none;
	}

	.draft-card__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.35rem;
	}

	.draft-card__name {
		font-weight: 600;
		color: var(--ink-900);
	}

	.draft-card__meta {
		font-size: 0.85rem;
	}
</style>
