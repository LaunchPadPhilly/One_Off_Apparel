<script lang="ts">
	import { appConfig } from '$lib/appConfig';
	import NavCard from '$lib/components/ui/NavCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{appConfig.displayName}</title>
</svelte:head>

<div class="page page--narrow">
	{#if !data.signedIn}
		<div class="card hero">
			<span class="eyebrow">{appConfig.displayName}</span>
			<h1>Your organization's data, queryable by people and by AI agents</h1>
			<p class="muted">
				Internal data platform with Google Workspace sign-in, admin-granted data scopes, and a
				read-only MCP server that AI clients connect to with OAuth. Sign in with your Workspace
				account to continue.
			</p>
			<a class="button" href="/api/auth/google/login">Sign in with Google</a>

			{#if data.devLoginEnabled}
				<hr style="margin: 1.5rem 0; border: 0; border-top: 1px solid rgba(0,0,0,0.1);" />
				<p class="muted">
					<strong>Dev bypass enabled.</strong> Signs you in as a local dev admin — never
					enabled in production.
				</p>
				<form method="POST" action="/api/auth/dev-login">
					<button type="submit" class="button">Dev bypass sign-in</button>
				</form>
			{/if}
		</div>
	{:else}
		<h1>Welcome</h1>
		<p class="muted">
			This is the template's placeholder home. Replace it with the client's first data page, and
			point the signed-in redirect in <code>src/routes/+page.server.ts</code> at it.
		</p>
		<div class="grid">
			<NavCard href="/settings" title="Settings" description="Your scopes, connected AI clients, and appearance." />
			{#if data.isAdmin}
				<NavCard href="/admin" title="Admin" description="Agent tokens, connected apps, activity log, and users." />
			{/if}
		</div>
	{/if}
</div>

<style>
	.hero {
		text-align: left;
	}

	.hero h1 {
		font-size: var(--fs-display);
	}

	.grid {
		display: grid;
		gap: var(--space-3);
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
	}
</style>
