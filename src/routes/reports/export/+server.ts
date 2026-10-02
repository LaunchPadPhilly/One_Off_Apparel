import { error } from '@sveltejs/kit';
import { requireScopePage } from '$lib/server/auth/guards';
import { getReportData } from '$lib/server/reports/getReportData';
import type { RequestHandler } from './$types';

function csvEscape(value: unknown) {
	const str = String(value ?? '');
	return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** CSV export of the estimate-vs-actual line-item variance report — the one metric
 *  CLAUDE.md's Reports ask specifically named ("export the metrics"). */
export const GET: RequestHandler = async ({ locals, url }) => {
	requireScopePage(locals.user, 'REPORTS_READ', url.pathname);

	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	if (!from || !to) throw error(400, 'from and to query params are required');

	const { lineItemVariance } = await getReportData({ from, to });

	const header = 'design,station,estimated_hours,actual_hours,variance_hours';
	const rows = lineItemVariance.map((row) =>
		[row.design, row.stationName, row.estimatedHours, row.actualHours, row.varianceHours.toFixed(2)].map(csvEscape).join(',')
	);

	return new Response([header, ...rows].join('\n'), {
		headers: {
			'content-type': 'text/csv',
			'content-disposition': `attachment; filename="estimate-accuracy-${from}-to-${to}.csv"`
		}
	});
};
