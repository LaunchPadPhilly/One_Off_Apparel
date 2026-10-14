<script lang="ts">
	import { enhance } from '$app/forms';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { isPressKind } from '$lib/schedule/stationKinds';

	/**
	 * Settings → People (config settings, 2026-09-25): the shop-floor roster and which
	 * stations each person is certified to run — and, on a screen-print press, whether
	 * they may run it as the main printer (2026-10-14; everyone else on a press is a
	 * catch). Saving notes has Claude suggest the rules they state; an admin ticks the
	 * right ones and applies them. Server logic lives in $lib/server/config/workers.ts
	 * and workerNoteRules.ts; this is only the forms.
	 */
	type Worker = { id: string; name: string; notes: string | null; archivedAt: Date | string | null; stationIds: string[]; mainStationIds: string[] };
	type Station = { id: string; label: string; kind: string; archivedAt: Date | string | null };
	type Suggestions = {
		workerId: string;
		workerName: string;
		rules: { rule: unknown; label: string; quote: string }[];
		notRules: { quote: string; why: string }[];
	};

	let {
		workers,
		stations,
		kindOptions,
		notice,
		message,
		suggestions
	}: {
		workers: Worker[];
		stations: Station[];
		kindOptions: readonly { value: string; label: string; category: string }[];
		notice: string | null;
		message: string | null;
		suggestions: Suggestions | null;
	} = $props();

	const activeStations = $derived(stations.filter((station) => !station.archivedAt));
	const stationLabel = $derived(new Map(activeStations.map((station) => [station.id, station.label])));
	const finishingKinds = $derived(new Set(kindOptions.filter((kind) => kind.category === 'finishing').map((kind) => kind.value)));
	const stationGroups = $derived([
		{ label: 'Production', stations: activeStations.filter((station) => !finishingKinds.has(station.kind)) },
		{ label: 'Finishing', stations: activeStations.filter((station) => finishingKinds.has(station.kind)) }
	]);

	const activeWorkers = $derived(workers.filter((worker) => !worker.archivedAt));
	const archivedWorkers = $derived(workers.filter((worker) => worker.archivedAt));

	const isPress = (station: Station) => isPressKind(station.kind);
	const pressIds = $derived(new Set(activeStations.filter(isPress).map((station) => station.id)));

	const keepValues = () => async ({ update }: { update: (options?: { reset?: boolean }) => Promise<void> }) => update({ reset: false });

	function confirmRemove(event: SubmitEvent, worker: Worker) {
		if (!confirm(`Remove ${worker.name} from the roster? You can restore them later.`)) event.preventDefault();
	}
</script>

