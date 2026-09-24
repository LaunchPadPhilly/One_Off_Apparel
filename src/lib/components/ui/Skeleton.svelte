<script lang="ts">
	/**
	 * Reusable shimmer placeholder shown in place of content while a card is loading.
	 * Shape is controlled via width/height/radius so callers can match their own layout
	 * (a stat number, a chart track, a line of text, an avatar circle, etc.).
	 */
	let {
		width = '100%',
		height = '1rem',
		radius,
		circle = false
	}: {
		width?: string;
		height?: string;
		radius?: string;
		circle?: boolean;
	} = $props();
</script>

<span
	class="skeleton"
	style:width
	style:height
	style:border-radius={circle ? '50%' : (radius ?? 'var(--radius)')}
	aria-hidden="true"
></span>

<style>
	.skeleton {
		display: inline-block;
		background: linear-gradient(
			90deg,
			var(--brand-100) 25%,
			var(--brand-200) 37%,
			var(--brand-100) 63%
		);
		background-size: 400% 100%;
		animation: skeleton-shimmer 1.4s ease infinite;
	}

	@keyframes skeleton-shimmer {
		0% {
			background-position: 100% 50%;
		}
		100% {
			background-position: 0 50%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
			background: var(--brand-100);
		}
	}
</style>
