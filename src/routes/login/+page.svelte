<script lang="ts">
	import { appConfig } from '$lib/appConfig';
	import { page } from '$app/state';

	let { data } = $props();
	const status = $derived(page.url.searchParams.get('status'));
</script>

<svelte:head>
	<title>Sign in — {appConfig.displayName}</title>
</svelte:head>

<div class="page page--narrow">
	<div class="card">
		<h1>Sign in</h1>

		{#if status === 'error'}
			<div class="alert alert--error">
				Something went wrong signing in. Please try again.
			</div>
		{:else if status === 'not_allowed'}
			<div class="alert alert--error">
				This Google account isn't part of an approved Workspace domain. Sign in with your
				organization account, or contact an administrator if you believe this is a mistake.
			</div>
		{:else if status === 'signed_out'}
			<div class="alert alert--info">You've been signed out.</div>
		{:else}
			<p class="muted">Use your organization's Google Workspace account to continue.</p>
		{/if}

		<a class="button" href="/api/auth/google/login">Sign in with Google</a>

		{#if data.devLoginEnabled}
			<hr style="margin: 1rem 0; border-color: var(--color-border, #ccc);" />
			<a class="button button--secondary" href="/api/auth/dev-login">Dev Login (skip OAuth)</a>
		{/if}
	</div>
</div>
