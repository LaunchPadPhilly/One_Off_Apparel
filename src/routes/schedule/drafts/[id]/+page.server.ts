import { error } from '@sveltejs/kit';
import { requireScopePage } from '$lib/server/auth/guards';
import { getDraft } from '$lib/server/schedule/draft';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_READ', url.pathname);
	const draft = await getDraft(params.id);
	if (!draft) throw error(404, 'Schedule draft not found');
	return {
		draft: {
			id: draft.id,
			name: draft.name,
			description: draft.description,
			startDate: draft.startDate.toISOString().slice(0, 10),
			weeks: draft.weeks,
			strategy: draft.strategy,
			status: draft.status,
			createdBy: draft.createdBy,
			createdAt: draft.createdAt.toISOString()
		}
	};
};
