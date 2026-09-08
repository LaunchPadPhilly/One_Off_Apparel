import '$lib/server/load-local-env';

import type { Handle } from '@sveltejs/kit';
import { sessionCookieName, getSessionUser } from '$lib/server/auth/session';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(sessionCookieName);
	event.locals.user = await getSessionUser(token);
	return resolve(event);
};
