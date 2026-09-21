<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function strategyLabel(value: string): string {
		if (value === 'BATCH_OPTIMIZE') return 'Batch-optimize (ATCS)';
		if (value === 'STRICT_DUE_DATE') return 'Strict due-date order';
		return value;
	}

	function endDateIso(startIso: string, weeks: number): string {
		const d = new Date(`${startIso}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() + weeks * 7 - 1);
		return d.toISOString().slice(0, 10);
	}
</script>

<svelte:head>
	<title>{data.draft.name} — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<a class="back-link" href="/schedule">← Back to schedule</a>
	<span class="eyebrow">Schedule draft</span>
	<h1>{data.draft.name}</h1>
	<p class="muted">
		Draft created — nothing is on the live schedule yet. Proposing assignments into this draft
		is still to come.
	</p>

	<section class="card">
		<dl class="details">
			<div><dt>Status</dt><dd><span class="badge">{data.draft.status}</span></dd></div>
			<div><dt>Window</dt><dd>{data.draft.startDate} → {endDateIso(data.draft.startDate, data.draft.weeks)} ({data.draft.weeks} {data.draft.weeks === 1 ? 'week' : 'weeks'})</dd></div>
			<div><dt>Strategy</dt><dd>{strategyLabel(data.draft.strategy)}</dd></div>
			<div><dt>Created by</dt><dd>{data.draft.createdBy}</dd></div>
			<div><dt>Created</dt><dd>{new Date(data.draft.createdAt).toLocaleString()}</dd></div>
			{#if data.draft.description}
				<div class="wide"><dt>Notes</dt><dd>{data.draft.description}</dd></div>
			{/if}
		</dl>
	</section>
</div>

<style>
	.back-link {
		display: inline-block;
		margin-bottom: 0.75rem;
		color: var(--ink-500);
		font-size: 0.9rem;
		text-decoration: none;
	}

	.back-link:hover {
		color: var(--warm-700);
	}

	.details {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
		gap: 1rem 1.5rem;
		margin: 0;
	}

	.details > div.wide {
		grid-column: 1 / -1;
	}

	dt {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-500);
		font-weight: 650;
		margin-bottom: 0.25rem;
	}

	dd {
		margin: 0;
		color: var(--ink-900);
		font-size: 0.95rem;
	}
</style>
