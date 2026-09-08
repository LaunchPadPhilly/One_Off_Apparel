import { animatedValue } from '$lib/motion';

/**
 * `use:pressable` — the tactile "click" half of the motion system. Drives a
 * spring-settled scale-down-on-press, scale-back-on-release via the
 * `--press-scale` custom property, so it composes with whatever CSS
 * transform a component already applies on hover (e.g.
 * `transform: translateY(-1px) scale(var(--press-scale, 1));`) instead of
 * clobbering it the way setting `style.transform` directly would.
 *
 * Hover color/elevation stays plain CSS (cheaper, smoother for that case);
 * this action only covers the pointerdown/up feedback svelte/motion is
 * actually better suited for.
 *
 * Uses `$effect.root` because this file (note the `.svelte.ts` extension)
 * runs outside component initialization — actions are plain functions, not
 * components, so runes here need an explicit effect root rather than
 * relying on one already being open.
 */
export function pressable(node: HTMLElement, params: { scale?: number } = {}) {
	const targetScale = params.scale ?? 0.96;
	const scale = animatedValue(1, { stiffness: 0.35, damping: 0.55 });

	const disposeEffect = $effect.root(() => {
		$effect(() => {
			node.style.setProperty('--press-scale', String(scale.current));
		});
	});

	function press() {
		scale.target = targetScale;
	}
	function release() {
		scale.target = 1;
	}

	node.addEventListener('pointerdown', press);
	node.addEventListener('pointerup', release);
	node.addEventListener('pointerleave', release);
	node.addEventListener('pointercancel', release);

	return {
		destroy() {
			disposeEffect();
			node.removeEventListener('pointerdown', press);
			node.removeEventListener('pointerup', release);
			node.removeEventListener('pointerleave', release);
			node.removeEventListener('pointercancel', release);
		}
	};
}
