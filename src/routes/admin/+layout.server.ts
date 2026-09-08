import { error, redirect } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/api/auth/google/login?redirectTo=${encodeURIComponent(url.pathname)}`);
	}

	const isAdmin = locals.user.roles.some((userRole) => userRole.role.name === 'ADMIN');
	if (!isAdmin) {
		await prisma.auditEvent
			.create({
				data: {
					actorId: locals.user.id,
					action: 'admin_access_denied',
					resource: 'AdminUI',
					metadata: { path: url.pathname }
				}
			})
			.catch(() => {});
		throw error(403, 'Admin access required');
	}

	return { user: { email: locals.user.email, displayName: locals.user.displayName } };
};
