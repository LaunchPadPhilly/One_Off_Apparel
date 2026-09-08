<script lang="ts">
	import { animatedNumber } from '$lib/motion';

	/**
	 * Renders a number that tweens from its previous value to the next one
	 * whenever `value` changes, instead of jump-cutting — used by StatCard
	 * and anywhere else a headline number should feel alive rather than
	 * static. Non-numeric displays ("—", a tier label, etc.) don't go
	 * through this component at all — callers render those directly.
	 */
	let { value, format = (n: number) => String(Math.round(n)) }: { value: number; format?: (n: number) => string } =
		$props();

	// Deliberately captures only the initial `value` as the Tween's starting point (so
	// SSR/first paint renders the real number, not a placeholder 0) — the $effect below
	// is what keeps it reactive to every later change.
	// svelte-ignore state_referenced_locally
	const tween = animatedNumber(value);

	$effect(() => {
		tween.set(value);
	});
</script>

<span>{format(tween.current)}</span>
