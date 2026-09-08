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
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-bottom: 0;
	}

	.stat__value {
		font-size: 2rem;
		font-weight: 650;
		line-height: 1.1;
		color: var(--warm-600);
	}

	.stat__value--down {
		color: var(--danger-fg);
	}

	.stat__value--warn {
		color: var(--warm-700);
	}
</style>
