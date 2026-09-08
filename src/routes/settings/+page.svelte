<script lang="ts">
	import { page } from '$app/state';
	import { fly, fade } from 'svelte/transition';
	import TabBar from '$lib/components/ui/TabBar.svelte';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { reducedMotion, screenEnter, screenExit, DURATION, EASE } from '$lib/motion';
	import { appConfig, storageKeyPrefix } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Theme = 'system' | 'light' | 'dark' | 'slate';
	const THEME_KEY = `${storageKeyPrefix}theme`;
	const THEME_OPTIONS = [
		{ key: 'system', label: 'System' },
		{ key: 'light', label: 'Light' },
		{ key: 'dark', label: 'Dark' },
		{ key: 'slate', label: 'Slate' }
	] as const;

	type Density = 'comfortable' | 'compact';
	const DENSITY_KEY = `${storageKeyPrefix}density`;
	const DENSITY_OPTIONS = [
		{ key: 'comfortable', label: 'Comfortable' },
		{ key: 'compact', label: 'Compact' }
	] as const;

	type MotionPref = 'system' | 'reduced' | 'full';
	const MOTION_OPTIONS = [
		{ key: 'system', label: 'System' },
		{ key: 'reduced', label: 'Reduced' },
		{ key: 'full', label: 'Full' }
	] as const;

	// Read saved preferences (if any) so the pickers reflect what app.html already
	// applied before first paint — fall back to the neutral default when nothing's saved.
	let theme = $state<Theme>('system');
	let density = $state<Density>('comfortable');
	let motionPref = $state<MotionPref>('system');

	$effect(() => {
		try {
			const savedTheme = localStorage.getItem(THEME_KEY);
			if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'slate') theme = savedTheme;
		} catch {
			// localStorage unavailable (private browsing, etc.) — stay on "system".
		}

		try {
			if (localStorage.getItem(DENSITY_KEY) === 'compact') density = 'compact';
		} catch {
			// stay comfortable
		}

		const override = reducedMotion.override;
		motionPref = override === 'on' ? 'reduced' : override === 'off' ? 'full' : 'system';
	});

	function setTheme(next: string) {
		theme = next as Theme;
		try {
			if (next === 'system') {
				localStorage.removeItem(THEME_KEY);
				delete document.documentElement.dataset.theme;
			} else {
				localStorage.setItem(THEME_KEY, next);
				document.documentElement.dataset.theme = next;
			}
		} catch {
			// localStorage unavailable — the choice just won't persist across reloads.
		}
	}

	function setDensity(next: string) {
		density = next as Density;
		try {
			if (next === 'comfortable') {
				localStorage.removeItem(DENSITY_KEY);
				delete document.documentElement.dataset.density;
			} else {
				localStorage.setItem(DENSITY_KEY, next);
				document.documentElement.dataset.density = next;
			}
		} catch {
			// localStorage unavailable — the choice just won't persist across reloads.
		}
	}

	function setMotion(next: string) {
		motionPref = next as MotionPref;
		reducedMotion.set(next === 'reduced' ? 'on' : next === 'full' ? 'off' : null);
	}

	const user = $derived(page.data.user);
</script>

