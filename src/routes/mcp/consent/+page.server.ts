import { randomBytes, createHash } from 'node:crypto';
import { error, fail, redirect } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { getActiveScopes, scopeToWireFormat } from '$lib/server/mcp/scopes';
import type { Actions, PageServerLoad } from './$types';

function hashToken(token: string) {
	return createHash('sha256').update(token).digest('hex');
}

async function loadPendingRequest(requestId: string | null) {
	if (!requestId) throw error(400, 'Missing request');

	const authorizationRequest = await prisma.mcpAuthorizationRequest.findUnique({
		where: { id: requestId },
		include: { client: true }
	});
	if (!authorizationRequest) throw error(404, 'Authorization request not found');
	if (authorizationRequest.expiresAt.getTime() < Date.now()) throw error(400, 'Authorization request expired');
	if (authorizationRequest.status === 'GRANTED' || authorizationRequest.status === 'DENIED') {
		throw error(400, 'Authorization request already completed');
	}

	return authorizationRequest;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const requestId = url.searchParams.get('request');

	if (!locals.user) {
		const redirectTo = `/mcp/consent?request=${requestId ?? ''}`;
		throw redirect(303, `/api/auth/google/login?redirectTo=${encodeURIComponent(redirectTo)}`);
	}

	const authorizationRequest = await loadPendingRequest(requestId);

	if (authorizationRequest.userId === null) {
		await prisma.mcpAuthorizationRequest.update({
			where: { id: authorizationRequest.id },
			data: { userId: locals.user.id, status: 'AWAITING_CONSENT' }
		});
	} else if (authorizationRequest.userId !== locals.user.id) {
		throw error(403, 'This authorization request belongs to a different user');
	}

	const requestedScopes = authorizationRequest.scope.split(/\s+/).filter(Boolean);
	const activeScopes = await getActiveScopes(locals.user.id);
	const activeWire = new Set([...activeScopes].map(scopeToWireFormat));

	return {
		requestId: authorizationRequest.id,
		clientName: authorizationRequest.client.clientName ?? authorizationRequest.client.clientId,
		grantableScopes: requestedScopes.filter((s) => activeWire.has(s)),
		ungrantableScopes: requestedScopes.filter((s) => !activeWire.has(s))
	};
};

export const actions: Actions = {
	approve: async ({ request, locals, url }) => {
		if (!locals.user) throw error(401, 'Not authenticated');
		const requestId = url.searchParams.get('request');
		const authorizationRequest = await loadPendingRequest(requestId);
		if (authorizationRequest.userId !== locals.user.id) throw error(403, 'Not your authorization request');

		const requestedScopes = authorizationRequest.scope.split(/\s+/).filter(Boolean);
		const activeScopes = await getActiveScopes(locals.user.id);
		const activeWire = new Set([...activeScopes].map(scopeToWireFormat));

		if (!requestedScopes.some((s) => activeWire.has(s))) {
			return fail(400, { message: 'You do not currently have any of the requested scopes granted.' });
		}

		// Store everything the client requested, not just what's active right now — actual
		// access is re-checked live against McpUserScopeGrant on every MCP request (see
		// authenticateOAuthToken/hasScope in handler.ts), so a scope requested here that gets
		// granted later takes effect immediately, with no need to reconnect and re-consent.
		const grantedScope = requestedScopes.join(' ');

		const code = randomBytes(32).toString('base64url');
		await prisma.mcpAuthorizationCode.create({
			data: {
				codeHash: hashToken(code),
				clientId: authorizationRequest.clientId,
				userId: locals.user.id,
				redirectUri: authorizationRequest.redirectUri,
				codeChallenge: authorizationRequest.codeChallenge,
				codeChallengeMethod: authorizationRequest.codeChallengeMethod,
				scope: grantedScope,
				expiresAt: new Date(Date.now() + 60_000 * 5)
			}
		});
		await prisma.mcpAuthorizationRequest.update({ where: { id: authorizationRequest.id }, data: { status: 'GRANTED' } });
		await prisma.auditEvent.create({
			data: { actorId: locals.user.id, action: 'mcp_authorization_granted', resource: 'McpOAuthClient', resourceId: authorizationRequest.clientId }
		});

		const redirectUrl = new URL(authorizationRequest.redirectUri);
		redirectUrl.searchParams.set('code', code);
		redirectUrl.searchParams.set('state', authorizationRequest.clientState);
		throw redirect(303, redirectUrl.toString());
	},

	deny: async ({ locals, url }) => {
		if (!locals.user) throw error(401, 'Not authenticated');
		const requestId = url.searchParams.get('request');
		const authorizationRequest = await loadPendingRequest(requestId);
		if (authorizationRequest.userId !== locals.user.id) throw error(403, 'Not your authorization request');

		await prisma.mcpAuthorizationRequest.update({ where: { id: authorizationRequest.id }, data: { status: 'DENIED' } });

		const redirectUrl = new URL(authorizationRequest.redirectUri);
		redirectUrl.searchParams.set('error', 'access_denied');
		redirectUrl.searchParams.set('state', authorizationRequest.clientState);
		throw redirect(303, redirectUrl.toString());
	}
};
