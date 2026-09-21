<script lang="ts">
	import { enhance } from '$app/forms';
	import { fly, fade } from 'svelte/transition';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	// Default start date: next Monday from today (UTC-anchored so SSR/client match).
	function nextMondayIso(): string {
		const now = new Date();
		const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
		const day = utc.getUTCDay(); // 0 Sun … 6 Sat
		const daysUntilMon = ((8 - day) % 7) || 7;
		utc.setUTCDate(utc.getUTCDate() + daysUntilMon);
		return utc.toISOString().slice(0, 10);
	}

	let name = $state<string>('');
	let description = $state<string>('');
	let startDate = $state<string>(nextMondayIso());
	let weeks = $state<number>(2);
	let strategy = $state<string>('BATCH_OPTIMIZE');
	let submitting = $state(false);

	type Cell = {
		iso: string;
		day: number;
		inRange: boolean;
		isWeekend: boolean;
		isStart: boolean;
		isEnd: boolean;
		isNewMonth: boolean;
	};

	function parseIso(iso: string): Date | null {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
		const d = new Date(`${iso}T00:00:00Z`);
		return Number.isNaN(d.getTime()) ? null : d;
	}

	function addDays(d: Date, n: number): Date {
		const r = new Date(d);
		r.setUTCDate(r.getUTCDate() + n);
		return r;
	}

	function isoOf(d: Date): string {
		return d.toISOString().slice(0, 10);
	}

	const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	const rangeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const weekdayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

	const grid = $derived.by(() => {
		const start = parseIso(startDate);
		if (!start || !Number.isInteger(weeks) || weeks < 1 || weeks > 4) {
			return { rows: [] as Cell[][], monthLabel: '', rangeLabel: '', endDate: null as Date | null };
		}

		// Anchor the grid to the Monday of the start date's week so weekday columns line up.
		const startDay = start.getUTCDay();
		const offsetToMonday = (startDay + 6) % 7; // Mon->0, Tue->1, … Sun->6
		const gridStart = addDays(start, -offsetToMonday);

		const end = addDays(start, weeks * 7 - 1);
		const endIso = isoOf(end);
		const startIso = isoOf(start);

		const rows: Cell[][] = [];
		let previousMonth = gridStart.getUTCMonth();
		for (let w = 0; w < weeks; w++) {
			const row: Cell[] = [];
			for (let d = 0; d < 7; d++) {
				const cellDate = addDays(gridStart, w * 7 + d);
				const iso = isoOf(cellDate);
				const dow = cellDate.getUTCDay();
				const month = cellDate.getUTCMonth();
				const isNewMonth = month !== previousMonth;
				previousMonth = month;
				row.push({
					iso,
					day: cellDate.getUTCDate(),
					inRange: iso >= startIso && iso <= endIso,
					isWeekend: dow === 0 || dow === 6,
					isStart: iso === startIso,
					isEnd: iso === endIso,
					isNewMonth
				});
			}
			rows.push(row);
		}

		return {
			rows,
			monthLabel: monthFmt.format(start),
			rangeLabel: `${rangeFmt.format(start)} – ${rangeFmt.format(end)}`,
			endDate: end
		};
	});

	const totalDays = $derived(weeks * 7);
	const businessDays = $derived(weeks * 5);
</script>

<svelte:head>
	<title>New schedule — {appConfig.displayName}</title>
</svelte:head>

