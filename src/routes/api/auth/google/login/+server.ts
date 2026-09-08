import { redirect, type RequestHandler } from '@sveltejs/kit';
import { createOAuthState } from '$lib/server/oauthState';
import {
	createGoogleAuthorizationUrl,
	googleOAuthStateCookie,
	googleRedirectCookie
} from '$lib/server/auth/google';

export const GET: RequestHandler = ({ cookies, url }) => {
	const state = createOAuthState(cookies, googleOAuthStateCookie);

	const requestedRedirect = url.searchParams.get('redirectTo');
	const redirectTo = isSafeInternalPath(requestedRedirect) ? requestedRedirect : '/';
	cookies.set(googleRedirectCookie.name, redirectTo, {
		path: googleRedirectCookie.path,
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 600
	});

	throw redirect(302, createGoogleAuthorizationUrl(state));
};

function isSafeInternalPath(path: string | null): path is string {
	return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}
