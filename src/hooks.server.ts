import '$lib/server/load-local-env';

import type { Handle } from '@sveltejs/kit';
import { sessionCookieName, getSessionUser } from '$lib/server/auth/session';
import { reloadFormulas } from '$lib/server/engine/formulaSettings';

// Load the editable estimate_hours formula overrides once at server startup so the
// first estimate call (which is sync — see estimateHours.ts) has fresh values, not the
// hardcoded defaults. Subsequent refreshes are TTL-driven from within estimateHours.
// Fire-and-forget: if the DB isn't reachable yet, `reloadFormulas` swallows the error
// and leaves the default cache in place; the first successful call refreshes it.
void reloadFormulas();

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(sessionCookieName);
	event.locals.user = await getSessionUser(token);
	return resolve(event);
};
