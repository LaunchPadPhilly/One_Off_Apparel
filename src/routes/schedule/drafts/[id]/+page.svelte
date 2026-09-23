<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { screenEnter, screenExit } from '$lib/motion';
	import { appConfig, storageKeyPrefix } from '$lib/appConfig';
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

	// ─── Days view: full scroll vs one week at a time ──────────────────────────
	// `data.capacity` always covers draft.weeks * 7 days starting at the draft's
	// start date, so chunking it into groups of 7 lines up exactly with calendar
	// weeks — no partial-week edge case to handle.
	type DaysViewMode = 'scroll' | 'week';
	const DAYS_VIEW_MODE_KEY = `${storageKeyPrefix}scheduleDaysViewMode`;

	function loadDaysViewMode(): DaysViewMode {
		if (typeof window === 'undefined') return 'scroll';
		try {
			const saved = localStorage.getItem(DAYS_VIEW_MODE_KEY);
			if (saved === 'scroll' || saved === 'week') return saved;
		} catch {
			// localStorage unavailable — just default to scroll.
		}
		return 'scroll';
	}

	let daysViewMode = $state<DaysViewMode>(loadDaysViewMode());
	let weekIndex = $state(0);

	function setDaysViewMode(mode: DaysViewMode) {
		daysViewMode = mode;
		weekIndex = 0;
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(DAYS_VIEW_MODE_KEY, mode);
		} catch {
			// localStorage unavailable — the choice just won't persist across reloads.
		}
	}

	let totalWeeks = $derived(Math.max(1, Math.ceil(data.capacity.length / 7)));
	let visibleDays = $derived(
		daysViewMode === 'week' ? data.capacity.slice(weekIndex * 7, weekIndex * 7 + 7) : data.capacity
	);
	let weekRangeLabel = $derived.by(() => {
		const weekDays = data.capacity.slice(weekIndex * 7, weekIndex * 7 + 7);
		if (weekDays.length === 0) return '';
		const first = formatDayLabel(weekDays[0].date);
		const last = formatDayLabel(weekDays[weekDays.length - 1].date);
		return `${first.date} – ${last.date}`;
	});

	function goPrevWeek() {
		weekIndex = Math.max(0, weekIndex - 1);
	}

	function goNextWeek() {
		weekIndex = Math.min(totalWeeks - 1, weekIndex + 1);
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

	// The floor plan's daily shift: 8:00 → 16:30, with three unavailable segments.
	// Working time = shift length − break minutes = 510 − 60 = 450 min = 7h30m.
	const SHIFT_START_MIN = 8 * 60; // 08:00
	const SHIFT_END_MIN = 16 * 60 + 30; // 16:30
	const SHIFT_LENGTH_MIN = SHIFT_END_MIN - SHIFT_START_MIN;
	const BREAKS = [
		{ startMin: 10 * 60, durationMin: 15, label: 'Break' },
		{ startMin: 12 * 60 + 30, durationMin: 30, label: 'Lunch' },
		{ startMin: 15 * 60, durationMin: 15, label: 'Break' }
	];
	const WORKING_MIN = SHIFT_LENGTH_MIN - BREAKS.reduce((sum, b) => sum + b.durationMin, 0);
	const WORKING_HOURS = WORKING_MIN / 60;

	// One hour marker per hour boundary that falls inside the shift.
	const HOUR_TICKS = (() => {
		const ticks: Array<{ minutes: number; label: string }> = [];
		const first = Math.ceil(SHIFT_START_MIN / 60) * 60;
		for (let m = first; m <= SHIFT_END_MIN; m += 60) {
			const hour24 = Math.floor(m / 60);
			const hour12 = ((hour24 + 11) % 12) + 1;
			const suffix = hour24 < 12 ? 'a' : 'p';
			ticks.push({ minutes: m, label: `${hour12}${suffix}` });
		}
		return ticks;
	})();

	function pctFromShiftStart(minutes: number): number {
		return ((minutes - SHIFT_START_MIN) / SHIFT_LENGTH_MIN) * 100;
	}

	function pctWidth(minutes: number): number {
		return (minutes / SHIFT_LENGTH_MIN) * 100;
	}

	function formatBreakLabel(startMin: number, durationMin: number): string {
		const h = Math.floor(startMin / 60);
		const m = startMin % 60;
		const h12 = ((h + 11) % 12) + 1;
		const suffix = h < 12 ? 'a' : 'p';
		const time = m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
		return `${time} · ${durationMin}m`;
	}

	// ─── Order colors + title overrides ────────────────────────────────────────
	// A small palette of hues chosen to sit next to the warm base without clashing.
	// Deterministic hash → color assignment gives each order a stable default; the
	// user can override via the inline edit UI. Overrides live in $state and are not
	// persisted to the database yet — this pass is design only.
	const ORDER_COLORS = [
		'#c96f4a', // rust
		'#4a8fc9', // sky
		'#7ba055', // olive
		'#c9a54a', // gold
		'#8b5cb0', // plum
		'#4ab09e', // teal
		'#c94a7f', // rose
		'#5a6ba8' // indigo
	] as const;

	type OrderOverride = { color?: string; title?: string };
	// Seed from any server-persisted overrides so a reload keeps them.
	let orderOverrides = $state<Record<string, OrderOverride>>(
		Object.fromEntries(
			data.orders
				.filter((o) => o.displayTitle || o.colorHex)
				.map((o) => [
					o.id,
					{
						title: o.displayTitle ?? undefined,
						color: o.colorHex ?? undefined
					}
				])
		)
	);

	function deterministicColor(id: string): string {
		let hash = 0;
		for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
		return ORDER_COLORS[Math.abs(hash) % ORDER_COLORS.length];
	}

	function orderColor(orderId: string): string {
		return orderOverrides[orderId]?.color ?? deterministicColor(orderId);
	}

	function orderTitle(order: { id: string; customerName: string; hoopsOrderId: string }): string {
		return orderOverrides[order.id]?.title ?? order.customerName ?? order.hoopsOrderId;
	}

	let ordersById = $derived(new Map(data.orders.map((o) => [o.id, o] as const)));
	function findOrder(orderId: string) {
		return ordersById.get(orderId);
	}

	// ─── Inline edit state ─────────────────────────────────────────────────────
	let editingOrderId = $state<string | null>(null);
	let draftTitle = $state('');
	let draftColor = $state('');

	function beginEdit(order: (typeof data.orders)[number]) {
		editingOrderId = order.id;
		draftTitle = orderTitle(order);
		draftColor = orderColor(order.id);
	}

	async function saveEdit() {
		if (!editingOrderId) return;
		const id = editingOrderId;
		const title = draftTitle.trim();
		const color = draftColor;
		orderOverrides = { ...orderOverrides, [id]: { title, color } };
		editingOrderId = null;
		// Persist the override. We only surface the failure in the console for
		// now — the tray UI already shows the updated title/color; a later pass
		// will thread errors back to a toast.
		const body = new FormData();
		body.set('orderId', id);
		body.set('displayTitle', title);
		body.set('colorHex', color);
		await fetch('?/updateOrderDisplay', { method: 'POST', body }).catch((e) => {
			console.error('updateOrderDisplay failed', e);
		});
	}

	function cancelEdit() {
		editingOrderId = null;
	}

	// ─── Placements (drag-drop blocks on the timeline) ─────────────────────────
	// Client-side only for now — this is the design pass. Persisting to
	// schedule_assignments comes next, after the shape settles.
	//
	// A placement's `durationMin` is *working* minutes; its wall-clock span
	// stretches to include any breaks it crosses (a 3h task starting at 9:30
	// finishes at 12:45 wall clock, not 12:30). Rendering emits one <div> per
	// contiguous working segment so the bar visibly "splits" around a break.
	type Placement = {
		id: string;
		lineItemId: string;
		orderId: string;
		date: string;
		stationName: string;
		startMin: number;
		durationMin: number;
	};
	// Hydrate from server: each ScheduleAssignment tied to this draft becomes a
	// placement. estimatedHours * 60 is the working duration; startMinuteOfDay
	// is minutes-from-midnight, aligned with the client's SHIFT_START_MIN.
	let placements = $state<Placement[]>(
		data.assignments.map((a) => ({
			id: a.id,
			lineItemId: a.lineItemId,
			orderId: a.orderId,
			date: a.date,
			stationName: a.stationName,
			startMin: a.startMinuteOfDay,
			durationMin: Math.max(15, Math.round(a.estimatedHours * 60))
		}))
	);

	function placementsForDay(date: string): Placement[] {
		return placements
			.filter((p) => p.date === date && p.stationName === activeStation)
			.sort((a, b) => a.startMin - b.startMin);
	}

	// Wall-clock end of a working span that begins at startMin: walks forward,
	// jumping across each break it crosses without consuming working budget.
	function wallClockEnd(startMin: number, workingMin: number): number {
		let cursor = startMin;
		let remaining = workingMin;
		while (remaining > 0 && cursor < SHIFT_END_MIN) {
			// Inside a break? Jump to its end.
			const inBrk = BREAKS.find(
				(b) => cursor >= b.startMin && cursor < b.startMin + b.durationMin
			);
			if (inBrk) {
				cursor = inBrk.startMin + inBrk.durationMin;
				continue;
			}
			const nextBrk = BREAKS.find((b) => b.startMin > cursor);
			const segmentEnd = nextBrk ? nextBrk.startMin : SHIFT_END_MIN;
			const available = segmentEnd - cursor;
			if (remaining <= available) {
				cursor += remaining;
				remaining = 0;
			} else {
				cursor = segmentEnd;
				remaining -= available;
			}
		}
		return cursor;
	}

	// Split a working span into one visible segment per contiguous working slice.
	function computeSegments(
		startMin: number,
		workingMin: number
	): Array<{ start: number; end: number }> {
		const segments: Array<{ start: number; end: number }> = [];
		let cursor = startMin;
		let remaining = workingMin;
		while (remaining > 0 && cursor < SHIFT_END_MIN) {
			const inBrk = BREAKS.find(
				(b) => cursor >= b.startMin && cursor < b.startMin + b.durationMin
			);
			if (inBrk) {
				cursor = inBrk.startMin + inBrk.durationMin;
				continue;
			}
			const nextBrk = BREAKS.find((b) => b.startMin > cursor);
			const segmentEnd = nextBrk ? nextBrk.startMin : SHIFT_END_MIN;
			const available = segmentEnd - cursor;
			const use = Math.min(remaining, available);
			if (use > 0) segments.push({ start: cursor, end: cursor + use });
			remaining -= use;
			cursor += use;
		}
		return segments;
	}

	// Push-right: snap `desired` forward past any placements it would overlap on
	// this (date, station). Also skips forward out of a break if the desired
	// start lands inside one. Bounded loop so a pathological input can't hang.
	function findNonOverlappingStart(
		desired: number,
		workingMin: number,
		others: Placement[]
	): number {
		const extents = others
			.map((p) => ({ start: p.startMin, end: wallClockEnd(p.startMin, p.durationMin) }))
			.sort((a, b) => a.start - b.start);

		let candidate = desired;
		for (let i = 0; i < 40; i++) {
			// If we're sitting inside a break, jump past it.
			const inBrk = BREAKS.find(
				(b) => candidate >= b.startMin && candidate < b.startMin + b.durationMin
			);
			if (inBrk) {
				candidate = inBrk.startMin + inBrk.durationMin;
				continue;
			}
			const end = wallClockEnd(candidate, workingMin);
			const conflict = extents.find((o) => candidate < o.end && end > o.start);
			if (!conflict) return candidate;
			// Snap to just after the conflicting block, rounded up to the next 15m.
			candidate = Math.ceil(conflict.end / 15) * 15;
		}
		return candidate;
	}

	function snapTo15(dropMin: number, durationMin: number): number {
		const rawStart = dropMin - durationMin / 2;
		const clamped = Math.max(
			SHIFT_START_MIN,
			Math.min(SHIFT_END_MIN - Math.min(durationMin, SHIFT_LENGTH_MIN), rawStart)
		);
		return Math.round(clamped / 15) * 15;
	}

	function handleDragStart(
		event: DragEvent,
		lineItemId: string,
		orderId: string,
		hours: number | null
	) {
		if (!event.dataTransfer) return;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData(
			'application/x-line-item',
			JSON.stringify({ lineItemId, orderId, hours: hours ?? 1 })
		);
	}

	function handlePlacementDragStart(event: DragEvent, placementId: string) {
		if (!event.dataTransfer) return;
		event.stopPropagation();
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData(
			'application/x-placement',
			JSON.stringify({ placementId })
		);
	}

	let dragOverDate = $state<string | null>(null);

	function handleTrackDragOver(event: DragEvent, date: string) {
		const types = event.dataTransfer?.types;
		if (
			!types?.includes('application/x-line-item') &&
			!types?.includes('application/x-placement')
		)
			return;
		event.preventDefault();
		event.dataTransfer!.dropEffect = 'move';
		dragOverDate = date;
	}

	function handleTrackDragLeave() {
		dragOverDate = null;
	}

	// Server persistence helpers. Every mutation applies optimistically to the
	// $state array first (so drag feedback is instant), then POSTs to the form
	// action. On failure we roll back and log. Errors surface in the console
	// for now; a toast pass comes with the wider save-error UX.
	async function postAction(action: string, body: FormData): Promise<boolean> {
		try {
			const res = await fetch(`?/${action}`, { method: 'POST', body });
			return res.ok;
		} catch (e) {
			console.error(`${action} failed`, e);
			return false;
		}
	}

	async function handleTrackDrop(event: DragEvent, date: string) {
		event.preventDefault();
		dragOverDate = null;
		if (!event.dataTransfer) return;
		const track = event.currentTarget as HTMLElement;
		const rect = track.getBoundingClientRect();
		const relative = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
		const dropMin = SHIFT_START_MIN + (relative / rect.width) * SHIFT_LENGTH_MIN;

		// Moving an existing placement wins over adding a new one — some browsers
		// leave stale getData from a prior transfer, so check payloads by priority.
		const placementRaw = event.dataTransfer.getData('application/x-placement');
		if (placementRaw) {
			let payload: { placementId: string };
			try {
				payload = JSON.parse(placementRaw);
			} catch {
				return;
			}
			const existing = placements.find((p) => p.id === payload.placementId);
			if (!existing) return;
			const desired = snapTo15(dropMin, existing.durationMin);
			const others = placements.filter(
				(p) =>
					p.date === date && p.stationName === activeStation && p.id !== existing.id
			);
			const startMin = findNonOverlappingStart(desired, existing.durationMin, others);
			const before = { ...existing };
			placements = placements.map((p) =>
				p.id === existing.id
					? { ...p, date, stationName: activeStation, startMin }
					: p
			);
			const body = new FormData();
			body.set('id', existing.id);
			body.set('stationName', activeStation);
			body.set('date', date);
			body.set('startMinuteOfDay', String(startMin));
			const ok = await postAction('moveAssignment', body);
			if (!ok) {
				// Roll back to the last known good state.
				placements = placements.map((p) => (p.id === existing.id ? before : p));
			}
			return;
		}

		const lineItemRaw = event.dataTransfer.getData('application/x-line-item');
		if (!lineItemRaw) return;
		let payload: { lineItemId: string; orderId: string; hours: number };
		try {
			payload = JSON.parse(lineItemRaw);
		} catch {
			return;
		}
		const durationMin = Math.max(15, Math.round((payload.hours || 1) * 60));
		const desired = snapTo15(dropMin, durationMin);
		const others = placements.filter(
			(p) => p.date === date && p.stationName === activeStation
		);
		const startMin = findNonOverlappingStart(desired, durationMin, others);
		// Optimistic: give it a temp id so it can be dragged again immediately;
		// swap the temp id for the server-assigned one once the POST resolves.
		const tempId = `tmp:${crypto.randomUUID()}`;
		placements = [
			...placements,
			{
				id: tempId,
				lineItemId: payload.lineItemId,
				orderId: payload.orderId,
				date,
				stationName: activeStation,
				startMin,
				durationMin
			}
		];
		const body = new FormData();
		body.set('lineItemId', payload.lineItemId);
		body.set('stationName', activeStation);
		body.set('date', date);
		body.set('startMinuteOfDay', String(startMin));
		body.set('hours', String(durationMin / 60));
		try {
			const res = await fetch('?/placeAssignment', { method: 'POST', body });
			if (!res.ok) throw new Error(`placeAssignment failed: ${res.status}`);
			// SvelteKit form-action fetches return an ActionResult-wrapped JSON.
			const wire = (await res.json()) as {
				type: string;
				data?: string;
			};
			const parsed = wire.data ? (JSON.parse(wire.data) as unknown[]) : [];
			// ActionResult data is a positional array — { success, id } becomes
			// [success, id] with the actual values at odd indices in the flat
			// serialization. Walk it defensively.
			let assignedId: string | null = null;
			for (const value of parsed) {
				if (typeof value === 'string' && value.length > 8 && value !== 'success') {
					assignedId = value;
					break;
				}
			}
			if (assignedId) {
				placements = placements.map((p) => (p.id === tempId ? { ...p, id: assignedId! } : p));
			}
		} catch (e) {
			console.error('placeAssignment failed', e);
			// Roll back.
			placements = placements.filter((p) => p.id !== tempId);
		}
	}

	async function removePlacement(id: string) {
		const before = placements;
		placements = placements.filter((p) => p.id !== id);
		if (id.startsWith('tmp:')) return; // never persisted
		const body = new FormData();
		body.set('id', id);
		const ok = await postAction('removeAssignment', body);
		if (!ok) placements = before;
	}

	function formatMinutes(minutes: number): string {
		if (minutes < 60) return `${minutes}m`;
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return m === 0 ? `${h}h` : `${h}h${m}m`;
	}

	function formatClock(minutes: number): string {
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		const h12 = ((h + 11) % 12) + 1;
		const suffix = h < 12 ? 'a' : 'p';
		return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
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
					{@const color = orderColor(order.id)}
					<article
						class="order"
						role="listitem"
						style="--order-color: {color}"
					>
						<span class="order__swatch" aria-hidden="true"></span>
						{#if editingOrderId === order.id}
							<div class="order__edit">
								<label class="order__edit-label">
									Title
									<input
										class="order__edit-input"
										type="text"
										bind:value={draftTitle}
										aria-label="Order title"
									/>
								</label>
								<div class="order__edit-label">
									<span>Color</span>
									<div class="palette" role="radiogroup" aria-label="Order color">
										{#each ORDER_COLORS as swatch (swatch)}
											<button
												type="button"
												class="palette__swatch"
												class:palette__swatch--active={draftColor === swatch}
												style="background: {swatch}"
												aria-label={swatch}
												aria-checked={draftColor === swatch}
												role="radio"
												onclick={() => (draftColor = swatch)}
											></button>
										{/each}
									</div>
								</div>
								<div class="order__edit-actions">
									<button type="button" class="button button--secondary" onclick={cancelEdit}>
										Cancel
									</button>
									<button type="button" class="button" onclick={saveEdit}>Save</button>
								</div>
							</div>
						{:else}
							<header class="order__head">
								<div class="order__title">
									<span class="order__customer">{orderTitle(order)}</span>
									<span class="muted order__job">#{order.hoopsOrderId}</span>
								</div>
								<div class="order__meta">
									<button
										type="button"
										class="order__edit-btn"
										title="Edit title & color"
										aria-label="Edit order title and color"
										onclick={() => beginEdit(order)}
									>
										Edit
									</button>
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
										ondragstart={(event) => handleDragStart(event, item.id, order.id, hours)}
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
						{/if}
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

			<div class="days-toolbar">
				<div class="segmented" role="tablist" aria-label="Days view">
					<button
						type="button"
						class="segmented__option"
						class:segmented__option--active={daysViewMode === 'scroll'}
						role="tab"
						aria-selected={daysViewMode === 'scroll'}
						onclick={() => setDaysViewMode('scroll')}
					>
						Scroll
					</button>
					<button
						type="button"
						class="segmented__option"
						class:segmented__option--active={daysViewMode === 'week'}
						role="tab"
						aria-selected={daysViewMode === 'week'}
						onclick={() => setDaysViewMode('week')}
					>
						Week
					</button>
				</div>

				{#if daysViewMode === 'week'}
					<div class="week-nav">
						<button
							type="button"
							class="week-nav__arrow"
							aria-label="Previous week"
							disabled={weekIndex === 0}
							onclick={goPrevWeek}
						>‹</button>
						<span class="week-nav__label">
							{weekRangeLabel} · Week {weekIndex + 1} of {totalWeeks}
						</span>
						<button
							type="button"
							class="week-nav__arrow"
							aria-label="Next week"
							disabled={weekIndex >= totalWeeks - 1}
							onclick={goNextWeek}
						>›</button>
					</div>
				{/if}
			</div>

			<div class="days">
				{#each visibleDays as day (day.date)}
					{@const label = formatDayLabel(day.date)}
					{@const dayPlacements = placementsForDay(day.date)}
					<article class="day" class:day--weekend={isWeekend(day.date)}>
						<header class="day__head">
							<div class="day__label">
								<span class="day__weekday">{label.weekday}</span>
								<span class="day__date">{label.date}</span>
							</div>
							<span class="day__capacity muted">
								{formatHours(WORKING_HOURS)} available · 8a–4:30p
							</span>
						</header>
						<div class="bar" aria-label="{WORKING_HOURS} working hours available on {day.date}">
							<div
								class="bar__track"
								class:bar__track--drag={dragOverDate === day.date}
								role="presentation"
								ondragover={(event) => handleTrackDragOver(event, day.date)}
								ondragleave={handleTrackDragLeave}
								ondrop={(event) => handleTrackDrop(event, day.date)}
							>
								<div class="bar__fill"></div>
								{#each BREAKS as brk (brk.startMin)}
									<div
										class="bar__break"
										style="left: {pctFromShiftStart(brk.startMin)}%; width: {pctWidth(brk.durationMin)}%;"
										title="{brk.label} — {formatBreakLabel(brk.startMin, brk.durationMin)}"
									>
										<span class="bar__break-label">{brk.label}</span>
									</div>
								{/each}
								{#each dayPlacements as placement (placement.id)}
									{@const parent = findOrder(placement.orderId)}
									{@const bg = orderColor(placement.orderId)}
									{@const title = parent ? orderTitle(parent) : 'Order'}
									{@const segments = computeSegments(placement.startMin, placement.durationMin)}
									{@const wallEnd = wallClockEnd(placement.startMin, placement.durationMin)}
									{#each segments as seg, i (seg.start)}
										{@const isFirst = i === 0}
										{@const isLast = i === segments.length - 1}
										<div
											class="placement"
											class:placement--first={isFirst}
											class:placement--last={isLast}
											class:placement--middle={!isFirst && !isLast}
											role="button"
											tabindex="0"
											draggable="true"
											ondragstart={(event) => handlePlacementDragStart(event, placement.id)}
											style="left: {pctFromShiftStart(seg.start)}%; width: {pctWidth(seg.end - seg.start)}%; --block-color: {bg};"
											title="{title} · {formatClock(placement.startMin)} → {formatClock(wallEnd)} ({formatMinutes(placement.durationMin)} of work{segments.length > 1 ? `, split across ${segments.length} slices` : ''})"
										>
											{#if isFirst}
												<span class="placement__label">{title}</span>
												<span class="placement__time">{formatMinutes(placement.durationMin)}</span>
												<button
													type="button"
													class="placement__remove"
													aria-label="Remove"
													onclick={() => removePlacement(placement.id)}
												>×</button>
											{/if}
										</div>
									{/each}
								{/each}
								<div class="bar__ticks">
									{#each HOUR_TICKS as tick (tick.minutes)}
										<span
											class="tick tick--major"
											style="left: {pctFromShiftStart(tick.minutes)}%"
										>
											<span class="tick__label">{tick.label}</span>
										</span>
									{/each}
									<!-- half-hour end marker so 4:30 shows -->
									<span class="tick" style="left: 100%">
										<span class="tick__label">4:30p</span>
									</span>
								</div>
							</div>
						</div>
					</article>
				{/each}
			</div>

			<p class="muted footnote">
				Drag line items from the tray onto a day's bar. Blocks snap to 15-minute
				increments; drop over a break and the block turns red to flag the conflict.
				Placements live in the browser for now — persisting to
				<code>schedule_assignments</code> comes next.
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
		padding: 0.75rem 0.75rem 0.75rem 1rem;
		background: var(--surface);
		position: relative;
	}

	.order__swatch {
		position: absolute;
		top: 0;
		left: 0;
		bottom: 0;
		width: 4px;
		background: var(--order-color, var(--warm-500));
		border-radius: var(--radius-sm) 0 0 var(--radius-sm);
	}

	.order__edit-btn {
		background: none;
		border: 1px solid var(--border);
		color: var(--ink-500);
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		font-size: var(--fs-xs);
		cursor: pointer;
		margin-bottom: 0.2rem;
		transition: color var(--motion-fast) var(--ease-standard),
			border-color var(--motion-fast) var(--ease-standard);
	}

	.order__edit-btn:hover {
		color: var(--warm-700);
		border-color: var(--warm-300);
	}

	.order__edit {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.order__edit-label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--fs-xs);
		color: var(--ink-500);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
	}

	.order__edit-input {
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--border);
		background: var(--surface);
		border-radius: var(--radius-sm);
		color: var(--ink-900);
		font-size: var(--fs-sm);
		text-transform: none;
		letter-spacing: 0;
		font-weight: 400;
	}

	.order__edit-input:focus-visible {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-500);
	}

	.palette {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.palette__swatch {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 2px solid transparent;
		padding: 0;
		cursor: pointer;
		transition: transform var(--motion-fast) var(--ease-standard),
			box-shadow var(--motion-fast) var(--ease-standard);
	}

	.palette__swatch:hover {
		transform: scale(1.1);
	}

	.palette__swatch--active {
		border-color: var(--ink-900);
		box-shadow: 0 0 0 2px var(--surface) inset;
		transform: scale(1.1);
	}

	.order__edit-actions {
		display: flex;
		gap: 0.35rem;
		justify-content: flex-end;
	}

	.order__edit-actions .button {
		padding: 0.35rem 0.75rem;
		font-size: var(--fs-sm);
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

	.days-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.segmented {
		display: inline-flex;
		gap: 0.2rem;
		padding: 0.2rem;
		background: var(--warm-100);
		border-radius: var(--radius-md);
	}

	.segmented__option {
		border: none;
		background: transparent;
		padding: 0.3rem 0.7rem;
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
		font-weight: 550;
		color: var(--ink-700);
		cursor: pointer;
		transition: background-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);
	}

	.segmented__option:hover {
		color: var(--ink-900);
	}

	.segmented__option--active {
		background: var(--surface);
		color: var(--warm-700);
		box-shadow: var(--shadow-1);
	}

	.week-nav {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.week-nav__label {
		font-size: var(--fs-sm);
		color: var(--ink-700);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.week-nav__arrow {
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--ink-700);
		width: 1.9rem;
		height: 1.9rem;
		border-radius: var(--radius-sm);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: border-color var(--motion-fast) var(--ease-standard),
			color var(--motion-fast) var(--ease-standard);
	}

	.week-nav__arrow:hover:not(:disabled) {
		border-color: var(--warm-300);
		color: var(--warm-700);
	}

	.week-nav__arrow:disabled {
		opacity: 0.4;
		cursor: not-allowed;
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

	.bar__track--drag {
		outline: 2px dashed var(--warm-500);
		outline-offset: 2px;
	}

	.placement {
		position: absolute;
		top: 3px;
		bottom: 3px;
		background: var(--block-color, var(--warm-500));
		border: 1px solid rgb(0 0 0 / 20%);
		border-radius: 0;
		color: white;
		padding: 0 0.4rem;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		z-index: 2;
		box-shadow: 0 1px 3px rgb(0 0 0 / 25%);
		overflow: hidden;
		cursor: grab;
	}

	.placement:active {
		cursor: grabbing;
	}

	/* A single-segment block has both --first and --last, so its four
	   corners round; a split block rounds only its outer edges. */
	.placement--first {
		border-top-left-radius: 4px;
		border-bottom-left-radius: 4px;
	}

	.placement--last {
		border-top-right-radius: 4px;
		border-bottom-right-radius: 4px;
	}

	/* Give split continuations a subtle chevron edge hint so the eye reads
	   them as "same block, continued past the break". */
	.placement--last:not(.placement--first)::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		background: rgb(255 255 255 / 40%);
	}

	.placement__label {
		flex: 1;
		min-width: 0;
		font-size: 0.72rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.placement__time {
		font-size: 0.65rem;
		opacity: 0.85;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	.placement__remove {
		background: rgb(0 0 0 / 25%);
		color: white;
		border: none;
		width: 1.05rem;
		height: 1.05rem;
		border-radius: 50%;
		font-size: 0.85rem;
		line-height: 1;
		padding: 0;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity var(--motion-fast) var(--ease-standard);
	}

	.placement:hover .placement__remove {
		opacity: 1;
	}

	.placement__remove:hover {
		background: rgb(0 0 0 / 45%);
	}

	.bar__break {
		position: absolute;
		top: 0;
		bottom: 0;
		background: repeating-linear-gradient(
			45deg,
			var(--ink-500) 0,
			var(--ink-500) 2px,
			transparent 2px,
			transparent 6px
		);
		background-color: rgb(122 101 88 / 20%);
		border-left: 1px solid var(--ink-500);
		border-right: 1px solid var(--ink-500);
		opacity: 0.55;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.bar__break-label {
		font-size: 0.6rem;
		color: var(--ink-500);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		white-space: nowrap;
		background: var(--surface);
		padding: 0 0.2rem;
		border-radius: 3px;
		opacity: 0.9;
	}

	/* Hide labels in tight break slots (15m at ~3% width can't fit "Break") */
	.bar__break:not(:hover) .bar__break-label {
		opacity: 0;
	}

	.bar__break:hover {
		opacity: 0.75;
	}

	.bar__break:hover .bar__break-label {
		opacity: 1;
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
