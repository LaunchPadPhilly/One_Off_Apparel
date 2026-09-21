<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import StatCard from '$lib/components/ui/StatCard.svelte';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let editingId = $state<string | null>(null);

	// NEW (2026-09-21) — redesign pass. Each at-risk category gets its own short label,
	// icon and badge tone, so "why couldn't this be scheduled" reads as three distinct,
	// scannable situations instead of one long undifferentiated list. Identity is never
	// color-alone here — label + icon carry it, color is secondary.
	const CATEGORY_META: Record<string, { label: string; badgeClass: string; icon: string }> = {
		formula: {
			label: 'No formula yet',
			badgeClass: 'badge--warn',
			// wrench — "this needs a setup/business decision"
			icon: 'M14.7 6.3a4 4 0 0 1-5.3 4.7L4 16.4V19h2.6l5.4-5.4a4 4 0 0 1 4.7-5.3l-2.6 2.6-1.4-1.4 2.6-2.6z'
		},
		missing_data: {
			label: 'Missing job details',
			badgeClass: 'badge',
			// pencil — "this needs a field filled in"
			icon: 'M4 15.5V19h3.5L17.8 8.7l-3.5-3.5L4 15.5zM19.7 6.3a1 1 0 0 0 0-1.4l-2.6-2.6a1 1 0 0 0-1.4 0l-1.6 1.6 3.5 3.5 1.6-1.6z'
		},
		capacity: {
			label: 'No open capacity',
			badgeClass: 'badge--off',
			// calendar — "this needs a station/capacity set up"
			icon: 'M6 3v2M14 3v2M4 8h12M5 5h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'
		}
	};

	function jobLabel(count: number) {
		return count === 1 ? 'job' : 'jobs';
	}
</script>

