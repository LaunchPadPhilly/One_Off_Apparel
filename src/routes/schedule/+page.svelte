<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Draft ids selected via the per-card checkboxes. Not persisted across reloads
	// — this is one-off cleanup, not a saved view — so localStorage is deliberately
	// skipped. `enhance`'s post-submit reset() clears it when the delete succeeds.
	let selectedDraftIds = $state<string[]>([]);

	// Drafts still exist on the server; a stale selection (a draft another session
	// deleted between load and submit) is filtered out here so the count and the
	// submitted form both match what's actually deletable.
	let liveSelected = $derived(
		selectedDraftIds.filter((id) => data.drafts.some((d) => d.id === id))
	);
	let allDraftIds = $derived(data.drafts.map((d) => d.id));
	let allSelected = $derived(
		allDraftIds.length > 0 && allDraftIds.every((id) => liveSelected.includes(id))
	);

	function toggleSelectAll() {
		selectedDraftIds = allSelected ? [] : [...allDraftIds];
	}

	function clearSelection() {
		selectedDraftIds = [];
	}

	// Simple browser confirm() before the destructive submit — matches the pattern
	// on the single-draft page (drafts/[id]/+page.svelte's Delete button). `cancel`
	// stops the submission; the returned callback clears the local selection after
	// SvelteKit re-runs load() so the server's fresh drafts list drives the UI.
	function confirmBulkDelete({ cancel }: { cancel: () => void }) {
		const n = liveSelected.length;
		const ok = confirm(
			`Delete ${n} draft${n === 1 ? '' : 's'}? Their proposed placements will be discarded. This cannot be undone.`
		);
		if (!ok) {
			cancel();
			return;
		}
		return async ({ update }: { update: (options?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			selectedDraftIds = [];
		};
	}
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
			<!-- Bulk selection toolbar. Only interactive to users with SCHEDULE_WRITE
			     (canCreate mirrors that scope for this route). Renders in one of two
			     states so the toolbar doesn't shift the drafts list up and down as
			     rows are selected: a resting row with "Select all" / count, or an
			     active row with the delete form. -->
			{#if data.canCreate}
				<div class="draft-toolbar" class:draft-toolbar--active={liveSelected.length > 0}>
					<label class="draft-toolbar__select-all">
						<input
							type="checkbox"
							checked={allSelected}
							indeterminate={liveSelected.length > 0 && !allSelected}
							onchange={toggleSelectAll}
						/>
						<span>Select all</span>
					</label>
					{#if liveSelected.length > 0}
						<span class="draft-toolbar__count">
							{liveSelected.length} selected
						</span>
						<form
							method="POST"
							action="?/deleteDrafts"
							use:enhance={confirmBulkDelete}
							class="draft-toolbar__form"
						>
							{#each liveSelected as id (id)}
								<input type="hidden" name="draftId" value={id} />
							{/each}
							<button
								type="button"
								class="button button--secondary"
								onclick={clearSelection}
							>
								Clear
							</button>
							<button type="submit" class="button button--danger" use:pressable>
								Delete {liveSelected.length} draft{liveSelected.length === 1 ? '' : 's'}
							</button>
						</form>
					{/if}
				</div>
			{/if}
			<ul class="draft-list">
				{#each data.drafts as draft (draft.id)}
					{@const isSelected = liveSelected.includes(draft.id)}
					<li class="draft-card" class:draft-card--selected={isSelected}>
						{#if data.canCreate}
							<!-- Checkbox is a sibling of the anchor, NOT nested inside it — an
							     anchor would otherwise swallow the click and navigate instead of
							     toggling. Siblings don't bubble to each other so no
							     stopPropagation is needed. -->
							<label class="draft-card__select">
								<input
									type="checkbox"
									name="draft-select"
									aria-label="Select {draft.name}"
									bind:group={selectedDraftIds}
									value={draft.id}
								/>
							</label>
						{/if}
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
			{#if form && 'deleted' in form && typeof form.deleted === 'number'}
				<p class="muted draft-list__feedback">
					Deleted {form.deleted} draft{form.deleted === 1 ? '' : 's'}.
				</p>
			{/if}
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
		display: flex;
		align-items: stretch;
		transition: border-color var(--motion-fast) var(--ease-standard),
			background-color var(--motion-fast) var(--ease-standard);
	}

	.draft-card:hover {
		border-color: var(--brand-300);
		background: var(--brand-100);
	}

	.draft-card--selected {
		border-color: var(--warm-500);
		background: var(--warm-100);
	}

	/* Checkbox sits in its own column so it never becomes part of the link's click
	   target — clicking the card away from the checkbox still navigates as before. */
	.draft-card__select {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 0.5rem 0 0.85rem;
		cursor: pointer;
	}

	.draft-card__select input {
		width: 1.05rem;
		height: 1.05rem;
		accent-color: var(--warm-500);
		cursor: pointer;
	}

	.draft-card__link {
		flex: 1;
		display: block;
		padding: 0.85rem 1rem;
		color: inherit;
		text-decoration: none;
		min-width: 0;
	}

	/* Bulk-actions toolbar above the drafts grid. Stays visible even with nothing
	   selected (Select all + count) so the affordance is discoverable, and swaps
	   in the delete form once at least one row is checked. */
	.draft-toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.5rem 0.15rem;
		margin-bottom: 0.6rem;
		border-bottom: 1px solid var(--border);
	}

	.draft-toolbar--active {
		border-bottom-color: var(--warm-500);
	}

	.draft-toolbar__select-all {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--ink-500);
		cursor: pointer;
	}

	.draft-toolbar__select-all input {
		accent-color: var(--warm-500);
		cursor: pointer;
	}

	.draft-toolbar__count {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--warm-700);
	}

	.draft-toolbar__form {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: auto;
	}

	.draft-list__feedback {
		margin-top: 0.75rem;
		font-size: 0.85rem;
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
