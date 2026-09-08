<script lang="ts">
	import { appConfig } from '$lib/appConfig';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const requestId = $derived(page.url.searchParams.get('request') ?? '');
</script>

<svelte:head>
	<title>Authorize access — {appConfig.displayName}</title>
</svelte:head>

<div class="page page--narrow">
	<div class="card">
		<h1>Authorize {data.clientName}</h1>
		<p class="muted">
			This application is requesting access to {appConfig.displayName} data on your behalf.
		</p>

		{#if form?.message}
			<div class="alert alert--error">{form.message}</div>
		{/if}

		{#if data.grantableScopes.length > 0}
			<h2>Will be granted</h2>
			<ul class="plain">
				{#each data.grantableScopes as scope (scope)}
					<li><span class="badge badge--on">{scope}</span></li>
				{/each}
			</ul>
		{/if}

		{#if data.ungrantableScopes.length > 0}
			<h2>Not yet active</h2>
			<ul class="plain">
				{#each data.ungrantableScopes as scope (scope)}
					<li><span class="badge badge--off">{scope}</span></li>
				{/each}
			</ul>
			<p class="muted">
				You don't currently have these scopes. If you approve, this connection will be pre-authorized
				for them — an administrator can grant them at any time and access will turn on automatically,
				with no need to reconnect.
			</p>
		{/if}

		{#if data.grantableScopes.length === 0}
			<div class="alert alert--error">
				You don't have any of the requested scopes, so there's nothing to authorize. Contact an
				administrator to request access, then try connecting again.
			</div>
		{/if}

		<div class="actions">
			<form method="POST" action={`?/approve&request=${requestId}`} use:enhance>
				<button type="submit" disabled={data.grantableScopes.length === 0}>Approve</button>
			</form>
			<form method="POST" action={`?/deny&request=${requestId}`} use:enhance>
				<button class="button--secondary" type="submit">Deny</button>
			</form>
		</div>
	</div>
</div>