<svelte:head>
	<title>Schedule — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<span class="eyebrow">Production board</span>
	<h1>Schedule</h1>
	<p class="muted">
		Confirmed orders only. Propose a schedule for the window below, review the table it produces,
		then Approve to make it official. Provisional scaffolding — no layout/grouping decision has
		been made yet. See CLAUDE.md's "Production board (provisional)" open item.
	</p>

	<!-- NEW (2026-09-21): a standing, always-visible notice (not just after a propose
	     run) when there's literally no Station/CapacityCalendar data at all yet — the
	     single biggest reason nothing places, worth surfacing proactively rather than
	     only after someone clicks Propose and gets a wall of red text. -->
	{#if data.stations.length === 0}
		<div class="notice">
			<strong>No stations or capacity configured yet.</strong>
			<span class="muted">
				Nothing can be placed onto a schedule until at least one production station and its open
				hours exist. This needs real data from the shop — station names and daily capacity — not
				something to guess at here.
			</span>
		</div>
	{/if}

	{#if form?.message}
		<p class="error">{form.message}</p>
	{/if}

	<!-- NEW (2026-09-21): replaces the old plain "Placed X of Y" sentence with two stat
	     tiles, same pattern as Orders/Admin — a placed count and an at-risk count, so
	     the outcome of a propose run reads as a headline instead of a paragraph. -->
	{#if form?.consideredCount !== undefined}
		<div class="grid result-grid">
			<StatCard value={form.placedCount} label="jobs placed" tone={form.placedCount > 0 ? 'default' : 'warn'} />
			<StatCard
				value={form.consideredCount - form.placedCount}
				label="jobs at risk"
				tone={form.consideredCount - form.placedCount > 0 ? 'warn' : 'default'}
			/>
		</div>
	{/if}

	<!-- NEW (2026-09-21): grouped into collapsible cards, one per category, instead of
	     one long flat list — <details>/<summary> needs no JS and stays keyboard/
	     screen-reader accessible for free. Open by default so nothing's hidden on
	     first load; collapsing is just there for when the list gets long. -->
	{#if form?.atRiskGroups?.length}
		<div class="risk-groups">
			{#each form.atRiskGroups as group (group.category + group.reason)}
				{@const meta = CATEGORY_META[group.category] ?? CATEGORY_META.capacity}
				<details class="card risk-card risk-card--{group.category}" open>
					<summary>
						<svg class="risk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
							<path d={meta.icon} />
						</svg>
						<span class="risk-card__label">{meta.label}</span>
						<span class="badge {meta.badgeClass}">{group.jobs.length} {jobLabel(group.jobs.length)}</span>
					</summary>
					<p class="risk-card__reason">{group.reason}</p>
					<ul class="plain">
						{#each group.jobs as job (job.lineItemId)}
							<li><a href="/orders/{job.orderId}">{job.hoopsOrderId}</a> — {job.customerName} — {job.design}</li>
						{/each}
					</ul>
				</details>
			{/each}
		</div>
	{/if}

	<section class="card">
		<div class="card__title"><h2>Window</h2></div>
		<form method="GET" class="fields">
			<label>From <input type="date" name="from" value={data.from} /></label>
			<label>To <input type="date" name="to" value={data.to} /></label>
			<button class="button button--secondary" use:pressable type="submit">View</button>
		</form>
		{#if data.canAct}
			<form method="POST" action="?/propose" use:enhance class="fields">
				<input type="hidden" name="from" value={data.from} />
				<input type="hidden" name="to" value={data.to} />
				<button class="button" use:pressable type="submit">Propose schedule for this window</button>
			</form>
		{/if}
	</section>

	{#each data.days as day (day.date)}
		<section class="card">
			<div class="card__title"><h2>{day.date}</h2></div>
			<table>
				<thead>
					<tr>
						<th>Station</th>
						<th>Job</th>
						<th>Order</th>
						<th>Design</th>
						<th>Est. hrs</th>
						<th>Status</th>
						{#if data.canAct}<th></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each day.assignments as assignment (assignment.id)}
						<tr>
							<td><span class="badge station-badge">{assignment.station.name}</span></td>
							<td><a href="/orders/{assignment.lineItem.orderId}">{assignment.lineItem.order.hoopsOrderId}</a></td>
							<td>{assignment.lineItem.order.customerName}</td>
							<td>{assignment.lineItem.design}</td>
							<td class="hours-cell">{assignment.estimatedHours.toFixed(2)}h</td>
							<td>
								<span
									class="badge"
									class:badge--warn={assignment.status === 'PROPOSED'}
									class:badge--success={assignment.status === 'APPROVED' || assignment.status === 'IN_PROGRESS'}
								>
									{assignment.status}
								</span>
							</td>
							{#if data.canAct}
								<td class="actions">
									{#if assignment.status === 'PROPOSED'}
										<form method="POST" action="?/commit" use:enhance style="display:inline">
											<input type="hidden" name="assignmentIds" value={assignment.id} />
											<button class="button" use:pressable type="submit">Approve</button>
										</form>
										<button class="button button--secondary" use:pressable type="button" onclick={() => (editingId = assignment.id)}>
											Edit
										</button>
										<form method="POST" action="?/remove" use:enhance style="display:inline">
											<input type="hidden" name="assignmentId" value={assignment.id} />
											<button class="button button--danger" use:pressable type="submit">Remove</button>
										</form>
										{#if editingId === assignment.id}
											<form method="POST" action="?/reassign" use:enhance class="fields fields--inline">
												<input type="hidden" name="assignmentId" value={assignment.id} />
												<select name="stationId">
													{#each data.stations as station (station.id)}
														<option value={station.id} selected={station.id === assignment.stationId}>{station.name}</option>
													{/each}
												</select>
												<input type="date" name="date" value={day.date} />
												<button class="button button--secondary" use:pressable type="submit">Save</button>
											</form>
										{/if}
									{:else if assignment.status === 'APPROVED'}
										<form method="POST" action="?/start" use:enhance style="display:inline">
											<input type="hidden" name="assignmentId" value={assignment.id} />
											<button class="button" use:pressable type="submit">Start</button>
										</form>
									{:else if assignment.status === 'IN_PROGRESS'}
										<form method="POST" action="?/stop" use:enhance style="display:inline">
											<input type="hidden" name="assignmentId" value={assignment.id} />
											<button class="button button--secondary" use:pressable type="submit">Stop</button>
										</form>
									{/if}
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{:else}
		<section class="card">
			<p class="muted">Nothing proposed, approved or in progress in this window.</p>
		</section>
	{/each}
</div>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	th {
		color: var(--ink-500);
		font-size: 0.85rem;
		font-weight: 550;
	}

	tbody tr:last-child td {
		border-bottom: none;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		align-items: center;
	}

	.fields {
		display: flex;
		gap: 0.75rem;
		align-items: end;
		flex-wrap: wrap;
		margin: 0.5rem 0;
	}

	.fields--inline {
		width: 100%;
		margin-top: 0.5rem;
	}

	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	.error {
		color: var(--danger-fg);
	}

	.result-grid {
		margin-bottom: 1.25rem;
	}

	.hours-cell {
		font-variant-numeric: tabular-nums;
	}

	.station-badge {
		font-variant-numeric: tabular-nums;
	}

	/* NEW (2026-09-21): the "no capacity configured" banner — same visual weight as an
	   .alert, but not reusing that class since alerts in this app are for form-result
	   messages, not a standing page notice. */
	.notice {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.85rem 1rem;
		margin-bottom: 1.25rem;
		background: var(--warm-100);
		border: 1px solid var(--warm-300);
		border-radius: var(--radius-sm);
	}

	/* NEW (2026-09-21): the grouped at-risk cards. */
	.risk-groups {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 1.25rem;
	}

	.risk-card {
		margin-bottom: 0;
		padding: 1rem 1.25rem;
		border-left: 3px solid var(--border);
	}

	.risk-card--formula {
		border-left-color: var(--danger-fg);
	}

	.risk-card--missing_data {
		border-left-color: var(--warm-600);
	}

	.risk-card--capacity {
		border-left-color: var(--ink-500);
	}

	.risk-card summary {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		cursor: pointer;
		list-style: none;
		font-weight: 600;
	}

	.risk-card summary::-webkit-details-marker {
		display: none;
	}

	.risk-icon {
		width: 1.1rem;
		height: 1.1rem;
		flex-shrink: 0;
		color: var(--ink-500);
	}

	.risk-card__label {
		flex: 1;
	}

	.risk-card__reason {
		margin: 0.6rem 0 0.4rem;
		color: var(--ink-500);
	}

	.risk-card ul {
		margin: 0.3rem 0 0;
		padding-left: 1.1rem;
	}
</style>
