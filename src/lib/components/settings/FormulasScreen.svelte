<script lang="ts">
	import { enhance } from '$app/forms';
	import { pressable } from '$lib/actions/pressable.svelte';
	import type { FormulaSettings } from '$lib/server/engine/formulaSettings';

	interface Props {
		formulas: FormulaSettings;
		defaults: FormulaSettings;
		notice: string | null;
		message: string | null;
	}

	let { formulas, defaults, notice, message }: Props = $props();

	// The default constants each field falls back to when the input is left blank on
	// save — shown next to the input as a muted hint so an admin can see where the
	// baseline is before they change it.
	function defaultHint(current: number, def: number): string {
		return current === def ? `default: ${def}` : `default: ${def} · edited`;
	}

	// The weight classes and cap constructions that key the rate tables. Kept in this
	// order everywhere so the form reads left-to-right THIN → POLY → BULKY, matching
	// the client's own spreadsheet.
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
		page, the drafts board, and any new <em>propose_schedule</em> run. Already-
		approved schedule assignments keep the hours they were approved with;
		nothing here retroactively edits history.
	</p>

	<form method="POST" action="?/saveFormulas" use:enhance class="formulas-form">
		<!-- ─── Screen print ─────────────────────────────────────────────────── -->
		<section class="card">
			<div class="card__title"><h3>Screen print (auto)</h3></div>
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
		</section>

		<!-- ─── Embroidery ─────────────────────────────────────────────────────── -->
		<section class="card">
			<div class="card__title"><h3>Embroidery</h3></div>
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
		</section>

		<!-- ─── Finishing ─────────────────────────────────────────────────────── -->
		<section class="card">
			<div class="card__title"><h3>Finishing steps</h3></div>
			<p class="muted">
				Each finishing step is a flat per-garment rate: hours = quantity × (60 ÷
				units per hour) ÷ 60. Matte flat uses a 70-minute numerator (not 60)
				by the client's chart; matte specialty is one minute per garment. Wovens
				is provisional (see CLAUDE.md).
			</p>

			<h4>Printed relabel (units per hour)</h4>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]}</span>
						<input type="number" min="1" step="1" name="fin.relabelUnitsPerHour.{wc}" value={formulas.finishing.relabelUnitsPerHour[wc]} />
						<span class="hint">{defaultHint(formulas.finishing.relabelUnitsPerHour[wc], defaults.finishing.relabelUnitsPerHour[wc])}</span>
					</label>
				{/each}
			</div>

			<h4>Hang tags (units per hour)</h4>
			<div class="grid grid--3">
				{#each WEIGHT_CLASSES as wc (wc)}
					<label>
						<span>{weightLabel[wc]}</span>
						<input type="number" min="1" step="1" name="fin.hangTagUnitsPerHour.{wc}" value={formulas.finishing.hangTagUnitsPerHour[wc]} />
						<span class="hint">{defaultHint(formulas.finishing.hangTagUnitsPerHour[wc], defaults.finishing.hangTagUnitsPerHour[wc])}</span>
					</label>
				{/each}
			</div>

			<h4>Fold &amp; bag (units per hour)</h4>
			<div class="grid grid--3">
				{#each FOLD_BAG_TYPES as ft (ft)}
					<label>
						<span>{foldBagLabel[ft]}</span>
						<input type="number" min="1" step="1" name="fin.foldBagUnitsPerHour.{ft}" value={formulas.finishing.foldBagUnitsPerHour[ft]} />
						<span class="hint">{defaultHint(formulas.finishing.foldBagUnitsPerHour[ft], defaults.finishing.foldBagUnitsPerHour[ft])}</span>
					</label>
				{/each}
			</div>

			<h4>Matte — flat surface</h4>
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

			<h4>Matte — specialty surface</h4>
			<div class="grid grid--3">
				<label>
					<span>Minutes per garment</span>
					<input type="number" min="0" step="0.1" name="fin.matteSpecialtyMinutesPerUnit" value={formulas.finishing.matteSpecialtyMinutesPerUnit} />
					<span class="hint">{defaultHint(formulas.finishing.matteSpecialtyMinutesPerUnit, defaults.finishing.matteSpecialtyMinutesPerUnit)}</span>
				</label>
			</div>

			<h4>Wovens</h4>
			<div class="grid grid--3">
				<label>
					<span>Units per hour</span>
					<input type="number" min="1" step="1" name="fin.wovensUnitsPerHour" value={formulas.finishing.wovensUnitsPerHour} />
					<span class="hint">{defaultHint(formulas.finishing.wovensUnitsPerHour, defaults.finishing.wovensUnitsPerHour)}</span>
				</label>
			</div>
		</section>

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

	h3 {
		margin: 0;
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
</style>
