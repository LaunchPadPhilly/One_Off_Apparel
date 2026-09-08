<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import NavLink from '$lib/components/NavLink.svelte';
	import { createSlidingIndicator } from '$lib/actions/slidingIndicator.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { fly, fade } from 'svelte/transition';
	import { page } from '$app/state';
	import '../app.css';
	import { appConfig } from '$lib/appConfig';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// Visibility rules live in one place and mirror exactly what the server-side guards
	// allow — a link that would 403 is never rendered. A scope-gated domain page is added
	// as `{ href: '/reports', label: 'Reports', show: user.scopes.includes('REPORTS_READ') }`.
	const navLinks = $derived.by(() => {
		const user = data.user;
		if (!user) return [];

		return [
			{ href: '/admin', label: 'Admin', show: user.isAdmin },
			{ href: '/settings', label: 'Settings', show: true }
		].filter((link) => link.show);
	});

	const nav = createSlidingIndicator();

	const activeHref = $derived.by(() => {
		const path = page.url.pathname;
		const match = navLinks.find((l) => path === l.href || path.startsWith(l.href + '/'));
		return match?.href ?? '';
	});

	$effect(() => {
		nav.setActive(activeHref);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('resize', nav.measure);
		return () => window.removeEventListener('resize', nav.measure);
	});

	// Keying the page transition on just the top-level segment (not the full path)
	// means moving between sections animates, but navigating within one (e.g. into
	// /admin/users/[id] and back) doesn't replay it.
	const topLevelSegment = $derived(page.url.pathname.split('/')[1] ?? '');
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="site-header">
	<div class="site-header__inner">
		<a class="site-header__brand" href="/">{appConfig.displayName}</a>
		<nav class="site-header__nav">
			{#if data.user}
				<div class="site-header__links" use:nav.setContainer>
					<span
						class="site-header__indicator"
						style:transform="translateX({nav.indicator.current.x}px)"
						style:width="{nav.indicator.current.width}px"
					></span>
					{#each navLinks as link (link.href)}
						<NavLink href={link.href} label={link.label} register={nav.register} />
					{/each}
				</div>
				<span class="muted">{data.user.displayName ?? data.user.email}</span>
				<form method="POST" action="/api/auth/logout">
					<button class="button--secondary" type="submit">Sign out</button>
				</form>
			{:else}
				<a class="button" href="/api/auth/google/login">Sign in</a>
			{/if}
		</nav>
	</div>
</header>

{#key topLevelSegment}
	<div in:fly={screenEnter} out:fade={screenExit}>
		{@render children()}
	</div>
{/key}

<style>
	.site-header__links {
		position: relative;
		display: flex;
		gap: var(--space-1);
	}

	.site-header__indicator {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		background: var(--warm-100);
		border-radius: var(--radius-md);
		pointer-events: none;
		z-index: 0;
	}
</style>
