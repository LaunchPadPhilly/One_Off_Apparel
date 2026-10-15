<script lang="ts">
	import { storageKeyPrefix } from '$lib/appConfig';
	import { isPressKind } from '$lib/schedule/stationKinds';
	import { avatarHue, crewRoleLabel, initials, type CrewRole } from '$lib/schedule/people';

	/**
	 * The draft board's People panel (2026-10-14), on the right of the timeline: every
	 * person on the roster with what they're doing on the chosen day — which station,
	 * and on a press whether they're the main printer or a catch — plus who's free and
	 * who's out. Drag a person onto a station row to pin them there for that day; the
	 * board then re-plans that day's crews (restaffDraftDay.ts). Who goes where is the
	 * deterministic staffing planner's call (planStaffing.ts), never Claude's.
	 */

	type Person = {
		id: string;
		name: string;
		notes: string | null;
		isMain: boolean;
		isOperator: boolean;
		certifications: { stationName: string }[];
	};
	type CrewMember = { id: string; name: string; role: 'MAIN' | 'OPERATOR' | 'CATCH'; isMain: boolean };

	let {
		people,
		peopleOut,
		pins,
		placements,
		stations,
		days,
		isAdmin,
		readOnly = false,
		busy,
		onUnpin,
		onReplan,
		onWorkerDragStart,
		onWorkerDragEnd
	}: {
		people: Person[];
		peopleOut: { date: string; workerId: string; reason: string | null }[];
		pins: { date: string; workerId: string; stationName: string }[];
		placements: { date: string; stationName: string; crew: CrewMember[] }[];
		stations: { name: string; label: string; kind: string }[];
		/** The days the board is showing, in order. */
		days: string[];
		isAdmin: boolean;
		/** A finalized schedule (2026-10-15): shows who's where, no dragging or re-planning. */
		readOnly?: boolean;
		busy: boolean;
		onUnpin: (workerId: string, date: string) => void;
		/** Re-staff every day of the draft with the current roster and rules. */
		onReplan: () => void;
		onWorkerDragStart: (workerId: string) => void;
		onWorkerDragEnd: () => void;
	} = $props();

	const COLLAPSED_KEY = `${storageKeyPrefix}schedulePeopleCollapsed`;
	function loadCollapsed(): boolean {
		if (typeof window === 'undefined') return false;
		try {
			return localStorage.getItem(COLLAPSED_KEY) === 'collapsed';
		} catch {
			return false;
		}
	}
	let collapsed = $state(loadCollapsed());
	function toggle() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(COLLAPSED_KEY, collapsed ? 'collapsed' : 'expanded');
		} catch {
			// localStorage unavailable — the choice just won't persist.
		}
	}

	let chosenDay = $state<string | null>(null);
	// Falls back to the first day shown when the chosen one scrolls out of view (week nav).
	const day = $derived(chosenDay && days.includes(chosenDay) ? chosenDay : (days[0] ?? ''));

	const stationByName = $derived(new Map(stations.map((s) => [s.name, s])));
	const stationOrder = $derived(new Map(stations.map((s, i) => [s.name, i])));
	const labelOf = (name: string) => stationByName.get(name)?.label ?? name;

	type Status =
		| { kind: 'working'; stationName: string; role: CrewRole }
		| { kind: 'pinned'; stationName: string }
		| { kind: 'out'; reason: string | null }
		| { kind: 'free' };

	const rows = $derived.by(() => {
		const working = new Map<string, { stationName: string; role: CrewRole }>();
		for (const p of placements) {
			if (p.date !== day) continue;
			const press = isPressKind(stationByName.get(p.stationName)?.kind);
			for (const member of p.crew) {
				if (working.has(member.id)) continue;
				const role: CrewRole = !press
					? 'crew'
					: member.role === 'MAIN'
						? 'main'
						: member.role === 'OPERATOR'
							? 'operator'
							: 'catch';
				working.set(member.id, { stationName: p.stationName, role });
			}
		}
		const outById = new Map(peopleOut.filter((o) => o.date === day).map((o) => [o.workerId, o.reason]));
		const pinById = new Map(pins.filter((p) => p.date === day).map((p) => [p.workerId, p.stationName]));

		return people
			.map((person) => {
				let status: Status;
				const job = working.get(person.id);
				if (outById.has(person.id)) status = { kind: 'out', reason: outById.get(person.id) ?? null };
				else if (job) status = { kind: 'working', ...job };
				else if (pinById.has(person.id)) status = { kind: 'pinned', stationName: pinById.get(person.id)! };
				else status = { kind: 'free' };
				return { person, status, pinned: pinById.get(person.id) ?? null };
			})
			.sort((a, b) => rank(a.status) - rank(b.status) || stationRank(a.status) - stationRank(b.status) || roleRank(a.status) - roleRank(b.status) || a.person.name.localeCompare(b.person.name));
	});

	function rank(status: Status): number {
		return { working: 0, pinned: 1, free: 2, out: 3 }[status.kind];
	}
	function stationRank(status: Status): number {
		return 'stationName' in status ? (stationOrder.get(status.stationName) ?? 999) : 0;
	}
	function roleRank(status: Status): number {
		return status.kind === 'working' ? { main: 0, operator: 1, catch: 2, crew: 2 }[status.role] : 0;
	}

	const counts = $derived({
		working: rows.filter((r) => r.status.kind === 'working').length,
		free: rows.filter((r) => r.status.kind === 'free' || r.status.kind === 'pinned').length,
		out: rows.filter((r) => r.status.kind === 'out').length
	});

	// With presses on the floor but nobody set as Main or Operator (and certified on a
	// press), the planner can't open any press.
	const noLeads = $derived(
		stations.some((s) => isPressKind(s.kind)) &&
			people.length > 0 &&
			!people.some(
				(p) => (p.isMain || p.isOperator) && p.certifications.some((c) => isPressKind(stationByName.get(c.stationName)?.kind))
			)
	);

	function certSummary(person: Person): string {
		if (person.certifications.length === 0) return 'Not certified on any station yet';
		const pressRole = person.isMain ? 'main' : person.isOperator ? 'operator' : null;
		const stations = person.certifications.map((c) => labelOf(c.stationName)).join(', ');
		return pressRole ? `${stations} — press role: ${pressRole}` : stations;
	}

	function dayLabel(iso: string): string {
		return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
	}

	function handleDragStart(event: DragEvent, workerId: string) {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData('application/x-worker', JSON.stringify({ workerId }));
		event.dataTransfer.effectAllowed = 'move';
		onWorkerDragStart(workerId);
	}
