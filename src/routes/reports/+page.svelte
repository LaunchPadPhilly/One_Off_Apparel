<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type Slot = { station: string; date: string; time?: string | null };
	const when = (at: Date) => at.toISOString().slice(0, 16).replace('T', ' ');
	const slotText = (slot: Slot) => `${slot.station}, ${slot.date}${slot.time ? ` ${slot.time}` : ''}`;
	const KIND_LABELS: Record<string, string> = {
		reopened: 'Reopened',
		replaced: 'Moved by a new plan',
		worker_out: 'Someone out',
		slots_removed: 'Slots removed'
	};
	const formError = (changeId: string) => (form && 'changeId' in form && form.changeId === changeId && 'message' in form ? form.message : null);
</script>

{#snippet changeJobs(jobs: { job: string; hoopsOrderId: string; from?: Slot; to?: Slot }[])}
	{#if jobs.length > 0}
		<ul class="change__jobs">
			{#each jobs as job, index (index)}
				<li>
					<strong>{job.hoopsOrderId}</strong> · {job.job}
					{#if job.from && job.to}
						— {slotText(job.from)} → {slotText(job.to)}
					{:else if job.from}
						— was {slotText(job.from)}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<svelte:head>
	<title>Reports — {appConfig.displayName}</title>
</svelte:head>

<div class="page" in:fly={screenEnter} out:fade={screenExit}>
	<span class="eyebrow">Reports</span>
	<h1>Reports</h1>
	<p class="muted">
		Minimal, per CLAUDE.md's Known open items — only what the schema already supports (actuals vs.
		estimated_hours, on-time completion, currently-blocked line items, recent changes). No historical
		at-risk trend yet — that isn't persisted anywhere today.
	</p>

	<section class="card">
		<div class="card__title"><h2>Window</h2></div>
		<form method="GET" class="fields">
			<label>From <input type="date" name="from" value={data.from} /></label>
			<label>To <input type="date" name="to" value={data.to} /></label>
			<button class="button button--secondary" type="submit">View</button>
		</form>
		<a class="button" href="/reports/export?from={data.from}&to={data.to}">Export CSV (estimate accuracy)</a>
	</section>

	<section class="card">
		<div class="card__title"><h2>Schedule changes</h2></div>
		<p class="muted">
			Changes made to the approved schedule after it was approved. Each one waits here until someone says why it
			happened — here or by telling Claude. Nothing fills in a reason on its own.
		</p>

		<h3>Needs a reason</h3>
		{#if data.scheduleChanges.needsReason.length === 0}
			<p class="muted">Every change to the approved schedule has a reason.</p>
		{:else}
			<ul class="changes">
				{#each data.scheduleChanges.needsReason as change (change.id)}
					<li class="change">
						<div class="change__head">
							<span class="badge badge--warn">{KIND_LABELS[change.kind] ?? change.kind}</span>
							<span class="muted">{when(change.at)} · {change.actor}</span>
						</div>
						<p class="change__summary">{change.summary}</p>
						{#if change.details?.outReason}
							<p class="muted">When they were marked out: “{change.details.outReason}”</p>
						{/if}
						{@render changeJobs(change.details?.jobs ?? [])}
						{#if data.canExplainChanges}
							<form method="POST" action="?/explainChange" use:enhance class="change__form">
								<input type="hidden" name="changeId" value={change.id} />
								<label>
									Why did this change?
									<textarea name="reason" rows="2" maxlength="2000" required placeholder="e.g. Rush order for 100157 came in"></textarea>
								</label>
								<button class="button button--secondary" type="submit">Save</button>
							</form>
							{#if formError(change.id)}
								<p class="change__error" role="alert">{formError(change.id)}</p>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<h3>Change notes</h3>
		{#if data.scheduleChanges.explained.length === 0}
			<p class="muted">No explained changes in this window.</p>
		{:else}
			<ul class="changes">
				{#each data.scheduleChanges.explained as change (change.id)}
					<li class="change">
						<div class="change__head">
							<span class="badge">{KIND_LABELS[change.kind] ?? change.kind}</span>
							<span class="muted">{when(change.at)} · {change.actor}</span>
						</div>
						<p class="change__summary">{change.summary}</p>
						<p class="change__reason">“{change.reason}”</p>
						<p class="muted">— {change.reasonBy}{change.reasonAt ? `, ${when(change.reasonAt)}` : ''}</p>
						{@render changeJobs(change.details?.jobs ?? [])}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Estimate accuracy by station</h2></div>
		{#if data.perStation.length === 0}
			<p class="muted">No completed jobs with matched actuals in this window.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Station</th>
						<th>Estimated hrs</th>
						<th>Actual hrs</th>
						<th>Variance</th>
					</tr>
				</thead>
				<tbody>
					{#each data.perStation as row (row.stationName)}
						<tr>
							<td>{row.stationName}</td>
							<td>{row.estimatedHours.toFixed(1)}</td>
							<td>{row.actualHours.toFixed(1)}</td>
							<td>{(row.actualHours - row.estimatedHours).toFixed(1)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Worst variance (top 10)</h2></div>
		{#if data.lineItemVariance.length === 0}
			<p class="muted">Nothing to compare yet.</p>
		{:else}
			<table>
				<thead>
					<tr>
						<th>Design</th>
						<th>Station</th>
						<th>Estimated</th>
						<th>Actual</th>
						<th>Variance</th>
					</tr>
				</thead>
				<tbody>
					{#each data.lineItemVariance.slice(0, 10) as row (row.lineItemId)}
						<tr>
							<td>{row.design}</td>
							<td>{row.stationName}</td>
							<td>{row.estimatedHours.toFixed(2)}</td>
							<td>{row.actualHours.toFixed(2)}</td>
							<td>{row.varianceHours.toFixed(2)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>On-time completion</h2></div>
		<p>
			{data.onTime.onTimeCount} of {data.onTime.total} completed order{data.onTime.total === 1 ? '' : 's'} finished on
			or before their internal due date.
		</p>
		{#if data.onTime.late.length > 0}
			<p class="muted">
				Notes are entered on the order's page (Orders/Archive → open the order) — nothing here
				infers a reason on its own.
			</p>
			<ul class="plain">
				{#each data.onTime.late as order (order.orderId)}
					<li>
						<a href="/orders/{order.orderId}">{order.hoopsOrderId}</a> — due {order.dueDate?.toISOString().slice(0, 10) ?? '—'}, completed {order.completedAt?.toISOString().slice(0, 10) ?? '—'}
						{#if order.notes}
							<br /><span class="muted">"{order.notes}"</span>
						{:else}
							<br /><span class="muted">No notes yet.</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="card">
		<div class="card__title"><h2>Currently blocked</h2></div>
		<p>{data.blockedCount} line item{data.blockedCount === 1 ? '' : 's'} waiting on a dependency right now.</p>
	</section>

	<section class="card">
		<div class="card__title"><h2>Recent changes</h2></div>
		{#if data.recentChanges.length === 0}
			<p class="muted">Nothing in this window.</p>
		{:else}
			<ul class="plain">
				{#each data.recentChanges as change (change.id)}
					<li>{change.at.toISOString().slice(0, 16).replace('T', ' ')} — {change.action} ({change.entity}) by {change.actor}</li>
				{/each}
			</ul>
		{/if}
	</section>
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

	.fields {
		display: flex;
		gap: 0.75rem;
		align-items: end;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	h3 {
		margin: 1rem 0 0.5rem;
		font-size: 1rem;
	}

	.changes {
		list-style: none;
		padding: 0;
		margin: 0 0 1rem;
		display: flex;
		flex-direction: column;
	}

	.change {
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--border);
	}

	.change:last-child {
		border-bottom: none;
	}

	.change p {
		margin: 0.25rem 0;
	}

	.change__head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.85rem;
	}

	.change__summary {
		font-weight: 550;
	}

	.change__reason {
		color: var(--ink-900);
	}

	.change__jobs {
		margin: 0.25rem 0 0;
		padding-left: 1.1rem;
		font-size: 0.85rem;
		color: var(--ink-700);
	}

	.change__form {
		display: flex;
		gap: 0.75rem;
		align-items: end;
		flex-wrap: wrap;
		margin-top: 0.5rem;
	}

	.change__form label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1 1 16rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	.change__form textarea {
		width: 100%;
		font: inherit;
	}

	.change__error {
		color: var(--danger-fg);
		font-size: 0.85rem;
	}
</style>