<div class="page page--wide" in:fly={screenEnter} out:fade={screenExit}>
	<a class="back-link" href="/schedule">← Back to schedule</a>
	<span class="eyebrow">Schedule</span>
	<h1>Create a schedule draft</h1>
	<p class="muted">
		Configure a production window. You can hold multiple drafts side-by-side — nothing
		here commits to the live schedule.
	</p>

	{#if form?.message}
		<div class="alert alert--error">{form.message}</div>
	{/if}

	<div class="layout">
		<form
			method="POST"
			action="?/create"
			class="card form"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<div class="field">
				<label for="name">Schedule name</label>
				<input
					id="name"
					name="name"
					type="text"
					required
					maxlength="120"
					placeholder="Week of Oct 5 — rush push"
					bind:value={name}
				/>
				<span class="hint">How you'll identify this draft in the list.</span>
			</div>

			<div class="field">
				<label for="startDate">Start date</label>
				<input id="startDate" name="startDate" type="date" required bind:value={startDate} />
				<span class="hint">Day one of the schedule window.</span>
			</div>

			<div class="field">
				<span class="label">Number of weeks</span>
				<div class="chip-row" role="radiogroup" aria-label="Number of weeks">
					{#each [1, 2, 3, 4] as option (option)}
						<label class="chip" class:chip--active={weeks === option}>
							<input
								type="radio"
								name="weeks"
								value={option}
								checked={weeks === option}
								onchange={() => (weeks = option)}
							/>
							<span class="chip__num">{option}</span>
							<span class="chip__label">{option === 1 ? 'week' : 'weeks'}</span>
						</label>
					{/each}
				</div>
				<span class="hint">1–4 weeks. The calendar on the right updates live.</span>
			</div>

			<div class="field">
				<label for="strategy">Scheduling strategy</label>
				<select id="strategy" name="strategy" bind:value={strategy}>
					<option value="BATCH_OPTIMIZE">Batch-optimize (ATCS)</option>
					<option value="STRICT_DUE_DATE">Strict due-date order</option>
				</select>
				<span class="hint">
					Batch-optimize groups jobs sharing setup (same ink/screens); strict order runs
					earliest-due first.
				</span>
			</div>

			<div class="field">
				<label for="description">Notes <span class="optional">(optional)</span></label>
				<textarea
					id="description"
					name="description"
					rows="3"
					maxlength="1000"
					placeholder="Anything worth remembering when you come back to this draft."
					bind:value={description}
				></textarea>
			</div>

			<div class="actions">
				<button class="button" use:pressable type="submit" disabled={submitting}>
					{submitting ? 'Creating…' : 'Create draft'}
				</button>
				<a class="button button--secondary" href="/schedule">Cancel</a>
			</div>
		</form>

		<aside class="preview">
			<div class="preview__header">
				<span class="eyebrow">Preview</span>
				<h2 class="preview__month">{grid.monthLabel || '—'}</h2>
				<p class="preview__range muted">
					{#if grid.rangeLabel}
						{grid.rangeLabel} · {totalDays} days ({businessDays} weekdays)
					{:else}
						Pick a valid start date to see the window.
					{/if}
				</p>
			</div>

			{#if grid.rows.length > 0}
				<div class="calendar" aria-label="Schedule window preview">
					<div class="calendar__row calendar__row--head">
						{#each weekdayHeaders as label (label)}
							<div class="calendar__head">{label}</div>
						{/each}
					</div>
					{#each grid.rows as row, w (w)}
						<div class="calendar__row">
							{#each row as cell (cell.iso)}
								<div
									class="calendar__cell"
									class:calendar__cell--in={cell.inRange}
									class:calendar__cell--out={!cell.inRange}
									class:calendar__cell--weekend={cell.isWeekend}
									class:calendar__cell--start={cell.isStart}
									class:calendar__cell--end={cell.isEnd}
									title={cell.iso}
								>
									<span class="calendar__day">{cell.day}</span>
									{#if cell.isStart}
										<span class="calendar__marker">Start</span>
									{:else if cell.isEnd}
										<span class="calendar__marker">End</span>
									{/if}
								</div>
							{/each}
						</div>
					{/each}
				</div>

				<ul class="legend">
					<li><span class="legend__swatch legend__swatch--in"></span>In schedule</li>
					<li><span class="legend__swatch legend__swatch--weekend"></span>Weekend</li>
					<li><span class="legend__swatch legend__swatch--out"></span>Outside window</li>
				</ul>
			{/if}
		</aside>
	</div>
</div>

<style>
	.back-link {
		display: inline-block;
		margin-bottom: 0.75rem;
		color: var(--ink-500);
		font-size: 0.9rem;
		text-decoration: none;
	}

	.back-link:hover {
		color: var(--warm-700);
	}

	.layout {
		display: grid;
		gap: 1.5rem;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: start;
	}

	@media (max-width: 900px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 1.2rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.field label,
	.field .label {
		font-weight: 600;
		color: var(--ink-900);
		font-size: 0.95rem;
	}

	.field input[type='text'],
	.field input[type='date'],
	.field textarea,
	.field select {
		font: inherit;
		padding: 0.55rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--ink-900);
		width: 100%;
	}

	.field input:focus-visible,
	.field textarea:focus-visible,
	.field select:focus-visible {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-600);
	}

	.field textarea {
		resize: vertical;
		min-height: 4rem;
	}

	.hint {
		color: var(--ink-500);
		font-size: 0.8rem;
	}

	.optional {
		color: var(--ink-500);
		font-weight: 400;
		font-size: 0.85rem;
	}

	.chip-row {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.chip {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3rem;
		padding: 0.55rem 0.9rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--ink-700);
		cursor: pointer;
		transition: background-color var(--motion-fast) var(--ease-standard),
			border-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);
		user-select: none;
	}

	.chip input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.chip:hover {
		border-color: var(--warm-300);
		color: var(--ink-900);
	}

	.chip--active {
		background: var(--warm-600);
		border-color: var(--warm-600);
		color: #fff;
	}

	.chip__num {
		font-weight: 700;
		font-size: 1.05rem;
	}

	.chip__label {
		font-size: 0.85rem;
		opacity: 0.85;
	}

	.preview {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 1.25rem 1.25rem 1.5rem;
		position: sticky;
		top: 1rem;
	}

	.preview__month {
		margin: 0.15rem 0 0.3rem;
		font-size: 1.15rem;
	}

	.preview__range {
		margin: 0 0 1rem;
		font-size: 0.9rem;
	}

	.calendar {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.calendar__row {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 0.35rem;
	}

	.calendar__head {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-500);
		text-align: center;
		font-weight: 650;
		padding: 0.25rem 0;
	}

	.calendar__cell {
		aspect-ratio: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.15rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		font-size: 0.9rem;
		font-weight: 550;
		color: var(--ink-700);
		background: transparent;
		position: relative;
		transition: background-color var(--motion-fast) var(--ease-standard),
			border-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);
	}

	.calendar__cell--in {
		background: var(--warm-100);
		border-color: var(--warm-300);
		color: var(--ink-900);
	}

	.calendar__cell--in.calendar__cell--weekend {
		background: color-mix(in srgb, var(--warm-100) 55%, transparent);
		color: var(--ink-500);
	}

	.calendar__cell--out {
		background: transparent;
		border-color: color-mix(in srgb, var(--border) 60%, transparent);
		color: color-mix(in srgb, var(--ink-500) 65%, transparent);
	}

	.calendar__cell--start {
		background: var(--warm-600);
		border-color: var(--warm-700);
		color: #fff;
		box-shadow: var(--focus);
	}

	.calendar__cell--end {
		background: var(--warm-300);
		border-color: var(--warm-500);
		color: var(--ink-900);
	}

	.calendar__day {
		font-size: 1rem;
		line-height: 1;
	}

	.calendar__marker {
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 700;
		opacity: 0.9;
	}

	.legend {
		list-style: none;
		padding: 0;
		margin: 1rem 0 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		font-size: 0.78rem;
		color: var(--ink-500);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.legend__swatch {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 3px;
		border: 1px solid var(--border);
	}

	.legend__swatch--in {
		background: var(--warm-100);
		border-color: var(--warm-300);
	}

	.legend__swatch--weekend {
		background: color-mix(in srgb, var(--warm-100) 55%, transparent);
	}

	.legend__swatch--out {
		background: transparent;
	}
</style>
