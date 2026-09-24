<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import TabBar from '$lib/components/ui/TabBar.svelte';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit, revealProgress } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Admin is one route with four client-side screens — mirrors Schools/Finance.
	// Only /admin/users/[id] is a real route, since it needs a user's id.
	const SCREENS = [
		{ key: 'agents', label: 'Agents' },
		{ key: 'clients', label: 'Connected Apps' },
		{ key: 'activity', label: 'Activity Log' },
		{ key: 'users', label: 'Users' }
	] as const;
	type Screen = (typeof SCREENS)[number]['key'];

	let activeScreen = $state<Screen>((page.url.searchParams.get('screen') as Screen) || 'agents');

	function setScreen(next: string) {
		activeScreen = next as Screen;
		const url = new URL(page.url);
		if (next === 'agents') url.searchParams.delete('screen');
		else url.searchParams.set('screen', next);
		replaceState(url, page.state);
	}

	function formatDate(value: Date | string | null) {
		return value ? new Date(value).toLocaleString() : '—';
	}

	function agentStatus(agent: (typeof data.agents)[number]) {
		if (agent.revokedAt) return { label: 'Revoked', cls: 'badge badge--off' };
		if (agent.expiresAt && new Date(agent.expiresAt) < new Date()) return { label: 'Expired', cls: 'badge badge--off' };
		return { label: 'Active', cls: 'badge badge--on' };
	}

	// Mirrors deriveAccountStatus in src/lib/server/userStatus.ts — Active/Inactive
	// reflect whether the user is logged in right now (has a live session), not
	// just whether their account is enabled.
	function userStatusBadge(status: (typeof data.users)[number]['status']) {
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

	const rangeOptions = [
		{ key: '24h', label: 'Last 24 hours' },
		{ key: '7d', label: 'Last 7 days' },
		{ key: '30d', label: 'Last 30 days' },
		{ key: 'all', label: 'All time' }
	];

	const maxCount = $derived(Math.max(1, ...data.activity.byAction.map((row) => row.count)));
	const activityReveal = revealProgress();
</script>

<svelte:head>
	<title>Admin — {appConfig.displayName}</title>
</svelte:head>

<div class="page">
	<span class="eyebrow">Admin</span>
	<h1>Admin</h1>
	<p class="muted">Agent tokens, connected AI clients, activity, and user access — every change here writes to the audit log.</p>

	<TabBar screens={SCREENS} active={activeScreen} onchange={setScreen} />

	{#key activeScreen}
		<div class="screen" in:fly={screenEnter} out:fade={screenExit}>
			{#if activeScreen === 'agents'}
				<p class="muted">
					Machine credentials for automations and agents with no human user behind them. Each token is
					individually named, scoped, revocable, and attributable in the audit log — prefer these over the
					legacy shared <code>MCP_SERVER_TOKEN</code>.
				</p>

				{#if form?.screen === 'agents' && 'createdToken' in form && form.createdToken}
					<div class="alert alert--info">
						<strong>Token for “{form.createdName}” created.</strong>
						<p class="muted">
							Copy it now — it's stored only as a hash and can never be shown again. If you lose it,
							revoke this agent and create a new one.
						</p>
						<pre class="token">{form.createdToken}</pre>
					</div>
				{:else if form?.screen === 'agents' && 'message' in form && form.message}
					<div class="alert alert--error">{form.message}</div>
				{/if}

				<section class="card">
					<div class="card__title"><h2>Create an agent token</h2></div>
					<form method="POST" action="?/create" use:enhance class="form-grid">
						<label>
							<span>Name</span>
							<input name="name" required placeholder="Nightly reporting job" />
						</label>
						<label>
							<span>Description <span class="muted">(optional)</span></span>
							<input name="description" placeholder="What this agent does" />
						</label>
						<fieldset>
							<legend>Scopes</legend>
							{#each data.scopeOptions as scope (scope.value)}
								<label class="checkbox"><input type="checkbox" name={scope.value} /> {scope.label}</label>
							{/each}
						</fieldset>
						<label>
							<span>Expires in days <span class="muted">(blank = never)</span></span>
							<input name="expiresInDays" type="number" min="1" placeholder="90" />
						</label>
						<div><button type="submit" use:pressable>Create token</button></div>
					</form>
				</section>

				<section class="card">
					<div class="card__title"><h2>Registered agents</h2></div>
					{#if data.agents.length === 0}
						<p class="muted">No agent tokens yet.</p>
					{:else}
						<div class="table-scroll">
							<table>
								<thead>
									<tr>
										<th>Agent</th>
										<th>Token</th>
										<th>Scopes</th>
										<th>Status</th>
										<th>Last used</th>
										<th>Expires</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									{#each data.agents as agent (agent.id)}
										<tr>
											<td>
												{agent.name}
												{#if agent.description}<div class="muted">{agent.description}</div>{/if}
											</td>
											<td><code>{agent.tokenPrefix}…</code></td>
											<td>
												{#each agent.scope as scope (scope)}
													<span class="badge badge--on">{scope}</span>
												{/each}
											</td>
											<td><span class={agentStatus(agent).cls}>{agentStatus(agent).label}</span></td>
											<td class="muted">{formatDate(agent.lastUsedAt)}</td>
											<td class="muted">{formatDate(agent.expiresAt)}</td>
											<td>
												{#if !agent.revokedAt}
													<form method="POST" action="?/revoke" use:enhance>
														<input type="hidden" name="agentId" value={agent.id} />
														<button class="button--danger" use:pressable type="submit">Revoke</button>
													</form>
												{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>
			{:else if activeScreen === 'clients'}
				<p class="muted">
					AI clients that registered themselves against this server's MCP OAuth endpoint. Disabling a
					client immediately revokes every token it holds.
				</p>

				<section class="card">
					{#if data.clients.length === 0}
						<p class="muted">No clients have registered yet.</p>
					{:else}
						<div class="table-scroll">
							<table>
								<thead>
									<tr>
										<th>Name</th>
										<th>Status</th>
										<th>Active tokens</th>
										<th>Registered</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									{#each data.clients as client (client.id)}
										<tr>
											<td>
												{client.clientName ?? 'Unnamed client'}
												<div class="muted">{client.redirectUris.join(', ')}</div>
											</td>
											<td>
												{#if client.disabledAt}
													<span class="badge badge--off">Disabled</span>
												{:else}
													<span class="badge badge--on">Active</span>
												{/if}
											</td>
											<td>{client.activeTokens}</td>
											<td>{new Date(client.createdAt).toLocaleDateString()}</td>
											<td>
												<form method="POST" action={client.disabledAt ? '?/enable' : '?/disable'} use:enhance>
													<input type="hidden" name="clientId" value={client.clientId} />
													<button
														class={client.disabledAt ? 'button--secondary' : 'button--danger'}
														use:pressable
														type="submit"
													>
														{client.disabledAt ? 'Enable' : 'Disable'}
													</button>
												</form>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>
			{:else if activeScreen === 'activity'}
				<p class="muted">Every login, scope change, token issuance, and denied access attempt recorded by the platform.</p>

				<nav class="range-nav">
					{#each rangeOptions as option (option.key)}
						<a
							class="button {data.activity.range === option.key ? '' : 'button--secondary'}"
							href={`/admin?screen=activity&range=${option.key}`}
						>
							{option.label}
						</a>
					{/each}
				</nav>

				<div class="grid">
					<StatCard value={data.activity.totals.events} label="events in range" />
					<StatCard
						value={data.activity.totals.securityEvents}
						tone={data.activity.totals.securityEvents > 0 ? 'warn' : 'default'}
						label="denied / rejected attempts"
					/>
					<StatCard value={data.activity.totals.activeAgents} label="active agent tokens" />
					<StatCard value={data.activity.totals.activeUserTokens} label="active user tokens" />
					<StatCard value={data.activity.totals.activeClients} label="enabled AI clients" />
					<StatCard value={data.activity.totals.usersWithScopes} label="users with data scopes" />
				</div>

				<section class="card">
					<div class="card__title"><h2>Activity by type</h2></div>
					{#if data.activity.byAction.length === 0}
						<p class="muted">No events recorded in this range.</p>
					{:else}
						<ul class="bars">
							{#each data.activity.byAction as row (row.action)}
								<li>
									<span class="bars__label">{row.action}</span>
									<span class="bars__track">
										<span class="bars__fill" style:width="{(row.count / maxCount) * 100 * activityReveal.current}%"
										></span>
									</span>
									<span class="bars__count">{row.count}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<section class="card">
					<div class="card__title"><h2>Security events</h2></div>
					{#if data.activity.securityEvents.length === 0}
						<p class="muted">No denied or rejected access attempts in this range.</p>
					{:else}
						<div class="table-scroll">
							<table>
								<thead>
									<tr><th>Action</th><th>Who</th><th>Details</th><th>When</th></tr>
								</thead>
								<tbody>
									{#each data.activity.securityEvents as event (event.id)}
										<tr>
											<td><span class="badge badge--off">{event.action}</span></td>
											<td>{event.actorEmail ?? '—'}</td>
											<td class="muted">{event.metadata ?? '—'}</td>
											<td class="muted">{formatDate(event.createdAt)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>

				<section class="card">
					<div class="card__title"><h2>Recent activity</h2></div>
					{#if data.activity.recentEvents.length === 0}
						<p class="muted">No events recorded in this range.</p>
					{:else}
						<div class="table-scroll">
							<table>
								<thead>
									<tr><th>Action</th><th>Resource</th><th>Who</th><th>When</th></tr>
								</thead>
								<tbody>
									{#each data.activity.recentEvents as event (event.id)}
										<tr>
											<td>{event.action}</td>
											<td class="muted">{event.resource}</td>
											<td>{event.actorEmail ?? '—'}</td>
											<td class="muted">{formatDate(event.createdAt)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</section>
			{:else}
				<p class="muted">
					New users get the default scope ({data.scopeOptions[0]?.label}) automatically on their first
					sign-in — nothing else. Every other scope and admin access require an explicit grant here.
					Every change is written to the audit log.
				</p>

				{#if form?.screen === 'users' && 'invitedEmail' in form && form.invitedEmail}
					<div class="alert alert--info">
						<strong>Invited {form.invitedEmail}.</strong>
						{#if form.emailSent}
							<p class="muted">Invitation email sent.</p>
						{:else}
							<p class="muted">
								Email sending isn't configured yet — share this sign-in link with them directly:
							</p>
							<pre class="token">{form.signInUrl}</pre>
						{/if}
					</div>
				{/if}

				<section class="card">
					<div class="card__title"><h2>Invite a user</h2></div>
					<p class="muted">
						Creates their account as "Invited" and sends a sign-in invitation. They aren't required
						to be invited first — anyone from an allowed Workspace domain can already sign in
						directly — this is just a proactive nudge.
					</p>
					<form method="POST" action="?/inviteUser" use:enhance class="invite-row">
						<input type="email" name="email" required placeholder="name@example.org" aria-label="Email to invite" />
						<button type="submit" use:pressable>Send invite</button>
					</form>
				</section>

				<section class="card">
					<div class="table-scroll">
						<table>
							<thead>
								<tr>
									<th>User</th>
									<th>Status</th>
									<th>Last login</th>
									<th>Admin</th>
									{#each data.scopeOptions as scope (scope.value)}
										<th>{scope.label}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each data.users as user (user.id)}
									<tr>
										<td>
											<a href={`/admin/users/${user.id}`}>{user.displayName ?? user.email}</a>
											{#if user.displayName}<div class="muted">{user.email}</div>{/if}
										</td>
										<td><span class={userStatusBadge(user.status).cls}>{userStatusBadge(user.status).label}</span></td>
										<td class="muted">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'never'}</td>
										<td>
											<form method="POST" action={user.isAdmin ? '?/revokeAdmin' : '?/grantAdmin'} use:enhance>
												<input type="hidden" name="userId" value={user.id} />
												<button class={user.isAdmin ? 'button--danger' : 'button--secondary'} use:pressable type="submit">
													{user.isAdmin ? 'Revoke' : 'Grant'}
												</button>
											</form>
										</td>
										{#each data.scopeOptions as scope (scope.value)}
											<td>
												<form
													method="POST"
													action={user.scopes.includes(scope.value) ? '?/revokeScope' : '?/grantScope'}
													use:enhance
												>
													<input type="hidden" name="userId" value={user.id} />
													<input type="hidden" name="scope" value={scope.value} />
													<button
														class={user.scopes.includes(scope.value) ? 'button--danger' : 'button--secondary'}
														use:pressable
														type="submit"
													>
														{user.scopes.includes(scope.value) ? 'Revoke' : 'Grant'}
													</button>
												</form>
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</section>

				{#if form?.screen === 'users' && 'message' in form && form.message}
					<div class="alert alert--error">{form.message}</div>
				{/if}
			{/if}
		</div>
	{/key}
</div>

<style>
	.screen {
		margin-top: 1.5rem;
	}

	.form-grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
		align-items: end;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-weight: 550;
		font-size: 0.925rem;
	}

	input[type='number'],
	input[type='email'],
	input:not([type]) {
		font: inherit;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--brand-50);
		color: var(--ink-900);
	}

	input:focus-visible {
		outline: none;
		box-shadow: var(--focus);
	}

	.invite-row {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.invite-row input {
		flex: 1;
		min-width: 14rem;
	}

	fieldset {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.6rem 0.8rem;
		margin: 0;
	}

	legend {
		font-size: 0.925rem;
		font-weight: 550;
		padding: 0 0.35rem;
	}

	.checkbox {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		font-weight: 450;
	}








	.token {
		background: var(--ink-900);
		color: var(--brand-100);
		padding: 0.8rem 1rem;
		border-radius: 8px;
		overflow-x: auto;
		font-size: 0.9rem;
		margin: 0;
	}

	.range-nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.55rem;
	}

	.bars li {
		display: grid;
		grid-template-columns: minmax(9rem, 14rem) 1fr auto;
		gap: 0.75rem;
		align-items: center;
		font-size: 0.9rem;
	}

	.bars__label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bars__track {
		background: var(--brand-100);
		border-radius: 999px;
		height: 0.55rem;
		overflow: hidden;
	}

	.bars__fill {
		display: block;
		height: 100%;
		background: var(--brand-500);
		border-radius: 999px;
		transition: width var(--motion-fast) var(--ease-standard);
	}

	.bars__count {
		font-variant-numeric: tabular-nums;
		color: var(--ink-500);
	}

	@media (max-width: 34rem) {
		.bars li {
			grid-template-columns: 1fr auto;
		}

		.bars__track {
			grid-column: 1 / -1;
		}
	}
</style>
