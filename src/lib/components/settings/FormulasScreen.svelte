<script lang="ts">
	import { enhance } from '$app/forms';
	import { pressable } from '$lib/actions/pressable.svelte';
	import { stationKindLabel } from '$lib/schedule/stationKinds';
	import type { FormulaSettings } from '$lib/server/engine/formulaSettings';

	interface Props {
		formulas: FormulaSettings;
		defaults: FormulaSettings;
		/** Every active station grouped by its `kind` — lets each section show which
		 *  real stations are covered by that formula, so an admin who creates a new
		 *  auto press in the Stations tab sees it appear here too. */
		stationsByKind: Record<string, { id: string; label: string }[]>;
		notice: string | null;
		message: string | null;
	}

	let { formulas, defaults, stationsByKind, notice, message }: Props = $props();

	function defaultHint(current: number, def: number): string {
		return current === def ? `default: ${def}` : `default: ${def} · edited`;
	}

	function stationsFor(kind: string): { id: string; label: string }[] {
		return stationsByKind[kind] ?? [];
	}

	/** One line summarizing which real stations a formula section covers — appears
	 *  next to the section header so an admin knows the numbers below apply to
	 *  every listed station. */
	function coversLine(kind: string): string {
		const list = stationsFor(kind);
		if (list.length === 0) return 'No active stations use this formula.';
		if (list.length === 1) return `Applies to: ${list[0].label}`;
		return `Applies to: ${list.map((s) => s.label).join(', ')}`;
	}

	// Kinds that have no formula and can't be edited here — see estimateHours.ts.
	// A station with one of these kinds needs hours entered per job on the order
	// page (a MissingLineItemDataError otherwise).
	const NO_FORMULA_KINDS = ['dtf', 'dtg', 'other'] as const;
	const unmodeledStations = $derived.by(() => {
		const rows: { kind: string; stations: { id: string; label: string }[] }[] = [];
		for (const kind of NO_FORMULA_KINDS) {
			const stations = stationsFor(kind);
			if (stations.length > 0) rows.push({ kind, stations });
		}
		return rows;
	});

	const WEIGHT_CLASSES = ['THIN', 'POLY', 'BULKY'] as const;
	const CAP_TYPES = ['STRUCTURED', 'UNSTRUCTURED'] as const;
	const FOLD_BAG_TYPES = ['SS_TEE', 'OTHER'] as const;

	const weightLabel = { THIN: 'Thin', POLY: 'Poly', BULKY: 'Bulky' } as const;
	const capLabel = { STRUCTURED: 'Structured', UNSTRUCTURED: 'Unstructured' } as const;
	const foldBagLabel = { SS_TEE: 'SS tee', OTHER: 'Other' } as const;
</script>

