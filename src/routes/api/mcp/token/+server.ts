import { json, type RequestHandler } from '@sveltejs/kit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { checkRateLimit, RateLimitExceededError } from '$lib/server/rateLimit';
import { parseScopeString, scopeToWireFormat } from '$lib/server/mcp/scopes';
import type { McpScope } from '../../../../../prisma/generated/prisma/enums.ts';

const accessTokenLifetimeMs = 1000 * 60 * 60; // 1 hour
const refreshTokenLifetimeMs = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashToken(token: string) {
	return createHash('sha256').update(token).digest('hex');
}

function tokenError(status: number, error: string, description?: string) {
	return json({ error, error_description: description }, { status });
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const form = await request.formData();
	const grantType = form.get('grant_type');
	const clientId = form.get('client_id');

	if (typeof clientId !== 'string' || !clientId) return tokenError(400, 'invalid_request', 'client_id is required');

	try {
		await checkRateLimit(`mcp:token:${clientId}:${getClientAddress()}`, 30, 60);
	} catch (err) {
		if (err instanceof RateLimitExceededError) {
			return tokenError(429, 'slow_down', 'Too many token requests');
		}
		throw err;
	}

	const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
	if (!client || client.disabledAt) return tokenError(400, 'invalid_client', 'Unknown or disabled client');

	if (grantType === 'authorization_code') return handleAuthorizationCodeGrant(form, client.clientId);
	if (grantType === 'refresh_token') return handleRefreshTokenGrant(form, client.clientId);
	return tokenError(400, 'unsupported_grant_type');
};

async function handleAuthorizationCodeGrant(form: FormData, clientId: string) {
	const code = form.get('code');
	const codeVerifier = form.get('code_verifier');
	const redirectUri = form.get('redirect_uri');

	if (typeof code !== 'string' || typeof codeVerifier !== 'string' || typeof redirectUri !== 'string') {
		return tokenError(400, 'invalid_request', 'code, code_verifier, and redirect_uri are required');
	}

	const authorizationCode = await prisma.mcpAuthorizationCode.findUnique({ where: { codeHash: hashToken(code) } });
	if (
		!authorizationCode ||
		authorizationCode.clientId !== clientId ||
		authorizationCode.redirectUri !== redirectUri ||
		authorizationCode.consumedAt !== null ||
		authorizationCode.expiresAt.getTime() < Date.now()
	) {
		return tokenError(400, 'invalid_grant', 'Authorization code is invalid, expired, or already used');
	}

	if (!verifyPkce(codeVerifier, authorizationCode.codeChallenge)) {
		return tokenError(400, 'invalid_grant', 'PKCE verification failed');
	}

	// Atomic single-use consumption: only proceeds if still unconsumed.
	const consumed = await prisma.mcpAuthorizationCode.updateMany({
		where: { id: authorizationCode.id, consumedAt: null },
		data: { consumedAt: new Date() }
	});
	if (consumed.count === 0) return tokenError(400, 'invalid_grant', 'Authorization code already used');

	const scope = parseScopeString(authorizationCode.scope);
	return issueTokenSet({ clientId, userId: authorizationCode.userId, scope, familyId: randomUUID() });
}

async function handleRefreshTokenGrant(form: FormData, clientId: string) {
	const presented = form.get('refresh_token');
	if (typeof presented !== 'string' || !presented) return tokenError(400, 'invalid_request', 'refresh_token is required');

	const existing = await prisma.mcpRefreshToken.findUnique({ where: { tokenHash: hashToken(presented) } });
	if (!existing || existing.clientId !== clientId) return tokenError(400, 'invalid_grant', 'Unknown refresh token');

	if (existing.revokedAt) {
		// Reuse of an already-rotated-away token: treat as possible theft, kill the whole family.
		await prisma.mcpRefreshToken.updateMany({ where: { familyId: existing.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
		return tokenError(400, 'invalid_grant', 'Refresh token has already been used; all tokens in this session have been revoked');
	}
	if (existing.expiresAt.getTime() < Date.now()) return tokenError(400, 'invalid_grant', 'Refresh token expired');

	await prisma.mcpRefreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date(), lastUsedAt: new Date() } });

	return issueTokenSet({ clientId, userId: existing.userId, scope: existing.scope, familyId: existing.familyId, rotatedFromId: existing.id });
}

async function issueTokenSet(params: { clientId: string; userId: string; scope: McpScope[]; familyId: string; rotatedFromId?: string }) {
	const accessToken = randomBytes(32).toString('base64url');
	const refreshToken = randomBytes(32).toString('base64url');

	await prisma.mcpAccessToken.create({
		data: {
			tokenHash: hashToken(accessToken),
			clientId: params.clientId,
			userId: params.userId,
			scope: params.scope,
			expiresAt: new Date(Date.now() + accessTokenLifetimeMs)
		}
	});
	await prisma.mcpRefreshToken.create({
		data: {
			tokenHash: hashToken(refreshToken),
			clientId: params.clientId,
			userId: params.userId,
			scope: params.scope,
			familyId: params.familyId,
			rotatedFromId: params.rotatedFromId,
			expiresAt: new Date(Date.now() + refreshTokenLifetimeMs)
		}
	});

	return json({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: Math.floor(accessTokenLifetimeMs / 1000),
		refresh_token: refreshToken,
		scope: params.scope.map(scopeToWireFormat).join(' ')
	});
}

function verifyPkce(codeVerifier: string, expectedChallenge: string) {
	const computed = createHash('sha256').update(codeVerifier).digest('base64url');
	const expectedBuffer = Buffer.from(expectedChallenge);
	const actualBuffer = Buffer.from(computed);
	return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
