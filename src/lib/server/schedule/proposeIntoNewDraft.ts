/**
 * Backs the "Create automatic schedule" button on /schedule (routes/schedule/+page.server.ts):
 * makes a new draft and fills it with the deterministic engine's proposal. Key rule:
 * everything it writes is PROPOSED and attached to the new draft — nothing is approved
 * until a person approves it.
 */
import { proposeIntoDraft } from './proposeAndPersistSchedule';
import type { DateRange } from './types';

/** A Date as its "YYYY-MM-DD" UTC day. */
function iso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" plus `days` calendar days, as "YYYY-MM-DD". */
function addDays(isoDate: string, days: number): string {
	const date = new Date(`${isoDate}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return iso(date);
}

// "3-4 weeks out" — the same window CLAUDE.md's Production Board section already picked
// (its 28-day default) for showing what's coming up; reused here as the automatic
// schedule's window rather than inventing a second convention.
const AUTOMATIC_SCHEDULE_WEEKS = 4;

/** What the button reports back: the new draft's id and how many jobs did / didn't fit. */
export interface ProposeIntoNewDraftResult {
	draftId: string;
	placedCount: number;
	atRiskCount: number;
	reasoning: string[];
}

/**
 * "Create automatic schedule" — a brand-new ScheduleDraft populated straight from the
 * deterministic propose_schedule engine (fetchBacklog + fetchStaffedCapacity + proposeSchedule),
 * the exact same engine the propose_schedule MCP tool already calls when Claude runs it
 * in conversation. No LLM decides any placement here — CLAUDE.md's non-negotiable design
 * principle ("Claude never computes hours or schedules itself") applies just as much to
 * this button as it does to chat. This only wires that existing engine into the drafts
 * workspace, which previously supported manual placement only: its output now lands in
 * an editable, reviewable draft (scheduleDraftId set on every row) instead of loose
 * PROPOSED rows with no draft at all. Since 2026-10-05 this and the `propose_schedule`
 * MCP tool share proposeIntoDraft(): both plan around the committed schedule (approved
 * jobs keep their slots and hours; see committedWork.ts) instead of re-placing it.
 *
 * fetchBacklog() already enforces every scheduling gate (order CONFIRMED, deadline today
 * or later — see its doc comment for the full, current list) — this function does not
 * add or loosen any of that.
 *
 * The window is always today plus AUTOMATIC_SCHEDULE_WEEKS (UTC days).
 *
 * @param actor - who clicked the button (draft creator, proposedBy, audit log)
 */
export async function proposeIntoNewDraft(actor: string): Promise<ProposeIntoNewDraftResult> {
	const startIso = iso(new Date());
	const endIso = addDays(startIso, AUTOMATIC_SCHEDULE_WEEKS * 7 - 1);
	const range: DateRange = { from: startIso, to: endIso };

	// The button only places new work: nothing already approved moves (release: null).
	const result = await proposeIntoDraft({
		range,
		release: null,
		name: `Automatic schedule — ${startIso}`,
		description: 'Proposed by the propose_schedule engine from confirmed orders, around the approved schedule.',
		actor
	});

	return {
		draftId: result.draftId,
		placedCount: result.placedCount,
		atRiskCount: result.atRisk.length,
		reasoning: result.reasoning
	};
}