</script>

<aside class="people card" class:people--collapsed={collapsed} aria-label="People">
	{#if collapsed}
		<button type="button" class="people__toggle people__toggle--rail" onclick={toggle} aria-expanded="false" aria-label="Show people" title="Show people">
			<span class="people__arrow" aria-hidden="true">‹</span>
			<span class="people__rail-label">People</span>
			<span class="people__rail-count">{counts.working}/{people.length}</span>
		</button>
	{:else}
		<div class="people__head">
			<h2>People</h2>
			<button type="button" class="people__toggle" onclick={toggle} aria-expanded="true" aria-label="Hide people" title="Hide people">
				<span class="people__arrow" aria-hidden="true">›</span>
			</button>
		</div>

		<label class="people__day">
			<span class="muted">Day</span>
			<select value={day} onchange={(event) => (chosenDay = (event.currentTarget as HTMLSelectElement).value)}>
				{#each days as d (d)}
					<option value={d}>{dayLabel(d)}</option>
				{/each}
			</select>
		</label>

		<div class="people__summary-row">
			<p class="people__summary muted">
				{counts.working} working · {counts.free} free · {counts.out} out
			</p>
			{#if people.length > 0 && !readOnly}
				<button
					type="button"
					class="people__replan"
					disabled={busy}
					onclick={onReplan}
					title="Re-pick every day's crew for this draft's proposed jobs from the current roster, certifications and main/catch rules"
				>{busy ? 'Working…' : 'Re-plan crews'}</button>
			{/if}
		</div>

		{#if noLeads}
			<p class="people__warn" role="status">
				No one is set as a main or operator for the presses, so no press can run.
				{#if isAdmin}<a href="/settings?screen=people">Tick "Main" or "Operator" in Settings → People.</a>{:else}Ask an admin to set it in Settings → People.{/if}
			</p>
		{/if}

		{#if people.length === 0}
			<p class="muted people__empty">
				No one on the roster yet.
				{#if isAdmin}<a href="/settings?screen=people">Add people</a>{/if}
			</p>
		{:else}
			{#if !readOnly}
				<p class="people__hint muted">Drag someone onto a station row to put them there for that day.</p>
			{/if}
			<ul class="people__list" aria-busy={busy}>
				{#each rows as { person, status, pinned } (person.id)}
					{@const out = status.kind === 'out'}
					<li
						class="person"
						class:person--out={out}
						draggable={!out && !busy && !readOnly}
						ondragstart={readOnly ? undefined : (event) => handleDragStart(event, person.id)}
						ondragend={onWorkerDragEnd}
						title={[certSummary(person), person.notes ? `Notes: ${person.notes}` : ''].filter(Boolean).join('\n')}
					>
						<span class="avatar" style="--avatar-hue: {avatarHue(person.id)}" aria-hidden="true">{initials(person.name)}</span>
						<span class="person__body">
							<span class="person__name">{person.name}</span>
							{#if status.kind === 'working'}
								<span class="person__status">
									<span class="role role--{status.role}">{crewRoleLabel(status.role)}</span>
									{labelOf(status.stationName)}
								</span>
							{:else if status.kind === 'pinned'}
								<span class="person__status muted">Put on {labelOf(status.stationName)} · no jobs there</span>
							{:else if status.kind === 'out'}
								<span class="person__status muted">Out{status.reason ? ` — ${status.reason}` : ''}</span>
							{:else}
								<span class="person__status muted">Free</span>
							{/if}
							{#if person.notes}
								<span class="person__notes">{person.notes}</span>
							{/if}
						</span>
						{#if pinned && !out && !readOnly}
							<button
								type="button"
								class="person__pin"
								title="Placed here by hand for {dayLabel(day)}. Click to let the planner decide again."
								disabled={busy}
								onclick={() => onUnpin(person.id, day)}
							>Pinned ×</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</aside>

<style>
	.people {
		padding: var(--space-4);
		position: sticky;
		top: var(--space-4);
		height: calc(100vh - var(--space-6));
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		width: 17rem;
		min-width: 0;
	}

	.people--collapsed {
		width: 2.75rem;
		padding: var(--space-2) 0;
		align-items: center;
	}

	.people__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.people__head h2 {
		margin: 0;
		font-size: var(--fs-lg);
	}

	.people__toggle {
		background: var(--secondary-bg);
		border: 1px solid var(--secondary-border);
		box-shadow: none;
		color: var(--ink-700);
		border-radius: var(--radius-sm);
		padding: 0.15rem 0.5rem;
		font-size: var(--fs-base);
		line-height: 1;
		cursor: pointer;
	}

	.people__toggle:hover {
		background: var(--secondary-hover);
	}

	.people__toggle:focus-visible {
		outline: none;
		box-shadow: var(--focus);
	}

	.people__toggle--rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.25rem;
		height: 100%;
		width: 2.25rem;
		background: none;
		border: none;
	}

	.people__rail-label {
		writing-mode: vertical-rl;
		font-weight: 600;
		font-size: var(--fs-sm);
		color: var(--ink-700);
	}

	.people__rail-count {
		font-size: var(--fs-xs);
		color: var(--ink-500);
	}

	.people__day {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--fs-sm);
	}

	.people__day select {
		flex: 1;
		min-width: 0;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-900);
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
	}

	.people__summary-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.people__replan {
		background: var(--secondary-bg);
		border: 1px solid var(--secondary-border);
		box-shadow: none;
		color: var(--ink-700);
		border-radius: var(--radius-sm);
		padding: 0.2rem 0.55rem;
		font-size: var(--fs-xs);
		cursor: pointer;
		white-space: nowrap;
	}

	.people__replan:hover:not(:disabled) {
		background: var(--secondary-hover);
	}

	.people__summary,
	.people__hint {
		margin: 0;
		font-size: var(--fs-xs);
	}

	.people__warn {
		margin: 0;
		font-size: var(--fs-xs);
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius-sm);
		background: var(--warning-bg);
		color: var(--warning-fg);
	}

	.people__empty {
		margin: 0;
		font-size: var(--fs-sm);
	}

	.people__list {
		list-style: none;
		margin: 0 calc(var(--space-4) * -1) calc(var(--space-4) * -1);
		padding: 0 var(--space-4) var(--space-4);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.person {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		cursor: grab;
	}

	.person:hover {
		border-color: var(--brand-300);
	}

	.person--out {
		opacity: 0.55;
		cursor: default;
	}

	.avatar {
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.02em;
		color: #fff;
		background: hsl(var(--avatar-hue) 55% 42%);
	}

	.person__body {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		flex: 1;
	}

	.person__name {
		font-weight: 600;
		font-size: var(--fs-sm);
		color: var(--ink-900);
	}

	.person__status {
		font-size: var(--fs-xs);
		color: var(--ink-700);
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
	}

	.person__notes {
		font-size: var(--fs-xs);
		color: var(--ink-500);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.role {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--ink-700);
	}

	.role--main {
		background: var(--brand-500);
		border-color: var(--brand-500);
		color: var(--on-accent, #fff);
	}

	.role--operator {
		background: var(--brand-200);
		border-color: var(--brand-300);
	}

	.role--catch {
		background: var(--brand-100);
		border-color: var(--brand-200);
	}

	.person__pin {
		flex-shrink: 0;
		background: none;
		border: 1px solid var(--border);
		box-shadow: none;
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
		font-size: 0.68rem;
		color: var(--ink-500);
		cursor: pointer;
	}

	.person__pin:hover:not(:disabled) {
		color: var(--ink-900);
		border-color: var(--ink-500);
	}

	@media (max-width: 1200px) {
		.people,
		.people--collapsed {
			position: static;
			height: auto;
			max-height: 28rem;
			width: auto;
		}

		.people--collapsed {
			align-items: stretch;
		}

		.people__toggle--rail {
			flex-direction: row;
			width: 100%;
			height: auto;
			justify-content: flex-start;
			padding: 0 var(--space-3);
		}

		.people__rail-label {
			writing-mode: horizontal-tb;
		}
	}
</style>
