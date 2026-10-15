<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { shortDraftCode } from '$lib/schedule/shortDraftCode';
	import ScheduleBoard from './drafts/[id]/ScheduleBoard.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The live schedule (2026-10-15) is the same board a draft uses, finalized: what's
	// approved is what the floor runs. Drafts sit above it.
	// Collapsed once there's live work, so the board is what you see first.
	let draftsOpen = $state(untrack(() => data.assignments.length === 0));

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

<ScheduleBoard data={data} form={form && 'message' in form ? { message: form.message } : null}>
	{#snippet headerActions()}
		{#if data.canCreate}
			<a class="button button--secondary" use:pressable href="/schedule/new">Create schedule</a>
			<!-- Runs the deterministic propose_schedule engine and drops the result into a
			     brand-new draft — see proposeIntoNewDraft.ts. No LLM decides placements. -->
			<form method="POST" action="?/createAutomatic" use:enhance>
				<button class="button" use:pressable type="submit">Create automatic schedule</button>
			</form>
		{/if}
	{/snippet}

	{#snippet intro()}
		<section class="card drafts-card">
			<button type="button" class="card__title drafts-card__toggle" aria-expanded={draftsOpen} onclick={() => (draftsOpen = !draftsOpen)}>
				<h2>{draftsOpen ? '▾' : '▸'} Drafts</h2>
				<span class="muted">{data.drafts.length} {data.drafts.length === 1 ? 'draft' : 'drafts'} · approve one to put it on the schedule below</span>
			</button>
			{#if draftsOpen}
				{#if data.drafts.length === 0}
					<p class="muted">
						No drafts yet.
						{#if data.canCreate}
							<a href="/schedule/new">Create one</a> to plan a schedule.
						{/if}
					</p>
				{:else}
					<!-- Bulk selection toolbar. Only interactive to users with SCHEDULE_WRITE. -->
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
									<!-- Checkbox is a sibling of the anchor, not inside it, so a click
									     toggles it instead of navigating. -->
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
										<span class="badge" class:badge--success={draft.status === 'APPROVED'}>{draft.status === 'APPROVED' ? 'Approved' : 'Draft'}</span>
									</div>
									<div class="draft-card__meta muted">
										<code
											class="draft-card__code"
											title="Short code — paste into Claude chat to refer to this draft unambiguously (same-day auto-drafts share names)"
											>{shortDraftCode(draft.id)}</code
										>
										· {draft.startDate} · {draft.weeks} {draft.weeks === 1 ? 'week' : 'weeks'} ·
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
			{/if}
		</section>

		{#if data.laterJobs.count > 0}
			<p class="muted empty-live">
				{data.laterJobs.count} more approved job{data.laterJobs.count === 1 ? '' : 's'} from {data.laterJobs.firstDate} on
				{data.laterJobs.count === 1 ? 'is' : 'are'} past the 12 weeks shown here — open {data.laterJobs.count === 1 ? 'its' : 'their'} draft to see {data.laterJobs.count === 1 ? 'it' : 'them'}.
			</p>
		{/if}
		{#if data.assignments.length === 0}
			<p class="muted empty-live">
				Nothing approved yet. Open a draft and approve it — it shows up here, finalized, exactly as it looked in the draft.
			</p>
		{/if}
	{/snippet}
</ScheduleBoard>

<style>
	.drafts-card {
		margin-bottom: var(--space-4);
	}

	/* The card title doubles as a collapse toggle, so the board is one click away. */
	.drafts-card__toggle {
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.empty-live {
		margin: 0 0 var(--space-4);
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
		border-color: var(--brand-500);
		background: var(--brand-100);
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
		accent-color: var(--brand-500);
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
		border-bottom-color: var(--brand-500);
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
		accent-color: var(--brand-500);
		cursor: pointer;
	}

	.draft-toolbar__count {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--brand-700);
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
