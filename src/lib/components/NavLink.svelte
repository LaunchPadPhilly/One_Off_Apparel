<script lang="ts">
	import { page } from '$app/state';

	/**
	 * A single header navigation link.
	 *
	 * Centralises what every nav item needs — active-route detection, the `aria-current`
	 * hint screen readers use, and the styling — so adding a destination is one line in
	 * the layout rather than a copied anchor plus its own highlight logic.
	 */
	let {
		href,
		label,
		/** Match this route only, rather than it and everything beneath it. */
		exact = false,
		/** Registers this link's `<a>` with a parent-owned sliding indicator (see
		 * src/lib/actions/slidingIndicator.svelte.ts) — a no-op action when the
		 * caller doesn't wire one, so NavLink still works standalone. */
		register = () => ({})
	}: {
		href: string;
		label: string;
		exact?: boolean;
		register?: (node: HTMLElement, key: string) => { destroy?: () => void };
	} = $props();

	const current = $derived(
		exact
			? page.url.pathname === href
			: page.url.pathname === href || page.url.pathname.startsWith(href + '/')
	);
</script>

<a
	{href}
	class="nav-link"
	class:nav-link--current={current}
	aria-current={current ? 'page' : undefined}
	use:register={href}
>
	{label}
</a>

<style>
	.nav-link {
		position: relative;
		z-index: 1;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		text-decoration: none;
		white-space: nowrap;
		color: var(--nav-fg);
		font-weight: 600;
		transition: color var(--motion-fast) var(--ease-standard);
	}

	.nav-link:hover {
		color: var(--nav-fg-active);
	}

	.nav-link--current {
		color: var(--nav-fg-active);
		font-weight: 700;
	}
</style>
