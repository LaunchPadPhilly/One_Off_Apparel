import { WORKING_HOURS } from './shift';

/**
 * The stand-in capacity assumption used until a shop's real Station/CapacityCalendar
 * data exists (see CLAUDE.md's Known open items — "no station or its daily capacity
 * has ever been entered"). `KNOWN_STATIONS` mirrors the six stations CLAUDE.md's engine
 * section documents (screen print, embroidery, matte, fold & bag, hang tag, relabel).
 *
 * `DEFAULT_STATION_DAY_HOURS` is `WORKING_HOURS` from shift.ts, re-exported under this
 * name rather than redefined — the drafts workspace's timeline already assumes "one
 * standard 8:00–16:30 shift" worth of hours (7.5h) whenever no real CapacityCalendar
 * row exists for a given day, purely as a display fallback so the grid isn't blank.
 * `fetchCapacity()` (buildBacklogAndCapacity.ts) now assumes the exact same number for
 * the same reason, so what a human sees on the timeline and what the deterministic
 * engine actually schedules against can never quietly diverge into two conventions.
 *
 * This is a real, visible business assumption, not an invented fact: every known
 * station is treated as open every single day of a draft's window (including
 * weekends, matching the timeline's existing display convention) until someone enters
 * real capacity data. A real CapacityCalendar row always overrides this default the
 * moment one exists for that (station, day).
 */
export const KNOWN_STATIONS = [
	'screen_print_auto',
	'embroidery',
	'matte_finish',
	'fold_bag',
	'hang_tags',
	'printed_relabel'
] as const;

export const DEFAULT_STATION_DAY_HOURS = WORKING_HOURS;
