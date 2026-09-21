import { fail, redirect } from '@sveltejs/kit';
import { requireScopePage } from '$lib/server/auth/guards';
import { createDraft, createDraftSchema } from '$lib/server/schedule/draft';
import { ScheduleStrategy } from '../../../../prisma/generated/prisma/enums';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
	return {};
};

export const actions: Actions = {
	create: async ({ request, locals, url }) => {
		const user = requireScopePage(locals.user, 'SCHEDULE_WRITE', url.pathname);
		const data = await request.formData();

		const raw = {
			name: String(data.get('name') ?? '').trim(),
			description: (() => {
				const value = String(data.get('description') ?? '').trim();
				return value.length === 0 ? null : value;
			})(),
			startDate: String(data.get('startDate') ?? ''),
			weeks: Number(data.get('weeks')),
			strategy: (String(data.get('strategy') ?? '') || ScheduleStrategy.BATCH_OPTIMIZE) as ScheduleStrategy
		};

		const parsed = createDraftSchema.safeParse(raw);
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues.map((issue) => issue.message).join('; '),
				values: raw
			});
		}

		let draft;
		try {
			draft = await createDraft(parsed.data, user.email);
		} catch (error) {
			return fail(500, { message: (error as Error).message, values: raw });
		}

		throw redirect(303, `/schedule/drafts/${draft.id}`);
	}
};
