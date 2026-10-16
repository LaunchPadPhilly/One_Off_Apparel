import { error, json } from '@sveltejs/kit';
import { hasGrantedScope } from '$lib/server/auth/guards';
import { prisma } from '$lib/server/prisma';
import type { RequestHandler } from './$types';

/**
 * Edits Claude made to this draft since `after` (2026-10-16) — the board polls this so a
 * person looking at the draft sees a pop-up of what Claude changed, including every
 * other job it had to move to make room (draftEdit.ts writes these `draft_edited`
 * entries). Read-only.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Sign in first.');
	if (!hasGrantedScope(locals.user, 'SCHEDULE_READ')) throw error(403, 'Not allowed.');
	const afterParam = url.searchParams.get('after');
	const after = afterParam ? new Date(afterParam) : new Date();
	if (Number.isNaN(after.getTime())) throw error(400, 'Bad "after" time.');

	const rows = await prisma.domainAuditLog.findMany({
		where: { entity: 'ScheduleDraft', entityId: params.id, action: 'draft_edited', at: { gt: after } },
		orderBy: { at: 'asc' },
		take: 50,
		select: { at: true, actor: true, diff: true }
	});
	return json({
		now: new Date().toISOString(),
		edits: rows.map((row) => {
			const diff = (row.diff ?? {}) as { summary?: string; changes?: string[]; via?: string };
			return { at: row.at.toISOString(), actor: row.actor, via: diff.via ?? 'claude', summary: diff.summary ?? 'Changed this draft', changes: diff.changes ?? [] };
		})
	});
};
