import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { hasGrantedScope, requireScopePage } from '$lib/server/auth/guards';
import { getReportData } from '$lib/server/reports/getReportData';
import { explainScheduleChange, ScheduleChangeNoteError } from '$lib/server/schedule/changeNotes';
import type { Actions, PageServerLoad } from './$types';

function isoDate(date: Date) {
	return date.toISOString().slice(0, 10);
}

/**
 * Reports (minimal) — see CLAUDE.md's Known open items for what this deliberately
 * doesn't include yet. Gated on REPORTS_READ, the scope this template already ships.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'REPORTS_READ', url.pathname);

	const today = new Date();
	const defaultFrom = new Date(today);
	defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);

	const from = url.searchParams.get('from') ?? isoDate(defaultFrom);
	const to = url.searchParams.get('to') ?? isoDate(today);

	const report = await getReportData({ from, to });

	// Answering "why did the approved schedule change?" is a schedule write.
	return { from, to, canExplainChanges: hasGrantedScope(locals.user, 'SCHEDULE_WRITE'), ...report };
};

const explainChangeSchema = z.object({
	changeId: z.string().trim().min(1, 'Which change is this for?'),
	reason: z.string().trim().min(1, 'Write down why it changed.').max(2000, 'Keep it under 2000 characters.')
});

export const actions: Actions = {
	// A person's answer to "why did the approved schedule change?" (schedule/changeNotes.ts).
	explainChange: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const form = await request.formData();
		const parsed = explainChangeSchema.safeParse({ changeId: form.get('changeId') ?? '', reason: form.get('reason') ?? '' });
		const changeId = typeof form.get('changeId') === 'string' ? (form.get('changeId') as string) : null;
		if (!parsed.success) return fail(400, { changeId, message: parsed.error.issues[0]?.message ?? 'Check the reason and try again.' });
		try {
			await explainScheduleChange(parsed.data.changeId, parsed.data.reason, user.email);
		} catch (err) {
			if (err instanceof ScheduleChangeNoteError) return fail(400, { changeId, message: err.message });
			throw err;
		}
		return { explainedChangeId: parsed.data.changeId };
	}
};
