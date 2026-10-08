<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Quick-access module card for the dashboard's navigation grid. Styled like .card
	 * but with its own hover-lift treatment — plain .card is used for static info
	 * panels elsewhere and shouldn't gain a "clickable" look globally.
	 */
	let {
		href,
		title,
		description,
		badge,
		icon
	}: {
		href: string;
		title: string;
		description: string;
		badge?: string;
		icon?: Snippet;
	} = $props();
</script>

<a class="nav-card" {href}>
	<div class="nav-card__top">
		{#if icon}
			<span class="nav-card__icon">{@render icon()}</span>
		{/if}
		{#if badge}<span class="badge">{badge}</span>{/if}
	</div>
	<h3>{title}</h3>
	<p class="muted">{description}</p>
</a>

<style>
	.nav-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 1.5rem;
		display: block;
		color: inherit;
		text-decoration: none;
		transition:
			border-color 120ms ease,
			transform 120ms ease;
	}

	.nav-card:hover {
		border-color: var(--brand-300);
		transform: translateY(-2px);
		color: inherit;
	}

	.nav-card:focus-visible {
		outline: none;
		box-shadow: var(--focus);
	}

	.nav-card__top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 1.5rem;
		margin-bottom: 0.5rem;
	}

	.nav-card__icon {
		color: var(--brand-600);
		display: inline-flex;
	}

	.nav-card h3 {
		margin: 0 0 0.25rem;
		font-size: 1.05rem;
	}

	.nav-card p {
		margin: 0;
	}
</style>
