<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig } from '$lib/appConfig';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let search = $state('');
	// activeStation reads `data.stationNames[0]` inside a getter so it re-evaluates
	// if the loaded stations change (e.g. after a server-only nav); a plain
	// $state(data...) initializer would freeze on the first render's value.
	let activeStationOverride = $state<string | null>(null);
	let activeStation = $derived(activeStationOverride ?? data.stationNames[0] ?? 'screen_print_auto');
	function selectStation(name: string) {
		activeStationOverride = name;
	}

	function strategyLabel(value: string): string {
		if (value === 'BATCH_OPTIMIZE') return 'Batch-optimize (ATCS)';
		if (value === 'STRICT_DUE_DATE') return 'Strict due-date order';
		return value;
	}

	function stationLabel(name: string): string {
		return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function formatDayLabel(iso: string): { weekday: string; date: string } {
		const d = new Date(`${iso}T00:00:00Z`);
		return {
			weekday: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }),
			date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
		};
	}

	function isWeekend(iso: string): boolean {
		const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
		return day === 0 || day === 6;
	}

	function estimateHours(est: unknown): number | null {
		if (!est || typeof est !== 'object') return null;
		const obj = est as Record<string, unknown>;
		if ('hours' in obj && typeof obj.hours === 'number') return obj.hours;
		return null;
	}

	function estimateStation(est: unknown): string | null {
		if (!est || typeof est !== 'object') return null;
		const obj = est as Record<string, unknown>;
		if ('station' in obj && typeof obj.station === 'string') return obj.station;
		return null;
	}

	function estimateError(est: unknown): string | null {
		if (!est || typeof est !== 'object') return null;
		const obj = est as Record<string, unknown>;
		if ('error' in obj && typeof obj.error === 'string') {
			return String(obj.error).split(':')[0];
		}
		return null;
	}

	function formatHours(hours: number): string {
		if (hours < 1) return `${Math.round(hours * 60)}m`;
		return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
	}

	function stepChip(item: { itemType: string; decorationType: string | null; finishingStep: string | null; printLocation: string | null }): string {
		if (item.itemType === 'FINISHING') return stationLabel(item.finishingStep ?? 'finishing');
		const deco = item.decorationType ? stationLabel(item.decorationType) : 'Decoration';
		const loc = item.printLocation ? stationLabel(item.printLocation) : '';
		return loc ? `${deco} · ${loc}` : deco;
	}

	let filteredOrders = $derived(
		data.orders.filter((order) => {
			if (!search) return true;
			const q = search.toLowerCase();
			return (
				order.customerName.toLowerCase().includes(q) ||
				order.hoopsOrderId.toLowerCase().includes(q) ||
				order.lineItems.some((item) => item.design.toLowerCase().includes(q))
			);
		})
	);

	function orderTotalHours(order: (typeof data.orders)[number]): number {
		return order.lineItems.reduce((sum, item) => sum + (estimateHours(item.estimatedHours) ?? 0), 0);
	}

	function stationHoursForDay(day: (typeof data.capacity)[number]): number {
		return day.stations.find((s) => s.name === activeStation)?.availableHrs ?? 0;
	}

	// Tick marks span the largest capacity across the window so every day's bar shares
	// a scale. Falls back to the default day length so an empty capacity_calendar still
	// draws a sensible ruler.
	let maxHours = $derived(
		Math.max(
			data.defaultStationDayHours,
			...data.capacity.map((day) => stationHoursForDay(day))
		)
	);

	let ticks = $derived(Array.from({ length: Math.ceil(maxHours) + 1 }, (_, i) => i));

	function handleDragStart(event: DragEvent, lineItemId: string, hours: number | null) {
		if (!event.dataTransfer) return;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData(
			'application/x-line-item',
			JSON.stringify({ lineItemId, hours: hours ?? 0 })
		);
	}
</script>

<svelte:head>
	<title>{data.draft.name} — {appConfig.displayName}</title>
</svelte:head>

