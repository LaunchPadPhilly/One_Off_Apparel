import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { checkRateLimit, RateLimitExceededError } from '$lib/server/rateLimit';
import { parseScopeString } from '$lib/server/mcp/scopes';

const requestLifetimeMs = 1000 * 60 * 10; // 10 minutes

export const GET: RequestHandler = async ({ url, getClientAddress }) => {
	try {
		await checkRateLimit(`mcp:authorize:${getClientAddress()}`, 20, 60);
	} catch (err) {
		if (err instanceof RateLimitExceededError) throw error(429, 'Too many requests');
		throw err;
	}

	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');
	const responseType = url.searchParams.get('response_type');
	const clientState = url.searchParams.get('state');
	const codeChallenge = url.searchParams.get('code_challenge');
	const codeChallengeMethod = url.searchParams.get('code_challenge_method');
	const rawScope = url.searchParams.get('scope') ?? '';

	if (!clientId || !redirectUri || !clientState || !codeChallenge) {
		throw error(400, 'Missing required authorization parameters');
	}
	if (responseType !== 'code') throw error(400, 'Only response_type=code is supported');
	if (codeChallengeMethod !== 'S256') throw error(400, 'Only code_challenge_method=S256 is supported');

	const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
	if (!client || client.disabledAt) throw error(400, 'Unknown or disabled client');
	if (!client.redirectUris.includes(redirectUri)) throw error(400, 'redirect_uri does not match a registered URI for this client');

	const requestedScopes = parseScopeString(rawScope);
	if (requestedScopes.length === 0) throw error(400, 'No recognized scopes requested');

	const authorizationRequest = await prisma.mcpAuthorizationRequest.create({
		data: {
			clientId,
			redirectUri,
			clientState,
			codeChallenge,
			codeChallengeMethod,
			scope: rawScope,
			expiresAt: new Date(Date.now() + requestLifetimeMs)
		}
	});

	throw redirect(303, `/mcp/consent?request=${authorizationRequest.id}`);
};
