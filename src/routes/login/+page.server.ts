import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return {
		devLoginEnabled: env.DEV_LOGIN_ENABLED === 'true' && process.env.NODE_ENV !== 'production'
	};
};