<svelte:head>
	<title>Settings — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<span class="eyebrow">Settings</span>
	<h1>Settings</h1>
	<p class="muted">Your account details, access, and display preferences.</p>

	<section class="card">
		<div class="card__title"><h2>Profile</h2></div>
		<dl>
			<div>
				<dt>Email</dt>
				<dd>{user?.email}</dd>
			</div>
			<div>
				<dt>Display name</dt>
				<dd>{user?.displayName ?? '—'}</dd>
			</div>
			{#if user?.isAdmin}
				<div>
					<dt>Role</dt>
					<dd><span class="badge">Admin</span></dd>
				</div>
			{/if}
		</dl>
		<p class="muted">
			Profile details come from your Google Workspace account and can't be edited here.
		</p>
	</section>

	<section class="section">
		<div class="card__title"><h2>Your account</h2></div>
		<div class="grid">
			{#each [0, 1] as i (i)}
				<div in:fly={{ y: 8, duration: DURATION.base, delay: i * 40, easing: EASE.standard }}>
					{#if i === 0}
						<section class="card">
							<div class="card__title">
								<h2>Your access</h2>
								{#if user?.isAdmin}<span class="badge">Admin</span>{/if}
							</div>
							{#if data.scopes.length > 0}
								<ul class="plain">
									{#each data.scopes as scope (scope)}
										<li><span class="badge badge--on">{scope}</span></li>
									{/each}
								</ul>
								<p class="muted">
									These scopes determine which MCP tools you can reach through a connected AI client.
								</p>
							{:else}
								<p class="muted">
									You don't have any data scopes yet. An administrator needs to grant you one before
									you can query data through a connected AI client.
								</p>
							{/if}
						</section>
					{:else}
						<section class="card">
							<div class="card__title"><h2>Connected AI clients</h2></div>
							{#if data.connectedClients.length > 0}
								<ul class="plain">
									{#each data.connectedClients as client (client.clientId)}
										<li><span class="badge">{client.clientName}</span></li>
									{/each}
								</ul>
								<p class="muted">
									{data.activeTokenCount} active access {data.activeTokenCount === 1 ? 'token' : 'tokens'}.
								</p>
							{:else}
								<p class="muted">
									No AI clients are connected to your account yet. Add this server as a custom connector
									in Claude to get started.
								</p>
							{/if}
						</section>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	<section class="card">
		<div class="card__title"><h2>Appearance</h2></div>
		<p class="muted">Choose how {appConfig.displayName} looks and feels on this device.</p>

		<div class="pref-row">
			<span class="pref-label">Theme</span>
			<TabBar screens={THEME_OPTIONS} active={theme} onchange={setTheme} />
		</div>

		<div class="pref-row">
			<span class="pref-label">Density</span>
			<TabBar screens={DENSITY_OPTIONS} active={density} onchange={setDensity} />
		</div>
	</section>

	<section class="card">
		<div class="card__title"><h2>Accessibility</h2></div>
		<p class="muted">
			Every animation in this app already respects your operating system's reduced-motion
			setting. This overrides that, if you want it different just here.
		</p>
		<div class="pref-row">
			<span class="pref-label">Motion</span>
			<TabBar screens={MOTION_OPTIONS} active={motionPref} onchange={setMotion} />
		</div>
	</section>

	<section class="card">
		<div class="card__title"><h2>Notifications</h2></div>
		<p class="muted">
			Not wired up yet — no notifications are sent today. These reflect what's planned, not what
			works.
		</p>
		<div class="notif-list">
			<label class="notif-item">
				<input type="checkbox" disabled />
				<span>
					<span class="notif-title">Email me when my access changes</span>
					<span class="muted notif-desc">A scope or admin role is granted or revoked on your account.</span>
				</span>
				<span class="badge badge--off">Coming soon</span>
			</label>
			<label class="notif-item">
				<input type="checkbox" disabled />
				<span>
					<span class="notif-title">Email me about new connected AI clients</span>
					<span class="muted notif-desc">A new AI client registers and starts using your account.</span>
				</span>
				<span class="badge badge--off">Coming soon</span>
			</label>
		</div>
	</section>

	<section class="card">
		<div class="card__title"><h2>Session</h2></div>
		<form method="POST" action="/api/auth/logout">
			<button class="button button--secondary" use:pressable type="submit">Sign out</button>
		</form>
	</section>
</div>

<style>
	.section {
		margin-bottom: 1.25rem;
	}

	dl {
		margin: 0 0 0.75rem;
		display: grid;
		gap: 0.4rem;
	}

	dl div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.4rem;
	}

	dl div:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}

	dt {
		color: var(--ink-500);
		font-size: 0.925rem;
	}

	dd {
		margin: 0;
		font-weight: 600;
	}

	.pref-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 0.75rem 0;
		border-top: 1px solid var(--border);
	}

	.pref-row:first-of-type {
		border-top: none;
	}

	.pref-label {
		font-weight: 550;
		font-size: 0.925rem;
	}

	.notif-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.notif-item {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: not-allowed;
	}

	.notif-item input {
		width: 1.05rem;
		height: 1.05rem;
	}

	.notif-title {
		display: block;
		font-weight: 550;
		font-size: 0.9rem;
	}

	.notif-desc {
		display: block;
		margin-top: 0.1rem;
	}
</style>
