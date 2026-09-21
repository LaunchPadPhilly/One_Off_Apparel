<script lang="ts">
	import { appConfig } from '$lib/appConfig';
	import { enhance } from '$app/forms';
	import { estimateHours, MissingFormulaError } from '$lib/engine/estimateHours';
	import type { EstimateStep } from '$lib/engine/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let dragOver = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let editablePreview = $state<NonNullable<typeof form>['preview']>(undefined);
	let showImportModal = $state(false);
	let collapsedOrders = $state(new Set<string>());
	let filterStatus = $state('ALL');
	let filterSearch = $state('');

	let filteredOrders = $derived(data.orders.filter((o) => {
		if (filterStatus !== 'ALL' && o.status !== filterStatus) return false;
		if (filterSearch) {
			const q = filterSearch.toLowerCase();
			if (!o.customerName.toLowerCase().includes(q) && !o.hoopsOrderId.toLowerCase().includes(q)) return false;
		}
		return true;
	}));

	function toggleOrder(id: string) {
		if (collapsedOrders.has(id)) {
			collapsedOrders.delete(id);
		} else {
			collapsedOrders.add(id);
		}
		collapsedOrders = new Set(collapsedOrders);
	}

	$effect(() => {
		if (form?.preview) {
			editablePreview = $state.snapshot(form.preview) as typeof form.preview;
			showImportModal = true;
		} else if (form?.success) {
			editablePreview = undefined;
			showImportModal = false;
		}
	});

	function reEstimate(item: NonNullable<typeof editablePreview>[number]['lineItems'][number]) {
		try {
			item.estimate = estimateHours({
				itemType: item.itemType,
				decorationType: item.decorationType,
				finishingStep: item.finishingStep,
				inkColorCount: item.inkColorCount,
				screens: item.screens,
				stitchCount: item.stitchCount,
				quantity: item.quantity,
				weightClass: item.weightClass
			});
		} catch (e) {
			if (e instanceof MissingFormulaError) {
				item.estimate = { error: e.message };
			}
		}
	}

	function statusLabel(value: string): string {
		return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	function statusBadgeClass(value: string): string {
		if (value === 'APPROVED' || value === 'RECEIVED' || value === 'COMPLETE') return 'badge--success';
		if (value === 'ISSUE' || value === 'REVISION_REQUESTED' || value === 'CHANGES_REQUESTED') return 'badge--danger';
		if (value === 'NEEDS_REVIEW' || value === 'NOT_ORDERED' || value === 'NOT_SENT' || value === 'NOT_SUBMITTED') return 'badge--muted';
		return 'badge--info';
	}

	let expandedItems = $state(new Set<string>());

	function toggleExpand(key: string) {
		if (expandedItems.has(key)) {
			expandedItems.delete(key);
		} else {
			expandedItems.add(key);
		}
		expandedItems = new Set(expandedItems);
	}

	function formatHours(hours: number): string {
		const h = Math.floor(hours);
		const m = Math.round((hours - h) * 60);
		if (h === 0) return `${m}m`;
		if (m === 0) return `${h}h`;
		return `${h}h ${m}m`;
	}

	function formatEstimate(est: unknown): string {
		if (!est || typeof est !== 'object') return '—';
		const obj = est as Record<string, unknown>;
		if ('error' in obj) return String(obj.error).split(':')[0];
		if ('hours' in obj) return formatHours(obj.hours as number);
		return '—';
	}

	function getEstimateHours(est: unknown): number {
		if (!est || typeof est !== 'object') return 0;
		const obj = est as Record<string, unknown>;
		if ('hours' in obj) return obj.hours as number;
		return 0;
	}

	function estimateHasError(est: unknown): boolean {
		if (!est || typeof est !== 'object') return false;
		return 'error' in (est as Record<string, unknown>);
	}

	function getOrderTotal(order: NonNullable<typeof editablePreview>[number]): number {
		return order.lineItems.reduce((sum, item) => sum + getEstimateHours(item.estimate), 0);
	}

	function getEstimateSteps(est: unknown): EstimateStep[] | null {
		if (!est || typeof est !== 'object') return null;
		const obj = est as Record<string, unknown>;
		if ('steps' in obj && Array.isArray(obj.steps)) return obj.steps as EstimateStep[];
		return null;
	}

	function getRawMinutes(est: unknown): number | null {
		if (!est || typeof est !== 'object') return null;
		const obj = est as Record<string, unknown>;
		if ('rawMinutes' in obj && typeof obj.rawMinutes === 'number') return obj.rawMinutes;
		return null;
	}

	function handleDrop(e: DragEvent) {
		dragOver = false;
		if (!e.dataTransfer?.files.length || !fileInput) return;
		const dt = new DataTransfer();
		dt.items.add(e.dataTransfer.files[0]);
		fileInput.files = dt.files;
		fileInput.form?.requestSubmit();
	}
</script>

<svelte:head>
	<title>Orders — {appConfig.displayName}</title>
</svelte:head>

<div class="page">
	<div class="page-header">
		<h1>Orders</h1>
		<button class="button" onclick={() => { showImportModal = true; }}>Import CSV</button>
	</div>

	{#if form?.error && !showImportModal}
		<div class="alert alert--error">{form.error}</div>
	{/if}
	{#if form?.success}
		<div class="alert alert--success">
			{#if form.created}
				Imported {form.created.length} order(s): {form.created.join(', ')}
			{:else}
				Order saved successfully.
			{/if}
		</div>
	{/if}

	<!-- Import Modal -->
	{#if showImportModal}
		<div class="modal-backdrop" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) { showImportModal = false; editablePreview = undefined; } }} onkeydown={(e) => { if (e.key === 'Escape') { showImportModal = false; editablePreview = undefined; } }}>
			<div class="modal">
				<div class="modal__header">
					<h2>{editablePreview ? 'Review Import' : 'Import Orders from CSV'}</h2>
					<button class="modal__close" onclick={() => { showImportModal = false; editablePreview = undefined; }}>&times;</button>
				</div>
				<div class="modal__body">
					{#if form?.error}
						<div class="alert alert--error" style="margin-bottom: var(--space-4);">{form.error}</div>
					{/if}

					{#if !editablePreview}
						<p class="muted">Upload a CSV exported from Hoops to create orders and run estimates.</p>
						<form
							method="POST"
							action="?/upload"
							enctype="multipart/form-data"
							use:enhance
						>
							<div
								class="drop-zone"
								class:drop-zone--active={dragOver}
								role="button"
								tabindex="0"
								ondragover={(e) => { e.preventDefault(); dragOver = true; }}
								ondragleave={() => (dragOver = false)}
								ondrop={(e) => { e.preventDefault(); handleDrop(e); }}
								onclick={() => fileInput?.click()}
								onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput?.click(); }}
							>
								<span class="drop-zone__icon">CSV</span>
								<span class="drop-zone__text">Drop a CSV file here, or click to browse</span>
								<span class="drop-zone__hint muted">Expected columns: job_number, customer, deadline, type, name_description, position, color, quantity</span>
							</div>
							<input
								type="file"
								name="csvFile"
								accept=".csv,text/csv"
								hidden
								bind:this={fileInput}
								onchange={(e) => e.currentTarget.form?.requestSubmit()}
							/>
						</form>
					{:else}
						<p class="muted">Review the parsed orders below. Edit any incorrect values, then confirm to save.</p>

						<form method="POST" action="?/confirm" use:enhance>
							<input type="hidden" name="ordersData" value={JSON.stringify(editablePreview)} />

							{#each editablePreview as order}
								<div class="preview-order">
									<h3>Order #{order.hoopsOrderId}</h3>

									{#if order.warnings.length > 0}
										<div class="warnings">
											{#each order.warnings as w}
												<div class="warning-item">{w}</div>
											{/each}
										</div>
									{/if}

									<div class="form-grid">
										<label class="field">
											<span class="field__label">Customer Name</span>
											<input type="text" name="customer_{order.hoopsOrderId}" value={order.customerName} required />
										</label>
										<label class="field">
											<span class="field__label">External Ship Date</span>
											<input type="date" name="shipDate_{order.hoopsOrderId}" value={order.externalShipDate} required />
										</label>
										<label class="field">
											<span class="field__label">Internal Due Date</span>
											<input type="date" name="dueDate_{order.hoopsOrderId}" value={order.internalDueDate} required />
										</label>
									</div>

									<div class="line-items-table-wrap">
										<table class="line-items-table">
											<thead>
												<tr>
													<th>Type</th>
													<th>Design</th>
													<th>Location</th>
													<th>Qty</th>
													<th>Colors</th>
													<th>Weight</th>
													<th>Estimate</th>
												</tr>
											</thead>
											<tbody>
												{#each order.lineItems as item, idx}
													{@const rowKey = `${order.hoopsOrderId}-${idx}`}
													{@const isExpanded = expandedItems.has(rowKey)}
													{@const steps = getEstimateSteps(item.estimate)}
													<tr
														class="item-row"
														class:item-row--expanded={isExpanded}
														class:item-row--has-warnings={item.warnings.length > 0}
														onclick={(e) => {
															if ((e.target as HTMLElement).closest('input, select')) return;
															toggleExpand(rowKey);
														}}
													>
														<td><span class="badge badge--info">{item.decorationType ? statusLabel(item.decorationType) : statusLabel(item.itemType)}</span></td>
														<td class="design-cell">{item.design || '—'}</td>
														<td>{item.printLocation ? statusLabel(item.printLocation) : '—'}</td>
														<td>
															<input
																type="number"
																class="inline-input inline-input--qty"
																min="0"
																value={item.quantity}
																onchange={(e) => { item.quantity = parseInt(e.currentTarget.value) || 0; reEstimate(item); }}
															/>
														</td>
														<td>{item.inkColorCount ?? '—'}</td>
														<td>
															<select
																class="inline-select"
																value={item.weightClass}
																onchange={(e) => { item.weightClass = e.currentTarget.value as typeof item.weightClass; reEstimate(item); }}
															>
																<option value="THIN">Thin</option>
																<option value="POLY">Poly</option>
																<option value="BULKY">Bulky</option>
															</select>
														</td>
														<td class="estimate-cell-wrap">
															<span class={estimateHasError(item.estimate) ? 'estimate--warning' : 'estimate-cell'}>
																{formatEstimate(item.estimate)}
															</span>
															{#if item.warnings.length > 0}
																<span class="warning-dot" title="Click row for details"></span>
															{/if}
														</td>
													</tr>
													{#if isExpanded}
														<tr class="detail-row">
															<td colspan="7">
																<div class="detail-panel">
																	{#if item.warnings.length > 0}
																		<div class="detail-section">
																			<div class="detail-section__title">Warnings</div>
																			{#each item.warnings as w}
																				<div class="detail-warning">{w}</div>
																			{/each}
																		</div>
																	{/if}
																	{#if steps}
																		<div class="detail-section">
																			<div class="detail-section__title">Estimate Breakdown</div>
																			{#each steps as step}
																				<div class="breakdown__step">
																					<span class="breakdown__label">{step.label}</span>
																					<span class="breakdown__formula">{step.formula}</span>
																					<span class="breakdown__value">{step.minutes.toFixed(1)} min</span>
																				</div>
																			{/each}
																			<div class="breakdown__total">
																				<span class="breakdown__label">Raw total</span>
																				<span class="breakdown__value">{getRawMinutes(item.estimate) != null ? `${getRawMinutes(item.estimate)?.toFixed(1)} min` : '—'}</span>
																			</div>
																			<div class="breakdown__total breakdown__total--rounded">
																				<span class="breakdown__label">Rounded (15 min)</span>
																				<span class="breakdown__value">{formatEstimate(item.estimate)}</span>
																			</div>
																		</div>
																	{/if}
																</div>
															</td>
														</tr>
													{/if}
												{/each}
											</tbody>
											<tfoot>
												<tr class="total-row">
													<td colspan="6" class="total-label">Order Total</td>
													<td class="total-value">{formatHours(getOrderTotal(order))}</td>
												</tr>
											</tfoot>
										</table>
									</div>
								</div>
							{/each}

							<div class="form-actions">
								<button type="button" class="button--secondary" onclick={() => { showImportModal = false; editablePreview = undefined; }}>Cancel</button>
								<button type="submit" class="button">Confirm & Import</button>
							</div>
						</form>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<!-- Filter Bar -->
	{#if data.orders.length > 0}
		<div class="filter-bar">
			<input
				type="text"
				class="filter-search"
				placeholder="Search by customer or order #"
				value={filterSearch}
				oninput={(e) => { filterSearch = e.currentTarget.value; }}
			/>
			<div class="filter-chips">
				{#each ['ALL', 'NEEDS_REVIEW', 'CONFIRMED', 'SCHEDULED', 'IN_PRODUCTION', 'COMPLETE'] as s}
					<button
						class="filter-chip"
						class:filter-chip--active={filterStatus === s}
						onclick={() => { filterStatus = s; }}
					>{s === 'ALL' ? 'All' : statusLabel(s)}</button>
				{/each}
			</div>
			<span class="filter-count muted">{filteredOrders.length} of {data.orders.length}</span>
		</div>
	{/if}

	<!-- Existing Orders -->
	{#if data.orders.length === 0}
		<div class="card empty-state">
			<p class="muted">No orders yet. Click "Import CSV" to get started.</p>
		</div>
	{:else if filteredOrders.length === 0}
		<div class="card empty-state">
			<p class="muted">No orders match the current filter.</p>
		</div>
	{:else}
		{#each filteredOrders as order}
			{@const isCollapsed = collapsedOrders.has(order.id)}
			<div class="card order-card">
				<div
					class="order-header"
					class:order-header--collapsed={isCollapsed}
					role="button"
					tabindex="0"
					onclick={(e) => {
						if ((e.target as HTMLElement).closest('.order-header-actions')) return;
						toggleOrder(order.id);
					}}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOrder(order.id); } }}
				>
					<span class="order-chevron" class:order-chevron--open={!isCollapsed}>&#9656;</span>
					<div class="order-header-info">
						<h2>{order.customerName}</h2>
						<span class="muted">Hoops #{order.hoopsOrderId}</span>
					</div>
					<div class="order-header-right">
						<span class="badge {statusBadgeClass(order.status)}">{statusLabel(order.status)}</span>
						<div class="order-dates">
							<span class="muted">Ship: {new Date(order.externalShipDate).toLocaleDateString()}</span>
							<span class="muted">Due: {new Date(order.internalDueDate).toLocaleDateString()}</span>
						</div>
						<div class="order-header-actions" role="group" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
							<form method="POST" action="?/deleteOrder" use:enhance={() => {
								return async ({ update }) => {
									if (confirm(`Delete order #${order.hoopsOrderId}? This cannot be undone.`)) {
										await update();
									}
								};
							}}>
								<input type="hidden" name="orderId" value={order.id} />
								<button type="submit" class="button--danger-sm">Delete</button>
							</form>
						</div>
					</div>
				</div>

				{#if !isCollapsed}
					<div class="order-body">
						<div class="status-row">
							<form method="POST" action="?/updateStatus" use:enhance>
								<input type="hidden" name="orderId" value={order.id} />
								<input type="hidden" name="field" value="status" />
								<div class="status-group">
									<span class="status-label">Order</span>
									<select name="value" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
										{#each ['NEEDS_REVIEW', 'CONFIRMED', 'SCHEDULED', 'IN_PRODUCTION', 'COMPLETE'] as s}
											<option value={s} selected={order.status === s}>{statusLabel(s)}</option>
										{/each}
									</select>
								</div>
							</form>

							<form method="POST" action="?/updateStatus" use:enhance>
								<input type="hidden" name="orderId" value={order.id} />
								<input type="hidden" name="field" value="blankOrderingStatus" />
								<div class="status-group">
									<span class="status-label">Blanks</span>
									<select name="value" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
										{#each ['NOT_ORDERED', 'ORDERED', 'ISSUE', 'RECEIVED'] as s}
											<option value={s} selected={order.blankOrderingStatus === s}>{statusLabel(s)}</option>
										{/each}
									</select>
								</div>
							</form>

							<form method="POST" action="?/updateStatus" use:enhance>
								<input type="hidden" name="orderId" value={order.id} />
								<input type="hidden" name="field" value="customerApprovalStatus" />
								<div class="status-group">
									<span class="status-label">Customer</span>
									<select name="value" onchange={(e) => e.currentTarget.form?.requestSubmit()}>
										{#each ['NOT_SENT', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED'] as s}
											<option value={s} selected={order.customerApprovalStatus === s}>{statusLabel(s)}</option>
										{/each}
									</select>
								</div>
							</form>
						</div>

						{#if order.lineItems.length > 0}
							<div class="line-items-table-wrap">
								<table class="line-items-table">
									<thead>
										<tr>
											<th>Type</th>
											<th>Design</th>
											<th>Details</th>
											<th>Qty</th>
											<th>Status</th>
											<th>Artwork</th>
											<th>Estimate</th>
										</tr>
									</thead>
									<tbody>
										{#each order.lineItems as item}
											<tr>
												<td><span class="badge {item.itemType === 'DECORATION' ? 'badge--info' : 'badge--muted'}">{statusLabel(item.itemType)}</span></td>
												<td class="design-cell">{item.design}</td>
												<td class="details-cell">
													{#if item.decorationType}
														{statusLabel(item.decorationType)}
														{#if item.printLocation} · {statusLabel(item.printLocation)}{/if}
														{#if item.inkColorCount} · {item.inkColorCount} colors{/if}
														{#if item.screens} · {item.screens} screens{/if}
													{:else if item.finishingStep}
														{statusLabel(item.finishingStep)}
													{/if}
												</td>
												<td>{item.quantity}</td>
												<td><span class="badge {statusBadgeClass(item.status)}">{statusLabel(item.status)}</span></td>
												<td>
													{#if item.artworkApprovalStatus}
														<form method="POST" action="?/updateArtwork" use:enhance class="inline-form">
															<input type="hidden" name="lineItemId" value={item.id} />
															<select name="value" onchange={(e) => e.currentTarget.form?.requestSubmit()} class="select--sm">
																{#each ['NOT_SUBMITTED', 'PENDING_APPROVAL', 'REVISION_REQUESTED', 'APPROVED'] as s}
																	<option value={s} selected={item.artworkApprovalStatus === s}>{statusLabel(s)}</option>
																{/each}
															</select>
														</form>
													{:else}
														<span class="muted">n/a</span>
													{/if}
												</td>
												<td class={estimateHasError(item.estimatedHours) ? 'estimate--warning' : ''}>
													{formatEstimate(item.estimatedHours)}
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<style>
	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-5);
	}

	.page-header h1 {
		margin: 0;
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: var(--space-8) var(--space-4);
		overflow-y: auto;
	}

	.modal {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		width: 100%;
		max-width: 56rem;
		max-height: calc(100vh - 4rem);
		display: flex;
		flex-direction: column;
		box-shadow: 0 24px 48px rgba(0, 0, 0, 0.3);
	}

	.modal__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-5);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.modal__header h2 {
		margin: 0;
		font-size: var(--fs-lg);
	}

	.modal__close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-500);
		font-size: 1.5rem;
		cursor: pointer;
		transition: color var(--motion-fast) var(--ease-standard),
			background var(--motion-fast) var(--ease-standard);
	}

	.modal__close:hover {
		color: var(--ink-900);
		background: var(--warm-100);
	}

	.modal__body {
		padding: var(--space-4) var(--space-5);
		overflow-y: auto;
		flex: 1;
	}

	.drop-zone {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-8) var(--space-5);
		border: 2px dashed var(--border);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: border-color var(--motion-fast) var(--ease-standard),
			background var(--motion-fast) var(--ease-standard);
	}

	.drop-zone:hover,
	.drop-zone--active {
		border-color: var(--warm-500);
		background: var(--warm-50);
	}

	.drop-zone__icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: var(--radius-md);
		background: var(--warm-100);
		color: var(--warm-600);
		font-size: var(--fs-sm);
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.drop-zone__text {
		font-weight: 600;
		color: var(--ink-900);
	}

	.drop-zone__hint {
		font-size: var(--fs-xs);
		text-align: center;
		max-width: 36rem;
	}


	.preview-order {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: var(--space-4);
		margin: var(--space-4) 0;
		background: var(--warm-50);
	}

	.preview-order h3 {
		margin-top: 0;
		color: var(--warm-600);
	}

	.form-grid {
		display: grid;
		gap: var(--space-3);
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		margin-bottom: var(--space-4);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.field__label {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--ink-700);
	}

	.field input {
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: var(--fs-sm);
		color: var(--ink-900);
	}

	.field input:focus {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-500);
	}

	.warnings {
		margin-bottom: var(--space-3);
	}

	.warning-item {
		font-size: var(--fs-xs);
		color: var(--danger-fg);
		padding: var(--space-1) 0;
	}

	.warning-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		background: var(--danger-bg);
		color: var(--danger-fg);
		font-size: var(--fs-xs);
		font-weight: 700;
		cursor: help;
	}

	.form-actions {
		display: flex;
		gap: var(--space-3);
		margin-top: var(--space-4);
		justify-content: flex-end;
	}

	.order-card {
		margin-bottom: var(--space-4);
	}

	.filter-bar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
		flex-wrap: wrap;
	}

	.filter-search {
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: var(--fs-sm);
		color: var(--ink-900);
		width: 14rem;
	}

	.filter-search:focus {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-500);
	}

	.filter-search::placeholder {
		color: var(--ink-400);
	}

	.filter-chips {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.filter-chip {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border);
		border-radius: 999px;
		background: transparent;
		font: inherit;
		font-size: var(--fs-xs);
		color: var(--ink-500);
		cursor: pointer;
		transition: all var(--motion-fast) var(--ease-standard);
		white-space: nowrap;
	}

	.filter-chip:hover {
		border-color: var(--warm-400);
		color: var(--warm-600);
	}

	.filter-chip--active {
		background: var(--warm-500);
		border-color: var(--warm-500);
		color: white;
	}

	.filter-chip--active:hover {
		background: var(--warm-600);
		border-color: var(--warm-600);
		color: white;
	}

	.filter-count {
		font-size: var(--fs-xs);
		margin-left: auto;
	}

	.order-header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: 0;
		border: none;
		background: transparent;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		margin-bottom: var(--space-3);
		transition: opacity var(--motion-fast) var(--ease-standard);
	}

	.order-header--collapsed {
		margin-bottom: 0;
	}

	.order-chevron {
		font-size: 1.2rem;
		color: var(--ink-500);
		transition: transform var(--motion-fast) var(--ease-standard);
		flex-shrink: 0;
		line-height: 1;
	}

	.order-chevron--open {
		transform: rotate(90deg);
	}

	.order-header-info {
		flex: 1;
		min-width: 0;
	}

	.order-header-info h2 {
		margin: 0 0 var(--space-1);
		font-size: var(--fs-lg);
	}

	.order-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		flex-shrink: 0;
	}

	.order-header-actions {
		display: contents;
	}

	.order-dates {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-1);
		font-size: var(--fs-sm);
	}

	.order-body {
		padding-left: calc(1.2rem + var(--space-3));
	}

	.button--danger-sm {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--danger-fg);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--danger-fg);
		font: inherit;
		font-size: var(--fs-xs);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--motion-fast) var(--ease-standard);
	}

	.button--danger-sm:hover {
		background: var(--danger-bg);
	}

	.status-row {
		display: flex;
		gap: var(--space-4);
		flex-wrap: wrap;
		margin-bottom: var(--space-4);
		padding: var(--space-3);
		background: var(--warm-50);
		border-radius: var(--radius-sm);
	}

	.status-group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.status-label {
		font-size: var(--fs-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-500);
		white-space: nowrap;
	}

	.status-group select {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: var(--fs-xs);
		color: var(--ink-900);
	}

	.line-items-table-wrap {
		overflow-x: auto;
	}

	.line-items-table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-sm);
	}

	.line-items-table th {
		text-align: left;
		padding: var(--space-2) var(--space-3);
		border-bottom: 2px solid var(--border);
		font-size: var(--fs-xs);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-500);
		white-space: nowrap;
	}

	.line-items-table td {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}

	.design-cell {
		max-width: 20rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.details-cell {
		font-size: var(--fs-xs);
		color: var(--ink-700);
	}

	.mono {
		font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
		font-size: var(--fs-xs);
	}

	.badge {
		display: inline-block;
		padding: 0.1em 0.5em;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 600;
		white-space: nowrap;
	}

	.badge--success {
		background: var(--success-bg);
		color: var(--success-fg);
	}

	.badge--danger {
		background: var(--danger-bg);
		color: var(--danger-fg);
	}

	.badge--info {
		background: color-mix(in srgb, var(--warm-200) 50%, transparent);
		color: var(--warm-700);
	}

	.badge--muted {
		background: var(--warm-100);
		color: var(--ink-500);
	}

	.inline-input {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: var(--fs-sm);
		color: var(--ink-900);
		width: 100%;
	}

	.inline-input:focus {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-500);
	}

	.inline-input--qty {
		width: 4.5rem;
	}

	.inline-select {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: var(--fs-xs);
		color: var(--ink-900);
	}

	.inline-select:focus {
		outline: none;
		box-shadow: var(--focus);
		border-color: var(--warm-500);
	}

	.estimate-cell {
		font-weight: 600;
	}

	.estimate-cell-wrap {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.estimate--warning {
		color: var(--danger-fg);
		font-size: var(--fs-xs);
	}

	.warning-dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--danger-fg);
		flex-shrink: 0;
	}

	.item-row {
		cursor: pointer;
		transition: background var(--motion-fast) var(--ease-standard);
	}

	.item-row:hover {
		background: color-mix(in srgb, var(--warm-100) 40%, transparent);
	}

	.item-row--expanded td {
		border-bottom-color: transparent;
	}

	.item-row--has-warnings {
		border-left: 3px solid var(--danger-fg);
	}

	.detail-row td {
		padding: 0 var(--space-3) var(--space-3);
		border-bottom: 1px solid var(--border);
	}

	.detail-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		max-width: 32rem;
		margin-left: var(--space-3);
	}

	.detail-section {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: var(--space-3);
		font-size: var(--fs-xs);
	}

	.detail-section__title {
		font-weight: 700;
		font-size: var(--fs-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-500);
		margin-bottom: var(--space-2);
	}

	.detail-warning {
		padding: var(--space-2);
		background: var(--danger-bg);
		color: var(--danger-fg);
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		line-height: 1.4;
	}

	.detail-warning + .detail-warning {
		margin-top: var(--space-1);
	}

	.breakdown__step {
		display: grid;
		grid-template-columns: 8rem 1fr auto;
		gap: var(--space-2);
		padding: var(--space-1) 0;
		border-bottom: 1px solid var(--border);
	}

	.breakdown__label {
		font-weight: 600;
		color: var(--ink-700);
	}

	.breakdown__formula {
		color: var(--ink-500);
		font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
	}

	.breakdown__value {
		text-align: right;
		font-weight: 600;
		color: var(--ink-900);
	}

	.breakdown__total {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: var(--space-2);
		padding: var(--space-2) 0 0;
		font-weight: 600;
		color: var(--ink-700);
		border-top: 1px solid var(--border);
	}

	.breakdown__total--rounded {
		font-weight: 700;
		color: var(--warm-600);
		border-top: none;
		padding-top: var(--space-1);
	}

	.total-row td {
		border-top: 2px solid var(--border);
		border-bottom: none;
		padding: var(--space-3);
	}

	.total-label {
		text-align: right;
		font-weight: 700;
		font-size: var(--fs-sm);
		color: var(--ink-700);
	}

	.total-value {
		font-weight: 700;
		font-size: var(--fs-sm);
		color: var(--warm-600);
	}

	.inline-form {
		display: inline;
	}

	.select--sm {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		font: inherit;
		font-size: var(--fs-xs);
		color: var(--ink-900);
	}

	.empty-state {
		text-align: center;
		padding: var(--space-8);
	}

	.alert--success {
		background: var(--success-bg);
		color: var(--success-fg);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-sm);
		margin-bottom: var(--space-4);
	}
</style>
