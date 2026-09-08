import { env } from '$env/dynamic/private';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const googleOAuthStateCookie = { name: 'google_oauth_state', path: '/api/auth/google' } as const;
export const googleRedirectCookie = { name: 'google_oauth_redirect', path: '/api/auth/google' } as const;

const googleAuthorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
const googleTokenUrl = 'https://oauth2.googleapis.com/token';
const googleIssuer = 'https://accounts.google.com';
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export type GoogleIdentity = {
	sub: string;
	email: string;
	emailVerified: boolean;
	hostedDomain: string | null;
	displayName: string | null;
};

export function getGoogleAuthConfig() {
	const allowedDomains = required('GOOGLE_ALLOWED_DOMAIN')
		.split(',')
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
	if (allowedDomains.length === 0) throw new Error('GOOGLE_ALLOWED_DOMAIN must list at least one domain');

	return {
		clientId: required('GOOGLE_CLIENT_ID'),
		clientSecret: required('GOOGLE_CLIENT_SECRET'),
		redirectUri: required('GOOGLE_REDIRECT_URI'),
		allowedDomains,
		initialAdminEmail: required('INITIAL_ADMIN_EMAIL')
	};
}

export function createGoogleAuthorizationUrl(state: string) {
	const config = getGoogleAuthConfig();
	const url = new URL(googleAuthorizationUrl);
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', 'openid email profile');
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('state', state);
	// `hd` is a single-value account-picker hint only; it's not the security control.
	// The real enforcement is the signed `hd` claim check in the callback against
	// every allowed domain. Only hint when exactly one domain is configured.
	if (config.allowedDomains.length === 1) url.searchParams.set('hd', config.allowedDomains[0]);
	url.searchParams.set('prompt', 'select_account');
	return url;
}

export function isAllowedHostedDomain(hostedDomain: string | null, allowedDomains: string[]) {
	if (!hostedDomain) return false;
	return allowedDomains.includes(hostedDomain.toLowerCase());
}

export async function exchangeGoogleAuthorizationCode(code: string): Promise<GoogleIdentity> {
	const config = getGoogleAuthConfig();
	const response = await fetch(googleTokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: config.redirectUri
		})
	});

	if (!response.ok) throw new Error(`Google token exchange failed with status ${response.status}`);
	const payload = (await response.json()) as { id_token?: string };
	if (!payload.id_token) throw new Error('Google token response did not include an ID token');

	return verifyGoogleIdToken(payload.id_token, config.clientId);
}

async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleIdentity> {
	const { payload } = await jwtVerify(idToken, googleJwks, {
		issuer: [googleIssuer, 'accounts.google.com'],
		audience: clientId
	});

	const sub = payload.sub;
	const email = typeof payload.email === 'string' ? payload.email : undefined;
	if (!sub || !email) throw new Error('Google ID token was missing required claims');

	return {
		sub,
		email,
		emailVerified: payload.email_verified === true,
		hostedDomain: typeof payload.hd === 'string' ? payload.hd : null,
		displayName: typeof payload.name === 'string' ? payload.name : null
	};
}

function required(
	name: 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'GOOGLE_REDIRECT_URI' | 'GOOGLE_ALLOWED_DOMAIN' | 'INITIAL_ADMIN_EMAIL'
) {
	const value = env[name];
	if (!value) throw new Error(`${name} is required for Google Workspace login`);
	return value;
}
