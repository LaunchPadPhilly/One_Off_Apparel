<script lang="ts">
	import { enhance } from '$app/forms';
	import { pressable } from '$lib/actions/pressable.svelte';

	/**
	 * Settings → Stations (config settings, 2026-09-25): add, rename, reorder, remove and
	 * restore the stations that make up the schedule board's rows. Server logic lives in
	 * $lib/server/config/stations.ts; this is only the forms.
	 */
	type Station = {
		id: string;
		label: string;
		kind: string;
		autoSchedule: boolean;
		archivedAt: Date | string | null;
		certifiedCount: number;
		openAssignmentCount: number;
	};

	let {
		stations,
		kindOptions,
		notice,
		message
	}: {
		stations: Station[];
		kindOptions: readonly { value: string; label: string; category: string }[];
		notice: string | null;
		message: string | null;
	} = $props();

	const active = $derived(stations.filter((station) => !station.archivedAt));
	const archived = $derived(stations.filter((station) => station.archivedAt));
	const kindLabel = $derived(new Map(kindOptions.map((kind) => [kind.value, kind.label])));

	// Edit forms keep what's typed after saving instead of resetting to the old values.
	const keepValues = () => async ({ update }: { update: (options?: { reset?: boolean }) => Promise<void> }) => update({ reset: false });

	function confirmRemove(event: SubmitEvent, station: Station) {
		if (!confirm(`Remove ${station.label}? It disappears from the schedule board and automatic scheduling. Its history stays in Reports, and you can restore it later.`)) {
			event.preventDefault();
		}
	}
</script>

<p class="muted">
	The stations here are the rows on the schedule board. Each one has a <strong>kind</strong>, which sets how its job
	times are calculated. Two stations of the same kind (say two auto presses) share the work between them. Turn off
	<strong>automatic scheduling</strong> for a station that people choose by hand, like the manual press. The
	automatic schedule will never put jobs there, but you can still drag jobs onto it.
</p>

{#if message}
	<div class="alert alert--error">{message}</div>
{:else if notice}
	<div class="alert alert--info">{notice}</div>
{/if}

<section class="card">
	<div class="card__title"><h2>Add a station</h2></div>
	<form method="POST" action="?/createStation" use:enhance class="form-grid">
		<label>
			<span>Name</span>
			<input name="label" required maxlength="60" placeholder="Screen Print Auto 2" />
		</label>
		<label>
			<span>Kind</span>
			<select name="kind" required>
				<option value="" disabled selected>Choose…</option>
				<optgroup label="Production">
					{#each kindOptions.filter((kind) => kind.category === 'production') as kind (kind.value)}
						<option value={kind.value}>{kind.label}</option>
					{/each}
				</optgroup>
				<optgroup label="Finishing">
					{#each kindOptions.filter((kind) => kind.category === 'finishing') as kind (kind.value)}
						<option value={kind.value}>{kind.label}</option>
					{/each}
				</optgroup>
			</select>
		</label>
		<label class="checkbox">
			<input type="checkbox" name="autoSchedule" checked />
			Automatic scheduling
		</label>
		<div><button type="submit" use:pressable>Add station</button></div>
	</form>
</section>

<section class="card">
	<div class="card__title"><h2>Stations</h2></div>
	{#if active.length === 0}
		<p class="muted">No active stations. Nothing can be scheduled until you add one.</p>
	{:else}
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th>Order</th>
						<th>Name</th>
						<th>Kind</th>
						<th>Automatic scheduling</th>
						<th>Certified people</th>
						<th>Scheduled jobs</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each active as station, index (station.id)}
						{@const formId = `station-${station.id}`}
						<tr>
							<td class="order-cell">
								<form method="POST" action="?/moveStation" use:enhance class="order-buttons">
									<input type="hidden" name="id" value={station.id} />
									<button class="button--secondary icon-button" name="direction" value="up" disabled={index === 0} aria-label="Move {station.label} up">↑</button>
									<button class="button--secondary icon-button" name="direction" value="down" disabled={index === active.length - 1} aria-label="Move {station.label} down">↓</button>
								</form>
							</td>
							<td>
								<input form={formId} name="label" value={station.label} required maxlength="60" aria-label="Name of {station.label}" />
							</td>
							<td>{kindLabel.get(station.kind) ?? station.kind}</td>
							<td>
								<label class="checkbox">
									<input form={formId} type="checkbox" name="autoSchedule" checked={station.autoSchedule} />
									{station.autoSchedule ? 'On' : 'Off (hand-placed only)'}
								</label>
							</td>
							<td>{station.certifiedCount}</td>
							<td>{station.openAssignmentCount}</td>
							<td class="actions">
								<form id={formId} method="POST" action="?/updateStation" use:enhance={keepValues}>
									<input type="hidden" name="id" value={station.id} />
									<button type="submit" class="button--secondary" use:pressable>Save</button>
								</form>
								<form method="POST" action="?/archiveStation" use:enhance onsubmit={(event) => confirmRemove(event, station)}>
									<input type="hidden" name="id" value={station.id} />
									<button
										type="submit"
										class="button--danger"
										use:pressable
										title={station.openAssignmentCount > 0 ? 'Move or remove its scheduled jobs first' : undefined}
									>
										Remove
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

{#if archived.length > 0}
	<section class="card">
		<div class="card__title"><h2>Removed stations</h2></div>
		<p class="muted">Not on the board and never scheduled. Their past jobs still show in Reports.</p>
		<div class="table-scroll">
			<table>
				<thead>
					<tr><th>Name</th><th>Kind</th><th>Removed</th><th></th></tr>
				</thead>
				<tbody>
					{#each archived as station (station.id)}
						<tr>
							<td>{station.label}</td>
							<td>{kindLabel.get(station.kind) ?? station.kind}</td>
							<td class="muted">{station.archivedAt ? new Date(station.archivedAt).toLocaleDateString() : ''}</td>
							<td>
								<form method="POST" action="?/restoreStation" use:enhance>
									<input type="hidden" name="id" value={station.id} />
									<button type="submit" class="button--secondary" use:pressable>Restore</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.form-grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
		align-items: end;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-weight: 550;
		font-size: 0.925rem;
	}

	.checkbox {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
		font-weight: 450;
		white-space: nowrap;
	}

	input:not([type]),
	select {
		font: inherit;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--brand-50);
		color: var(--ink-900);
		min-width: 0;
	}

	td input:not([type]) {
		width: 100%;
		min-width: 10rem;
	}

	input:focus-visible,
	select:focus-visible {
		outline: none;
		box-shadow: var(--focus);
	}

	.order-buttons,
	.actions {
		display: flex;
		gap: 0.4rem;
	}

	.icon-button {
		padding: 0.3rem 0.6rem;
		line-height: 1;
	}
</style>