<div class="page-wide" in:fly={screenEnter} out:fade={screenExit}>
	<a class="back-link" href="/schedule">← Back to schedule</a>
	<div class="header-row">
		<div>
			<span class="eyebrow">Schedule draft</span>
			<h1>{data.draft.name}</h1>
			<p class="muted meta">
				{data.draft.startDate} → {data.draft.endDate} ·
				{data.draft.weeks} {data.draft.weeks === 1 ? 'week' : 'weeks'} ·
				{strategyLabel(data.draft.strategy)}
			</p>
		</div>
		<span class="badge">{data.draft.status}</span>
	</div>

	<div class="workspace">
		<!-- Left: orders side tray -->
		<aside class="tray card" aria-label="Orders backlog">
			<div class="tray__head">
				<h2>Orders</h2>
				<span class="muted">{filteredOrders.length} of {data.orders.length}</span>
			</div>
			<input
				class="tray__search"
				type="search"
				bind:value={search}
				placeholder="Search customer, job, design…"
				aria-label="Filter orders"
			/>
			<div class="tray__list" role="list">
				{#each filteredOrders as order (order.id)}
					<article class="order" role="listitem">
						<header class="order__head">
							<div class="order__title">
								<span class="order__customer">{order.customerName || order.hoopsOrderId}</span>
								<span class="muted order__job">#{order.hoopsOrderId}</span>
							</div>
							<div class="order__meta">
								<span class="muted">Due {order.internalDueDate}</span>
								<span class="hours-total">{formatHours(orderTotalHours(order))}</span>
							</div>
						</header>
						<ul class="line-items">
							{#each order.lineItems as item (item.id)}
								{@const hours = estimateHours(item.estimatedHours)}
								{@const err = estimateError(item.estimatedHours)}
								{@const stationName = estimateStation(item.estimatedHours)}
								<li
									class="line-item"
									class:line-item--error={err}
									draggable="true"
									ondragstart={(event) => handleDragStart(event, item.id, hours)}
								>
									<div class="line-item__row">
										<span class="line-item__design">{item.design || '(no design)'}</span>
										{#if hours != null}
											<span class="line-item__hours">{formatHours(hours)}</span>
										{:else if err}
											<span class="line-item__hours line-item__hours--muted" title={err}>—</span>
										{/if}
									</div>
									<div class="line-item__chips">
										<span class="chip">{stepChip(item)}</span>
										{#if item.quantity}
											<span class="chip chip--muted">×{item.quantity}</span>
										{/if}
										{#if item.apparelColor}
											<span class="chip chip--muted">{item.apparelColor}</span>
										{/if}
										{#if stationName}
											<span class="chip chip--station">{stationLabel(stationName)}</span>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					</article>
				{:else}
					<p class="muted empty">No orders match.</p>
				{/each}
			</div>
		</aside>

		<!-- Right: day-by-day timeline -->
		<section class="main">
			<div class="stations" role="tablist" aria-label="Station">
				{#each data.stationNames as station (station)}
					<button
						class="station-tab"
						class:station-tab--active={activeStation === station}
						role="tab"
						aria-selected={activeStation === station}
						onclick={() => selectStation(station)}
					>
						{stationLabel(station)}
					</button>
				{/each}
			</div>

			<div class="days">
				{#each data.capacity as day (day.date)}
					{@const hours = stationHoursForDay(day)}
					{@const label = formatDayLabel(day.date)}
					<article class="day" class:day--weekend={isWeekend(day.date)}>
						<header class="day__head">
							<div class="day__label">
								<span class="day__weekday">{label.weekday}</span>
								<span class="day__date">{label.date}</span>
							</div>
							<span class="day__capacity muted">{formatHours(hours)} available</span>
						</header>
						<div class="bar" aria-label="{hours} hours available on {day.date}">
							<div class="bar__track">
								<div class="bar__fill" style="width: {(hours / maxHours) * 100}%"></div>
								<div class="bar__ticks">
									{#each ticks as tick (tick)}
										<span
											class="tick"
											class:tick--major={tick % 2 === 0}
											style="left: {(tick / maxHours) * 100}%"
										>
											<span class="tick__label">{tick}h</span>
										</span>
									{/each}
								</div>
							</div>
						</div>
					</article>
				{/each}
			</div>

			<p class="muted footnote">
				Drop targets and proposed blocks are coming next — the drag handle on each order
				line item is wired to <code>application/x-line-item</code> already, so it will hook
				up once the day drop-zones ship.
			</p>
		</section>
	</div>
</div>

<style>
	.page-wide {
		max-width: 88rem;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4);
	}

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

	.header-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-5);
	}

	.header-row h1 {
		margin: 0.1rem 0 0.15rem;
	}

	.meta {
		margin: 0;
		font-size: var(--fs-sm);
	}

	/* Two-column workspace: tray + main timeline. Collapses to stacked on narrow. */
	.workspace {
		display: grid;
		grid-template-columns: minmax(18rem, 22rem) 1fr;
		gap: var(--space-4);
		align-items: start;
	}

	@media (max-width: 900px) {
		.workspace {
			grid-template-columns: 1fr;
		}
	}

	/* --- Side tray --- */
	.tray {
		padding: var(--space-4);
		position: sticky;
		top: var(--space-4);
		height: calc(100vh - var(--space-6));
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.tray__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.tray__head h2 {
		margin: 0;
		font-size: var(--fs-lg);
	}

	.tray__search {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		background: var(--surface);
		border-radius: var(--radius-sm);
		color: var(--ink-900);
		font-size: var(--fs-sm);
	}

	.tray__search:focus-visible {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-500);
	}

	.tray__list {
		overflow-y: auto;
		margin: 0 calc(var(--space-4) * -1) calc(var(--space-4) * -1);
		padding: 0 var(--space-4) var(--space-4);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.empty {
		text-align: center;
		padding: var(--space-5) 0;
	}

	.order {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		background: var(--surface);
	}

	.order__head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-2);
		margin-bottom: 0.55rem;
	}

	.order__title {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.order__customer {
		font-weight: 600;
		color: var(--ink-900);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.order__job {
		font-size: var(--fs-xs);
	}

	.order__meta {
		text-align: right;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-size: var(--fs-xs);
	}

	.hours-total {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		color: var(--warm-700);
	}

	.line-items {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.line-item {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.4rem 0.55rem;
		background: var(--warm-50);
		cursor: grab;
		transition: border-color var(--motion-fast) var(--ease-standard),
			transform var(--motion-fast) var(--ease-standard);
	}

	.line-item:hover {
		border-color: var(--warm-300);
	}

	.line-item:active {
		cursor: grabbing;
		transform: translateY(1px);
	}

	.line-item--error {
		background: var(--danger-bg);
	}

	.line-item__row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-2);
	}

	.line-item__design {
		font-size: var(--fs-sm);
		color: var(--ink-900);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.line-item__hours {
		font-variant-numeric: tabular-nums;
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--warm-700);
		flex-shrink: 0;
	}

	.line-item__hours--muted {
		color: var(--ink-500);
		font-weight: 500;
	}

	.line-item__chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.35rem;
	}

	.chip {
		font-size: var(--fs-xs);
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		background: var(--warm-100);
		color: var(--ink-700);
		border: 1px solid var(--warm-200);
	}

	.chip--muted {
		background: transparent;
		border-color: var(--border);
		color: var(--ink-500);
	}

	.chip--station {
		background: var(--warm-500);
		color: white;
		border-color: var(--warm-500);
	}

	/* --- Main timeline --- */
	.main {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.stations {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
		padding: 0.35rem;
		background: var(--warm-100);
		border-radius: var(--radius-md);
		position: sticky;
		top: var(--space-4);
		z-index: 2;
		box-shadow: 0 4px 8px rgb(0 0 0 / 12%);
	}

	.station-tab {
		border: none;
		background: transparent;
		padding: 0.4rem 0.85rem;
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
		font-weight: 550;
		color: var(--ink-700);
		cursor: pointer;
		transition: background-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);
	}

	.station-tab:hover {
		color: var(--ink-900);
	}

	.station-tab--active {
		background: var(--surface);
		color: var(--warm-700);
		box-shadow: var(--shadow-1);
	}

	.days {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.day {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: var(--space-3) var(--space-4);
		background: var(--surface);
	}

	.day--weekend {
		background: transparent;
		opacity: 0.7;
	}

	.day__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.day__label {
		display: flex;
		align-items: baseline;
		gap: 0.55rem;
	}

	.day__weekday {
		font-weight: 600;
		color: var(--ink-900);
		font-size: var(--fs-sm);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.day__date {
		color: var(--ink-500);
		font-size: var(--fs-sm);
	}

	.day__capacity {
		font-size: var(--fs-xs);
	}

	.bar {
		padding-bottom: 1.4rem; /* room for tick labels below track */
	}

	.bar__track {
		position: relative;
		height: 2.25rem;
		border-radius: var(--radius-sm);
		background: var(--warm-100);
		overflow: visible;
	}

	.bar__fill {
		position: absolute;
		inset: 0;
		width: 100%;
		background: linear-gradient(180deg, var(--warm-200), var(--warm-100));
		border: 1px dashed var(--warm-300);
		border-radius: var(--radius-sm);
	}

	.day--weekend .bar__fill {
		background: repeating-linear-gradient(
			45deg,
			transparent,
			transparent 6px,
			var(--warm-200) 6px,
			var(--warm-200) 8px
		);
		border-style: dotted;
	}

	.bar__ticks {
		position: absolute;
		inset: 0;
	}

	.tick {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--warm-300);
		opacity: 0.5;
	}

	.tick--major {
		opacity: 1;
		background: var(--warm-500);
	}

	.tick:first-child,
	.tick:last-child {
		background: var(--ink-500);
	}

	.tick__label {
		position: absolute;
		top: 100%;
		left: 0;
		transform: translate(-50%, 0.25rem);
		font-size: 0.65rem;
		color: var(--ink-500);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.tick:not(.tick--major) .tick__label {
		display: none;
	}

	.footnote {
		font-size: var(--fs-xs);
		text-align: center;
		margin-top: var(--space-2);
	}

	.footnote code {
		font-size: 0.85em;
		padding: 0 0.2em;
		background: var(--warm-100);
		border-radius: 4px;
	}
</style>