{#snippet workerFields(worker: Worker | null)}
	<div class="fields">
		<label>
			<span>Name</span>
			<input name="name" required maxlength="80" value={worker?.name ?? ''} placeholder="First and last name" />
		</label>
		<label>
			<span>Notes <span class="muted">(optional — Claude suggests rules from these when you save)</span></span>
			<textarea name="notes" maxlength="500" rows="2" placeholder="Runs Auto 1 as main. Out Oct 20–24 for vacation.">{worker?.notes ?? ''}</textarea>
		</label>
	</div>
	<fieldset>
		<legend>Certified on</legend>
		{#if activeStations.length === 0}
			<p class="muted">Add stations first on the Stations screen.</p>
		{/if}
		{#each stationGroups as group (group.label)}
			{#if group.stations.length > 0}
				<div class="cert-group">
					<span class="cert-group__label">{group.label}</span>
					<div class="cert-group__options">
						{#each group.stations as station (station.id)}
							<span class="cert">
								<label class="checkbox">
									<input type="checkbox" name="stationId" value={station.id} checked={worker?.stationIds.includes(station.id) ?? false} />
									{station.label}
								</label>
								{#if isPress(station)}
									<label class="checkbox checkbox--main" title="May run this press as the main printer. Everyone else on a press is a catch.">
										<input type="checkbox" name="mainStationId" value={station.id} checked={worker?.mainStationIds.includes(station.id) ?? false} />
										Main
									</label>
								{/if}
							</span>
						{/each}
					</div>
				</div>
			{/if}
		{/each}
	</fieldset>
{/snippet}

<p class="muted">
	The people who work on the floor, and the stations each one is certified to run. They don't need an app login.
	The automatic schedule only puts people on stations they're certified for, and more people on a job cut its run
	time. A screen-print press only runs with one <strong>Main</strong> printer; everyone else on it is a catch.
</p>

{#if message}
	<div class="alert alert--error">{message}</div>
{:else if notice}
	<div class="alert alert--info">{notice}</div>
{/if}

{#if suggestions}
	<section class="card suggestions">
		<div class="card__title"><h2>From {suggestions.workerName}'s notes</h2></div>
		{#if suggestions.rules.length}
			<p class="muted">Claude read the notes and suggests these settings. Nothing changes until you apply them.</p>
			<form method="POST" action="?/applyWorkerRules" use:enhance class="worker-form">
				<input type="hidden" name="id" value={suggestions.workerId} />
				<ul class="suggestions__list">
					{#each suggestions.rules as suggestion, i (i)}
						<li>
							<label class="checkbox">
								<input type="checkbox" name="rule" value={JSON.stringify(suggestion.rule)} checked />
								<span>
									<strong>{suggestion.label}</strong>
									<span class="muted suggestions__quote">“{suggestion.quote}”</span>
								</span>
							</label>
						</li>
					{/each}
				</ul>
				<div><button type="submit" use:pressable>Apply ticked</button></div>
			</form>
		{/if}
		{#if suggestions.notRules.length}
			<p class="muted suggestions__heading">Not turned into a rule (the schedule doesn't know these):</p>
			<ul class="suggestions__list suggestions__list--plain">
				{#each suggestions.notRules as item, i (i)}
					<li><span class="suggestions__quote">“{item.quote}”</span> — <span class="muted">{item.why}</span></li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<section class="card">
	<div class="card__title"><h2>Add a person</h2></div>
	<form method="POST" action="?/createWorker" use:enhance class="worker-form">
		{@render workerFields(null)}
		<div><button type="submit" use:pressable>Add person</button></div>
	</form>
</section>

<section class="card">
	<div class="card__title"><h2>Team ({activeWorkers.length})</h2></div>
	{#if activeWorkers.length === 0}
		<p class="muted">No one on the roster yet.</p>
	{:else}
		<ul class="people">
			{#each activeWorkers as worker (worker.id)}
				{@const certified = worker.stationIds.filter((id) => stationLabel.has(id))}
				<li class="person">
					<div class="person__head">
						<div>
							<strong>{worker.name}</strong>
							{#if worker.notes}<div class="muted">{worker.notes}</div>{/if}
						</div>
						<form method="POST" action="?/archiveWorker" use:enhance onsubmit={(event) => confirmRemove(event, worker)}>
							<input type="hidden" name="id" value={worker.id} />
							<button type="submit" class="button--danger" use:pressable>Remove</button>
						</form>
					</div>
					<div class="person__chips">
						{#if certified.length === 0}
							<span class="badge badge--warn">Not certified on any station</span>
						{:else}
							{#each certified as stationId (stationId)}
								<span class="badge badge--on">
									{stationLabel.get(stationId)}{#if pressIds.has(stationId)}{worker.mainStationIds.includes(stationId) ? ' · Main' : ' · Catch'}{/if}
								</span>
							{/each}
						{/if}
					</div>
					{#if worker.notes}
						<form method="POST" action="?/suggestWorkerRules" use:enhance class="person__suggest">
							<input type="hidden" name="id" value={worker.id} />
							<button type="submit" class="button--secondary" use:pressable>Suggest rules from notes</button>
						</form>
					{/if}
					<details>
						<summary>Edit</summary>
						<form method="POST" action="?/updateWorker" use:enhance={keepValues} class="worker-form">
							<input type="hidden" name="id" value={worker.id} />
							{@render workerFields(worker)}
							<div><button type="submit" use:pressable>Save</button></div>
						</form>
					</details>
				</li>
			{/each}
		</ul>
	{/if}
</section>

{#if archivedWorkers.length > 0}
	<section class="card">
		<div class="card__title"><h2>Removed people</h2></div>
		<ul class="people">
			{#each archivedWorkers as worker (worker.id)}
				<li class="person person__head">
					<span>{worker.name}</span>
					<form method="POST" action="?/restoreWorker" use:enhance>
						<input type="hidden" name="id" value={worker.id} />
						<button type="submit" class="button--secondary" use:pressable>Restore</button>
					</form>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.worker-form {
		display: grid;
		gap: 1rem;
	}

	.fields {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
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
	}

	input:not([type]),
	textarea {
		font: inherit;
		resize: vertical;
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

	fieldset {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.6rem 0.8rem;
		margin: 0;
		display: grid;
		gap: 0.6rem;
	}

	legend {
		font-size: 0.925rem;
		font-weight: 550;
		padding: 0 0.35rem;
	}

	.cert-group {
		display: grid;
		gap: 0.35rem;
	}

	.cert-group__label {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-500);
	}

	.cert {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.checkbox--main {
		font-size: 0.8rem;
		color: var(--ink-500);
	}

	.person__suggest button {
		font-size: 0.85rem;
		padding: 0.25rem 0.6rem;
	}

	.suggestions__list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	.suggestions__list--plain li {
		font-size: 0.9rem;
	}

	.suggestions__list .checkbox {
		align-items: flex-start;
	}

	.suggestions__list .checkbox span {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.suggestions__quote {
		font-style: italic;
		font-size: 0.85rem;
	}

	.suggestions__heading {
		margin: 0.75rem 0 0.4rem;
	}

	.cert-group__options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.1rem;
	}

	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}

	.person {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.75rem 0.9rem;
		display: grid;
		gap: 0.5rem;
	}

	.person__head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
	}

	.person__chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	summary {
		cursor: pointer;
		font-weight: 550;
		font-size: 0.9rem;
		color: var(--brand-500);
	}

	details[open] summary {
		margin-bottom: 0.75rem;
	}
</style>
