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
			<hr style="margin: 1.5rem 0; border: 0; border-top: 1px solid rgba(0,0,0,0.1);" />
			<div class="alert alert--info">
				<strong>Dev bypass enabled.</strong> Signs you in as a local dev admin —
				never enabled in production.
			</div>
			<form method="POST" action="/api/auth/dev-login">
				<button type="submit" class="button">Dev bypass sign-in</button>
			</form>
		{/if}
	</div>
</div>
