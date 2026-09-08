<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function formatDate(value: Date | string | null) {
		return value ? new Date(value).toLocaleString() : '—';
	}

	// Mirrors deriveAccountStatus in src/lib/server/userStatus.ts.
	function statusBadge(status: typeof data.user.status) {
		switch (status) {
			case 'active':
				return { label: 'Active', cls: 'badge badge--on' };
			case 'inactive':
				return { label: 'Inactive', cls: 'badge badge--off' };
			case 'disabled':
				return { label: 'Disabled', cls: 'badge badge--warn' };
			default:
				return { label: 'Invited', cls: 'badge' };
		}
	}
</script>

<svelte:head>
	<title>{data.user.email} — Admin</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<p class="muted"><a href="/admin?screen=users">← Back to users</a></p>

	<span class="eyebrow">User Detail</span>
	<h1>{data.user.displayName ?? data.user.email}</h1>
	<p class="muted">
		{data.user.email} · <span class={statusBadge(data.user.status).cls}>{statusBadge(data.user.status).label}</span>
		{#if data.user.isAdmin}<span class="badge">Admin</span>{/if}
		· Last login {formatDate(data.user.lastLoginAt)}
	</p>

	<section class="card">
		<div class="card__title">
			<h2>Active MCP tokens</h2>
			{#if data.activeTokens.length > 0}
				<form method="POST" action="?/revokeAllTokens" use:enhance>
					<button class="button--danger" use:pressable type="submit">Revoke all</button>
				</form>
			{/if}
		</div>

		{#if data.activeTokens.length === 0}
			<p class="muted">No active tokens. This user has no AI clients currently connected.</p>
		{:else}
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th>Client</th>
							<th>Scopes</th>
							<th>Issued</th>
							<th>Expires</th>
							<th>Last used</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.activeTokens as token (token.id)}
							<tr>
								<td>{token.clientName}</td>
								<td>
									{#each token.scope as scope (scope)}
										<span class="badge badge--on">{scope}</span>
									{/each}
								</td>
								<td>{formatDate(token.createdAt)}</td>
								<td>{formatDate(token.expiresAt)}</td>
								<td>{formatDate(token.lastUsedAt)}</td>
								<td>
									<form method="POST" action="?/revokeToken" use:enhance>
										<input type="hidden" name="tokenId" value={token.id} />
										<button class="button--danger" use:pressable type="submit">Revoke</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Scope history</h2></div>
		{#if data.scopeHistory.length === 0}
			<p class="muted">This user has never been granted a scope.</p>
		{:else}
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th>Scope</th>
							<th>State</th>
							<th>Granted</th>
							<th>Revoked</th>
						</tr>
					</thead>
					<tbody>
						{#each data.scopeHistory as grant (grant.scope + grant.grantedAt)}
							<tr>
								<td>{grant.scope}</td>
								<td>
									{#if grant.revokedAt}
										<span class="badge badge--off">Revoked</span>
									{:else}
										<span class="badge badge--on">Active</span>
									{/if}
								</td>
								<td>{formatDate(grant.grantedAt)}</td>
								<td>{formatDate(grant.revokedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Recent activity</h2></div>
		{#if data.auditEvents.length === 0}
			<p class="muted">No recorded activity.</p>
		{:else}
			<div class="table-scroll">
				<table>
					<thead>
						<tr><th>Action</th><th>When</th></tr>
					</thead>
					<tbody>
						{#each data.auditEvents as event (event.action + event.createdAt)}
							<tr>
								<td>{event.action}</td>
								<td>{formatDate(event.createdAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
