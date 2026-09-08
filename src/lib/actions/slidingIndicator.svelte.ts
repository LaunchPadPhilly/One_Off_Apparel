import { animatedValue } from '$lib/motion';

/**
 * Shared "measure the active item, spring a pill behind it" logic used by
 * both the top-level nav (real `<a>` navigation) and TabBar (in-page screen
 * switching) — same visual mechanism, different navigation semantics, so
 * this factors out just the measuring/animating part rather than forcing
 * both call sites through one component.
 */
export function createSlidingIndicator(opts: { stiffness?: number; damping?: number } = {}) {
	let container: HTMLElement | undefined;
	const items = new Map<string, HTMLElement>();
	const indicator = animatedValue(
		{ x: 0, width: 0 },
		{ stiffness: opts.stiffness ?? 0.28, damping: opts.damping ?? 0.62 }
	);
	let activeKey = '';

	function measure() {
		const el = items.get(activeKey);
		if (!el || !container) return;
		const containerRect = container.getBoundingClientRect();
		const rect = el.getBoundingClientRect();
		indicator.target = { x: rect.left - containerRect.left, width: rect.width };
	}

	function setContainer(node: HTMLElement) {
		container = node;
		measure();
		return {
			destroy() {
				if (container === node) container = undefined;
			}
		};
	}

	function setActive(key: string) {
		activeKey = key;
		measure();
	}

	function register(node: HTMLElement, key: string) {
		items.set(key, node);
		measure();
		return {
			destroy() {
				if (items.get(key) === node) items.delete(key);
			}
		};
	}

	return { indicator, setContainer, setActive, register, measure };
}
