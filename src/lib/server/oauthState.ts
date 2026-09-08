import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';

export type OAuthStateCookieOptions = {
	name: string;
	path: string;
	maxAge?: number;
};

export function createOAuthState(cookies: Cookies, options: OAuthStateCookieOptions) {
	const state = randomBytes(32).toString('base64url');
	cookies.set(options.name, state, {
		path: options.path,
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: options.maxAge ?? 600
	});
	return state;
}

export function verifyOAuthState(
	cookies: Cookies,
	options: Pick<OAuthStateCookieOptions, 'name' | 'path'>,
	presented: string | null
) {
	const expected = cookies.get(options.name);
	cookies.delete(options.name, { path: options.path });

	if (!expected || !presented) return false;
	return statesMatch(expected, presented);
}

export function statesMatch(expected: string, actual: string) {
	const expectedBuffer = Buffer.from(expected);
	const actualBuffer = Buffer.from(actual);
	return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
