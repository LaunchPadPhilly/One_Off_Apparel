import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		return {
			signedIn: false as const,
			devLoginEnabled:
				process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED === 'true'
		};
	}

	// The template has no domain landing page yet. Once the client's first data page
	// exists, redirect signed-in users there: `throw redirect(303, '/reports')`.
	return {
		signedIn: true as const,
		isAdmin: locals.user.roles.some((userRole) => userRole.role.name === 'ADMIN')
	};
};
