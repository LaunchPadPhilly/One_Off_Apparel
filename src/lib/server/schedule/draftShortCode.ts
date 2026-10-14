/**
 * DB-dependent resolver for the short draft codes defined in $lib/schedule/shortDraftCode.ts.
 * cuids are opaque and 25 chars long — nobody wants to read one aloud or paste one into
 * chat; names collide ("Automatic schedule — 2026-10-14" repeats on same-day auto-drafts).
 * The pure, client-safe derivation (`shortDraftCode`) lives in the client module so UI
 * code can use it without pulling the Prisma client; this module adds the DB lookup that
 * the MCP tool handlers call to accept either a full cuid or a 6-char code.
 */
import { prisma } from '$lib/server/prisma';
export { shortDraftCode } from '$lib/schedule/shortDraftCode';

/**
 * Accepts a full cuid or a 6-char short code and returns the matching draft's full id,
 * or null if no draft matches. If a short code happens to match more than one draft,
 * returns the string "AMBIGUOUS" so the caller can tell the user to use the full id.
 */
export async function resolveDraftIdOrShortCode(idOrCode: string): Promise<string | null | 'AMBIGUOUS'> {
	const trimmed = idOrCode.trim();
	if (trimmed.length === 0) return null;
	// A real cuid is longer than 6 chars; treat anything else as a short-code attempt.
	if (trimmed.length > 6) {
		const exact = await prisma.scheduleDraft.findUnique({ where: { id: trimmed }, select: { id: true } });
		return exact?.id ?? null;
	}
	const lower = trimmed.toLowerCase();
	const matches = await prisma.scheduleDraft.findMany({
		where: { id: { endsWith: lower } },
		select: { id: true }
	});
	if (matches.length === 0) return null;
	if (matches.length > 1) return 'AMBIGUOUS';
	return matches[0].id;
}
