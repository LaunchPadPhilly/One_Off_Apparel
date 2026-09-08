import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { agentTokenPrefix } from '$lib/appConfig';
import type { McpScope } from '../../../../prisma/generated/prisma/enums.ts';

// The token prefix lives in $lib/appConfig so it is renamed with the project. It lets
// the MCP endpoint route an incoming bearer token to the agent-token lookup without an
// extra speculative query against the OAuth token table.
export { agentTokenPrefix };

export function hashAgentToken(token: string) {
	return createHash('sha256').update(token).digest('hex');
}

export function looksLikeAgentToken(token: string) {
	return token.startsWith(agentTokenPrefix);
}

/**
 * Returns the plaintext token exactly once — it is never stored or recoverable afterwards.
 */
export async function createAgentToken(params: {
	name: string;
	description?: string | null;
	scope: McpScope[];
	createdBy: string;
	expiresAt?: Date | null;
}) {
	const secret = randomBytes(32).toString('base64url');
	const token = `${agentTokenPrefix}${secret}`;

	const record = await prisma.agentToken.create({
		data: {
			name: params.name,
			description: params.description ?? null,
			tokenHash: hashAgentToken(token),
			// Non-secret display fragment, so an admin can tell tokens apart in the UI.
			tokenPrefix: `${agentTokenPrefix}${secret.slice(0, 6)}`,
			scope: params.scope,
			createdBy: params.createdBy,
			expiresAt: params.expiresAt ?? null
		}
	});

	return { token, record };
}

export type AgentPrincipal = {
	agentId: string;
	agentName: string;
	scopes: Set<McpScope>;
};

/**
 * Resolves a presented agent token. Returns null for unknown/revoked/expired tokens;
 * `reason` distinguishes "never existed" from "was valid but no longer is" so the caller
 * can record the latter as a security-relevant analytics event.
 */
export async function resolveAgentToken(
	presented: string
): Promise<{ principal: AgentPrincipal | null; rejected?: { id: string; name: string; reason: string } }> {
	const record = await prisma.agentToken.findUnique({ where: { tokenHash: hashAgentToken(presented) } });
	if (!record) return { principal: null };

	if (record.revokedAt) {
		return { principal: null, rejected: { id: record.id, name: record.name, reason: 'revoked' } };
	}
	if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
		return { principal: null, rejected: { id: record.id, name: record.name, reason: 'expired' } };
	}

	prisma.agentToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

	return {
		principal: { agentId: record.id, agentName: record.name, scopes: new Set(record.scope) }
	};
}
