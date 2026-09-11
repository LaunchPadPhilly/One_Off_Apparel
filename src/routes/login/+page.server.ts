import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return {
		devLoginEnabled:
			process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED === 'true'
	};
};
