<script lang="ts">
	import { pressable } from '$lib/actions/pressable.svelte';
	import { createSlidingIndicator } from '$lib/actions/slidingIndicator.svelte';

	/**
	 * Animated screen-switcher shared by every section that splits into
	 * screens instead of routes (Schools today; Finance/Admin reuse this
	 * unchanged in later phases). The active-tab pill is a real spring
	 * gliding between tabs, not a CSS transition on `left` — springs handle
	 * "measured on click, settles physically" better than a fixed-duration
	 * transition would when tab widths differ.
	 */
	let {
		screens,
		active,
		onchange
	}: {
		screens: readonly { key: string; label: string }[];
		active: string;
		onchange: (key: string) => void;
	} = $props();

	const nav = createSlidingIndicator();

	$effect(() => {
		nav.setActive(active);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('resize', nav.measure);
		return () => window.removeEventListener('resize', nav.measure);
	});
</script>

<div class="tabbar" role="tablist" use:nav.setContainer>
	<span
		class="tabbar__indicator"
		style:transform="translateX({nav.indicator.current.x}px)"
		style:width="{nav.indicator.current.width}px"
	></span>
	{#each screens as screen (screen.key)}
		<button
			type="button"
			role="tab"
			class="tabbar__tab"
			class:tabbar__tab--active={screen.key === active}
			aria-selected={screen.key === active}
			use:pressable
			use:nav.register={screen.key}
			onclick={() => onchange(screen.key)}
		>
			{screen.label}
		</button>
	{/each}
</div>

<style>
	.tabbar {
		position: relative;
		display: inline-flex;
		gap: var(--space-1);
		padding: var(--space-1);
		/* A darker tinted track with an edge, and a raised secondary-style pill for the
		   selected tab, so neither blends into the panel behind it. */
		background: var(--brand-200);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}

	.tabbar__indicator {
		position: absolute;
		top: var(--space-1);
		bottom: var(--space-1);
		left: 0;
		background: var(--secondary-bg);
		border: 1px solid var(--secondary-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-flat);
		pointer-events: none;
	}

	.tabbar__tab {
		position: relative;
		z-index: 1;
		background: transparent;
		border: none;
		box-shadow: none;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		font: inherit;
		font-weight: 600;
		font-size: var(--fs-sm);
		color: var(--ink-700);
		cursor: pointer;
		transition: color var(--motion-fast) var(--ease-standard);
		transform: scale(var(--press-scale, 1));
	}

	.tabbar__tab:hover {
		color: var(--ink-900);
	}

	.tabbar__tab--active {
		color: var(--ink-900);
	}
</style>
