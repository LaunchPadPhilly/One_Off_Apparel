<script lang="ts">
	import Skeleton from './Skeleton.svelte';
	import AnimatedNumber from './AnimatedNumber.svelte';

	/**
	 * Shared big-number stat tile. Promoted out of schools/[id]/+page.svelte, which had
	 * this same .stat/.stat__value pattern scoped locally — kept identical visually so
	 * existing pages read the same way if migrated to this component later.
	 *
	 * Numeric values tween from their previous value via AnimatedNumber; string values
	 * ("—", a tier label, etc.) render as plain text since there's nothing to tween.
	 */
	let {
		value,
		label,
		tone = 'default',
		loading = false,
		format
	}: {
		value: string | number;
		label: string;
		tone?: 'default' | 'down' | 'warn';
		loading?: boolean;
		format?: (n: number) => string;
	} = $props();
</script>

<section class="card stat">
	{#if loading}
		<Skeleton width="4.5rem" height="2rem" />
		<Skeleton width="6rem" height="0.9rem" />
	{:else}
		<span class="stat__value stat__value--{tone}">
			{#if typeof value === 'number'}
				<AnimatedNumber {value} {format} />
			{:else}
				{value}
			{/if}
		</span>
		<span class="muted">{label}</span>
	{/if}
</section>

<style>
	/* A thin accent line along the top: Ocean blue by default, amber for "needs
	   attention", red for "down" — the same status colors badges use. */
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-bottom: 0;
		position: relative;
		overflow: hidden;
	}

	.stat::before {
		content: '';
		position: absolute;
		inset: 0 0 auto;
		height: 3px;
		background: var(--stat-accent, var(--brand-500));
	}

	.stat:has(.stat__value--warn) {
		--stat-accent: var(--warning-fg);
	}

	.stat:has(.stat__value--down) {
		--stat-accent: var(--danger-fg);
	}

	.stat__value {
		font-size: 2rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.1;
		color: var(--ink-900);
		font-variant-numeric: tabular-nums;
	}

	.stat__value--down {
		color: var(--danger-fg);
	}

	.stat__value--warn {
		color: var(--warning-fg);
	}
</style>
