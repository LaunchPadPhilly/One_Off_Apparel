import { WORKING_HOURS } from './shift';

/**
 * The stand-in capacity assumption used until a shop's real CapacityCalendar data
 * exists (see CLAUDE.md's Known open items — "no station or its daily capacity has
 * ever been entered").
 *
 * `DEFAULT_STATION_DAY_HOURS` is `WORKING_HOURS` from shift.ts, re-exported under this
 * name rather than redefined — the drafts workspace's timeline already assumes "one
 * standard 8:00–16:30 shift" worth of hours (7.5h) whenever no real CapacityCalendar
 * row exists for a given day, purely as a display fallback so the grid isn't blank.
 * `fetchCapacity()` (buildBacklogAndCapacity.ts) now assumes the exact same number for
 * the same reason, so what a human sees on the timeline and what the deterministic
 * engine actually schedules against can never quietly diverge into two conventions.
 *
 * This is a real, visible business assumption, not an invented fact: every active
 * station is treated as open every single day of a draft's window (including
 * weekends, matching the timeline's existing display convention) until someone enters
 * real capacity data. A real CapacityCalendar row always overrides this default the
 * moment one exists for that (station, day).
 *
 * Which stations exist is no longer a hard-coded list here (2026-09-25): admins manage
 * Station rows at /settings?screen=stations, and each station's formula comes from its
 * `kind` (see stationKinds.ts).
 */
export const DEFAULT_STATION_DAY_HOURS = WORKING_HOURS;
