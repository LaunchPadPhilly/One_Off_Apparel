import { requireScopePage } from '$lib/server/auth/guards';
import { getReportData } from '$lib/server/reports/getReportData';
import type { PageServerLoad } from './$types';

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

	return { from, to, ...report };
};
