import { storageKeyPrefix } from '$lib/appConfig';
import { Spring, Tween, prefersReducedMotion } from 'svelte/motion';
import { cubicOut } from 'svelte/easing';

/**
 * Single source of truth for the app's motion language. Every animated
 * component should build on these instead of inventing its own durations,
 * easings, or ad hoc Tween/Spring calls — that's what keeps every number,
 * chart, and transition feeling like one consistent system.
 *
 * Numeric mirrors of the CSS tokens in src/app.css (--motion-fast/base/slow,
 * --ease-standard) — keep both in sync if either changes.
 */
export const DURATION = {
	fast: 120,
	base: 220,
	slow: 360
} as const;

export const EASE = {
	standard: cubicOut
} as const;

const REDUCE_MOTION_KEY = `${storageKeyPrefix}reduceMotion`;

/**
 * Wraps Svelte's built-in prefers-reduced-motion flag (svelte/motion, since
 * 5.7) with an explicit in-app override (Settings > Accessibility) — 'on'
 * always minimizes motion, 'off' always animates even if the OS asks for
 * reduced motion, and no override (the default) just follows the OS. `.current`
 * is what every animation helper below actually reads; `.override` is only for
 * the Settings picker to know which option is currently selected.
 */
class ReducedMotionOverride {
	#override: 'on' | 'off' | null = null;

	constructor() {
		if (typeof window === 'undefined') return;
		try {
			const saved = localStorage.getItem(REDUCE_MOTION_KEY);
			if (saved === 'on' || saved === 'off') this.#override = saved;
		} catch {
			// localStorage unavailable — just follow the OS setting.
		}
	}

	get override() {
		return this.#override;
	}

	get current() {
		if (this.#override === 'on') return true;
		if (this.#override === 'off') return false;
		return prefersReducedMotion.current;
	}

	set(value: 'on' | 'off' | null) {
		this.#override = value;
		if (typeof window === 'undefined') return;
		try {
			if (value === null) localStorage.removeItem(REDUCE_MOTION_KEY);
			else localStorage.setItem(REDUCE_MOTION_KEY, value);
		} catch {
			// localStorage unavailable — the choice just won't persist across reloads.
		}
	}
}

export const reducedMotion = new ReducedMotionOverride();

/**
 * Animated stat/chart-value. Returns a real `Tween` instance — read
 * `.current` in markup, call `.set(next)` whenever the source value
 * changes (typically from an `$effect`). Duration is re-evaluated on every
 * `.set()`, so it keeps respecting live changes to the OS reduced-motion
 * setting rather than freezing it at creation time.
 */
export function animatedNumber(initial: number, duration: number = DURATION.base) {
	return new Tween(initial, {
		easing: EASE.standard,
		duration: () => (reducedMotion.current ? 0 : duration)
	});
}

/**
 * Spring-driven value for interactive motion (button press scale, tab
 * indicator position, hover-lift). Reduced-motion is baked in at creation
 * (a stiff, undamped spring settles in ~1 frame) since Spring's
 * stiffness/damping aren't re-evaluated per animation the way Tween's
 * duration is.
 */
export function animatedValue<T>(initial: T, opts: { stiffness?: number; damping?: number } = {}) {
	return new Spring(initial, {
		stiffness: reducedMotion.current ? 1 : opts.stiffness ?? 0.15,
		damping: reducedMotion.current ? 1 : opts.damping ?? 0.6
	});
}

/**
 * Drives the "grow in on mount" effect shared by every chart card. Callers
 * multiply their target bar/line values by `.current` (0→1). Server-rendered
 * markup stays at 0 (charts render empty before JS runs, same spirit as a
 * skeleton state) — only the browser schedules the animate-to-1.
 */
export function revealProgress(delayMs = 0) {
	const tween = new Tween(0, {
		easing: EASE.standard,
		duration: () => (reducedMotion.current ? 0 : DURATION.slow)
	});
	if (typeof window !== 'undefined') {
		setTimeout(() => tween.set(1), reducedMotion.current ? 0 : delayMs);
	}
	return tween;
}

/** Shared enter/exit transition options for `{#key screen}` blocks. */
export const screenEnter = { duration: DURATION.base, easing: EASE.standard, y: 8 };
export const screenExit = { duration: DURATION.fast, easing: EASE.standard };
