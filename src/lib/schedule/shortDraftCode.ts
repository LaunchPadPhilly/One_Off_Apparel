/**
 * A short, human-readable identifier derived from a ScheduleDraft's cuid — the last 6
 * characters, uppercased (e.g. "AB3C9F"). Pure function; the DB-dependent resolver that
 * accepts the same code lives in $lib/server/schedule/draftShortCode.ts.
 *
 * Shown on the Schedule page's draft cards and the draft detail page header so a human
 * can refer to a specific draft when same-day auto-drafts collide on name
 * ("Automatic schedule — 2026-10-14" repeats), and so Claude in chat can read it off
 * the UI and plug it into any draft-id-taking MCP tool.
 */
export function shortDraftCode(id: string): string {
	return id.slice(-6).toUpperCase();
}