<div class="formulas">
	{#if notice}
		<div class="notice notice--success">{notice}</div>
	{/if}
	{#if message}
		<div class="notice notice--error">{message}</div>
	{/if}

	<p class="muted intro">
		Editable rates and factors behind every station's <code>estimate_hours</code>
		formula. Changing a number here updates every future estimate — the Orders
		page, the drafts board, and any new <em>propose_schedule</em> run.
		Already-approved schedule assignments keep the hours they were approved
		with; nothing here retroactively edits history. Sections are collapsible —
		click the header to expand or collapse.
	</p>

	{#if unmodeledStations.length > 0}
		<!-- Stations whose kind (DTF, DTG, "other") has no editable formula. Surfaced at
		     the top so an admin who just added one sees the message before scrolling
		     through the editable sections below. -->
		<section class="card unmodeled">
			<div class="card__title"><h3>Stations without an editable formula</h3></div>
			<p>
				These stations run job types the system doesn't model with a rate
				table — every job's time is entered <strong>per line item on the
				order page</strong>, not tuned here. If you want a formula for one of
				these, tell an engineer so it can be added to
				<code>estimateHours.ts</code>.
			</p>
			<ul class="unmodeled__list">
				{#each unmodeledStations as row (row.kind)}
					<li>
						<strong>{stationKindLabel(row.kind)}</strong> —
						{row.stations.map((s) => s.label).join(', ')}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<form method="POST" action="?/saveFormulas" use:enhance class="formulas-form">
		<!-- ─── Screen print ─────────────────────────────────────────────────── -->
		<details class="card" open>
			<summary class="section-summary">
				<h3>Screen print (auto)</h3>
				<span class="covers">{coversLine('screen_print_auto')}</span>
			</summary>
			<p class="muted">
				Setup + run time. Setup grows with the number of screens and ink colors
				plus a fixed baseline; run time only applies to garments past the
				weight-class's "initial units" free batch, at that weight-class's
				garments-per-hour rate (two rate tables, one for &lt; 5 screens, one for
				5+ screens).
			</p>

			<h4>Initial units (garments included before run time starts)</h4>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]}</span>
						<input type="number" min="0" step="1" name="sp.initialUnits.{wc}" value={formulas.screenPrint.initialUnits[wc]} />
						<span class="hint">{defaultHint(formulas.screenPrint.initialUnits[wc], defaults.screenPrint.initialUnits[wc])}</span>
					</label>
				{/each}
			</div>

			<h4>Rate per hour — fewer than 5 screens</h4>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]}</span>
						<input type="number" min="1" step="1" name="sp.ratePerHour.LT_5.{wc}" value={formulas.screenPrint.ratePerHour.SCREENS_LT_5[wc]} />
						<span class="hint">{defaultHint(formulas.screenPrint.ratePerHour.SCREENS_LT_5[wc], defaults.screenPrint.ratePerHour.SCREENS_LT_5[wc])}</span>
					</label>
				{/each}
			</div>

			<h4>Rate per hour — 5 or more screens</h4>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]}</span>
						<input type="number" min="1" step="1" name="sp.ratePerHour.GT_4.{wc}" value={formulas.screenPrint.ratePerHour.SCREENS_GT_4[wc]} />
						<span class="hint">{defaultHint(formulas.screenPrint.ratePerHour.SCREENS_GT_4[wc], defaults.screenPrint.ratePerHour.SCREENS_GT_4[wc])}</span>
					</label>
				{/each}
			</div>

			<h4>Setup time</h4>
			<div class="grid grid--3">
				<label>
					<span>Minutes per screen</span>
					<input type="number" min="0" step="0.5" name="sp.setupMinutesPerScreen" value={formulas.screenPrint.setupMinutesPerScreen} />
					<span class="hint">{defaultHint(formulas.screenPrint.setupMinutesPerScreen, defaults.screenPrint.setupMinutesPerScreen)}</span>
				</label>
				<label>
					<span>Minutes per ink color</span>
					<input type="number" min="0" step="0.5" name="sp.setupMinutesPerInkColor" value={formulas.screenPrint.setupMinutesPerInkColor} />
					<span class="hint">{defaultHint(formulas.screenPrint.setupMinutesPerInkColor, defaults.screenPrint.setupMinutesPerInkColor)}</span>
				</label>
				<label>
					<span>Fixed setup (minutes)</span>
					<input type="number" min="0" step="1" name="sp.setupFixedMinutes" value={formulas.screenPrint.setupFixedMinutes} />
					<span class="hint">{defaultHint(formulas.screenPrint.setupFixedMinutes, defaults.screenPrint.setupFixedMinutes)}</span>
				</label>
			</div>
		</details>

		<!-- ─── Embroidery ─────────────────────────────────────────────────────── -->
		<details class="card" open>
			<summary class="section-summary">
				<h3>Embroidery</h3>
				<span class="covers">{coversLine('embroidery')}</span>
			</summary>
			<p class="muted">
				Six-step formula per job. Higher rate divisors = faster; a job with
				stitch count X uses (quantity ÷ 6) × (X ÷ sew rate divisor) minutes of
				sew time. Flat and cap have completely different rate plans — caps
				aren't a "weight class variant."
			</p>

			<h4>Thread change</h4>
			<div class="grid grid--3">
				<label>
					<span>Minutes per thread color</span>
					<input type="number" min="0" step="0.5" name="emb.threadChangeMinPerColor" value={formulas.embroidery.threadChangeMinPerColor} />
					<span class="hint">{defaultHint(formulas.embroidery.threadChangeMinPerColor, defaults.embroidery.threadChangeMinPerColor)}</span>
				</label>
			</div>

			{#each WEIGHT_CLASSES as wc (wc)}
				<h4>Flat garment — {weightLabel[wc]}</h4>
				<div class="grid grid--5">
					<label>
						<span>Setup / boxing divisor</span>
						<input type="number" min="1" step="1" name="emb.flat.{wc}.setupBoxingDivisor" value={formulas.embroidery.flat[wc].setupBoxingDivisor} />
						<span class="hint">{defaultHint(formulas.embroidery.flat[wc].setupBoxingDivisor, defaults.embroidery.flat[wc].setupBoxingDivisor)}</span>
					</label>
					<label>
						<span>Hooping factor</span>
						<input type="number" min="0" step="0.1" name="emb.flat.{wc}.hoopingFactor" value={formulas.embroidery.flat[wc].hoopingFactor} />
						<span class="hint">{defaultHint(formulas.embroidery.flat[wc].hoopingFactor, defaults.embroidery.flat[wc].hoopingFactor)}</span>
					</label>
					<label>
						<span>Load / unload factor</span>
						<input type="number" min="0" step="0.1" name="emb.flat.{wc}.loadUnloadFactor" value={formulas.embroidery.flat[wc].loadUnloadFactor} />
						<span class="hint">{defaultHint(formulas.embroidery.flat[wc].loadUnloadFactor, defaults.embroidery.flat[wc].loadUnloadFactor)}</span>
					</label>
					<label>
						<span>Cleanup factor</span>
						<input type="number" min="0" step="0.1" name="emb.flat.{wc}.cleanupFactor" value={formulas.embroidery.flat[wc].cleanupFactor} />
						<span class="hint">{defaultHint(formulas.embroidery.flat[wc].cleanupFactor, defaults.embroidery.flat[wc].cleanupFactor)}</span>
					</label>
					<label>
						<span>Sew rate divisor</span>
						<input type="number" min="1" step="1" name="emb.flat.{wc}.sewRateDivisor" value={formulas.embroidery.flat[wc].sewRateDivisor} />
						<span class="hint">{defaultHint(formulas.embroidery.flat[wc].sewRateDivisor, defaults.embroidery.flat[wc].sewRateDivisor)}</span>
					</label>
				</div>
			{/each}

			{#each CAP_TYPES as ct (ct)}
				<h4>Cap — {capLabel[ct]}</h4>
				<div class="grid grid--5">
					<label>
						<span>Setup / boxing divisor</span>
						<input type="number" min="1" step="1" name="emb.cap.{ct}.setupBoxingDivisor" value={formulas.embroidery.cap[ct].setupBoxingDivisor} />
						<span class="hint">{defaultHint(formulas.embroidery.cap[ct].setupBoxingDivisor, defaults.embroidery.cap[ct].setupBoxingDivisor)}</span>
					</label>
					<label>
						<span>Hooping factor</span>
						<input type="number" min="0" step="0.1" name="emb.cap.{ct}.hoopingFactor" value={formulas.embroidery.cap[ct].hoopingFactor} />
						<span class="hint">{defaultHint(formulas.embroidery.cap[ct].hoopingFactor, defaults.embroidery.cap[ct].hoopingFactor)}</span>
					</label>
					<label>
						<span>Load / unload factor</span>
						<input type="number" min="0" step="0.1" name="emb.cap.{ct}.loadUnloadFactor" value={formulas.embroidery.cap[ct].loadUnloadFactor} />
						<span class="hint">{defaultHint(formulas.embroidery.cap[ct].loadUnloadFactor, defaults.embroidery.cap[ct].loadUnloadFactor)}</span>
					</label>
					<label>
						<span>Cleanup factor</span>
						<input type="number" min="0" step="0.1" name="emb.cap.{ct}.cleanupFactor" value={formulas.embroidery.cap[ct].cleanupFactor} />
						<span class="hint">{defaultHint(formulas.embroidery.cap[ct].cleanupFactor, defaults.embroidery.cap[ct].cleanupFactor)}</span>
					</label>
					<label>
						<span>Sew rate divisor</span>
						<input type="number" min="1" step="1" name="emb.cap.{ct}.sewRateDivisor" value={formulas.embroidery.cap[ct].sewRateDivisor} />
						<span class="hint">{defaultHint(formulas.embroidery.cap[ct].sewRateDivisor, defaults.embroidery.cap[ct].sewRateDivisor)}</span>
					</label>
				</div>
			{/each}
		</details>

		<!-- ─── Finishing steps (each collapsible on its own) ────────────────── -->
		<details class="card" open>
			<summary class="section-summary">
				<h3>Printed relabel</h3>
				<span class="covers">{coversLine('printed_relabel')}</span>
			</summary>
			<p class="muted">Flat per-garment rate; keyed by weight class.</p>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]} (units / hr)</span>
						<input type="number" min="1" step="1" name="fin.relabelUnitsPerHour.{wc}" value={formulas.finishing.relabelUnitsPerHour[wc]} />
						<span class="hint">{defaultHint(formulas.finishing.relabelUnitsPerHour[wc], defaults.finishing.relabelUnitsPerHour[wc])}</span>
					</label>
				{/each}
			</div>
		</details>

		<details class="card" open>
			<summary class="section-summary">
				<h3>Hang tags</h3>
				<span class="covers">{coversLine('hang_tags')}</span>
			</summary>
			<p class="muted">Flat per-garment rate; keyed by weight class.</p>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]} (units / hr)</span>
						<input type="number" min="1" step="1" name="fin.hangTagUnitsPerHour.{wc}" value={formulas.finishing.hangTagUnitsPerHour[wc]} />
						<span class="hint">{defaultHint(formulas.finishing.hangTagUnitsPerHour[wc], defaults.finishing.hangTagUnitsPerHour[wc])}</span>
					</label>
				{/each}
			</div>
		</details>

		<details class="card" open>
			<summary class="section-summary">
				<h3>Fold &amp; bag</h3>
				<span class="covers">{coversLine('fold_bag')}</span>
			</summary>
			<p class="muted">Flat per-garment rate; keyed on garment type (short-sleeve tee vs anything else), not weight class.</p>
			<div class="grid grid--3">
				{#each FOLD_BAG_TYPES as ft (ft)}
					<label>
						<span>{foldBagLabel[ft]} (units / hr)</span>
						<input type="number" min="1" step="1" name="fin.foldBagUnitsPerHour.{ft}" value={formulas.finishing.foldBagUnitsPerHour[ft]} />
						<span class="hint">{defaultHint(formulas.finishing.foldBagUnitsPerHour[ft], defaults.finishing.foldBagUnitsPerHour[ft])}</span>
					</label>
				{/each}
			</div>
		</details>

		<details class="card" open>
			<summary class="section-summary">
				<h3>Matte finish</h3>
				<span class="covers">{coversLine('matte_finish')}</span>
			</summary>
			<p class="muted">
				Two formulas by surface. Flat uses hours = quantity × (numerator ÷
				rate) ÷ 60 with the numerator at 70 by the client's chart (not the
				usual 60). Specialty is a flat minutes-per-garment number.
			</p>

			<h4>Flat surface</h4>
			<div class="grid grid--3">
				<label>
					<span>Minutes numerator</span>
					<input type="number" min="1" step="1" name="fin.matteFlatMinutesNumerator" value={formulas.finishing.matteFlatMinutesNumerator} />
					<span class="hint">{defaultHint(formulas.finishing.matteFlatMinutesNumerator, defaults.finishing.matteFlatMinutesNumerator)}</span>
				</label>
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]} rate</span>
						<input type="number" min="1" step="1" name="fin.matteFlatRate.{wc}" value={formulas.finishing.matteFlatRate[wc]} />
						<span class="hint">{defaultHint(formulas.finishing.matteFlatRate[wc], defaults.finishing.matteFlatRate[wc])}</span>
					</label>
				{/each}
			</div>

			<h4>Specialty surface</h4>
			<div class="grid grid--3">
				<label>
					<span>Minutes per garment</span>
					<input type="number" min="0" step="0.1" name="fin.matteSpecialtyMinutesPerUnit" value={formulas.finishing.matteSpecialtyMinutesPerUnit} />
					<span class="hint">{defaultHint(formulas.finishing.matteSpecialtyMinutesPerUnit, defaults.finishing.matteSpecialtyMinutesPerUnit)}</span>
				</label>
			</div>
		</details>

		<details class="card" open>
			<summary class="section-summary">
				<h3>Wovens</h3>
				<span class="covers">{coversLine('wovens')}</span>
			</summary>
			<p class="muted">
				Sewing in woven labels. Provisional formula — the client's original
				chart wasn't finalized (see CLAUDE.md).
			</p>
			<div class="grid grid--3">
				<label>
					<span>Units per hour</span>
					<input type="number" min="1" step="1" name="fin.wovensUnitsPerHour" value={formulas.finishing.wovensUnitsPerHour} />
					<span class="hint">{defaultHint(formulas.finishing.wovensUnitsPerHour, defaults.finishing.wovensUnitsPerHour)}</span>
				</label>
			</div>
		</details>

		<div class="save-row">
			<button class="button" use:pressable type="submit">Save formulas</button>
			<p class="muted small">
				DTF, DTG, and unmodeled "Other" jobs have no formula — their hours are
				entered per line item on the order page, not tuned here.
			</p>
		</div>
	</form>
</div>

<style>
	.formulas {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.intro {
		margin: 0 0 0.5rem;
	}

	.formulas-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	/* details as cards. `list-style: none` on summary hides the default disclosure
	   triangle so we can render our own aligned to the section title. */
	details.card {
		padding: 0;
	}

	details.card > .section-summary {
		list-style: none;
		cursor: pointer;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding: 1rem 1.15rem;
		border-radius: var(--radius, 6px) var(--radius, 6px) 0 0;
		user-select: none;
	}

	details.card > .section-summary::-webkit-details-marker {
		display: none;
	}

	details.card > .section-summary::before {
		content: '▸';
		display: inline-block;
		width: 1em;
		font-size: 0.85em;
		color: var(--ink-500);
		transition: transform 120ms ease;
	}

	details.card[open] > .section-summary::before {
		transform: rotate(90deg);
	}

	details.card > .section-summary h3 {
		margin: 0;
		flex: 0 1 auto;
	}

	.covers {
		font-size: 0.85rem;
		color: var(--ink-500);
		font-weight: 400;
	}

	details.card > *:not(.section-summary) {
		padding-left: 1.15rem;
		padding-right: 1.15rem;
	}

	details.card > *:last-child {
		padding-bottom: 1rem;
	}

	details.card > .muted {
		margin-top: 0;
	}

	h4 {
		margin: 1rem 0 0.5rem;
		font-size: 0.95rem;
		color: var(--ink-700, var(--ink-900));
	}

	.grid {
		display: grid;
		gap: 0.75rem;
	}

	.grid--3 {
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	}

	.grid--5 {
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.85rem;
		color: var(--ink-500);
	}

	label span:first-of-type {
		font-weight: 600;
		color: var(--ink-900);
	}

	.hint {
		font-size: 0.72rem;
		color: var(--ink-500);
	}

	.save-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		margin-top: 0.5rem;
	}

	.small {
		font-size: 0.85rem;
	}

	.notice {
		padding: 0.6rem 0.75rem;
		border-radius: var(--radius-sm);
		font-size: 0.9rem;
	}

	.notice--success {
		background: var(--success-bg, #e6f6ec);
		border-left: 3px solid var(--success-fg, #1b7f3b);
	}

	.notice--error {
		background: var(--danger-bg, #fbeaea);
		border-left: 3px solid var(--danger-fg, #b3261e);
	}

	.unmodeled {
		border-left: 3px solid var(--warning-fg, #b56a00);
		background: var(--warning-bg, #fff8e6);
	}

	.unmodeled__list {
		margin: 0.4rem 0 0;
		padding-left: 1.1rem;
	}
</style>
