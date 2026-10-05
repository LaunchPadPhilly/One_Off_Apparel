/**
 * Agent tokens: named, individually scoped, revocable machine credentials for calling
 * the MCP server (one of the three principals in mcp/handler.ts). Admins create and
 * revoke them at /admin?screen=agents; handler.ts calls resolveAgentToken() on every
 * request. Key rule: only a SHA-256 hash is stored — the plaintext is shown once at
 * creation and can never be recovered.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { agentTokenPrefix } from '$lib/appConfig';
import type { McpScope } from '../../../../prisma/generated/prisma/enums.ts';

// The token prefix lives in $lib/appConfig so it is renamed with the project. It lets
// the MCP endpoint route an incoming bearer token to the agent-token lookup without an
// extra speculative query against the OAuth token table.
export { agentTokenPrefix };

/** SHA-256 hex digest of a token — the form stored in `AgentToken.tokenHash`. */
export function hashAgentToken(token: string) {
	return createHash('sha256').update(token).digest('hex');
}

/** True when the token carries the agent-token prefix. A routing hint only — it proves
 *  nothing; resolveAgentToken() still has to find the hash. */
export function looksLikeAgentToken(token: string) {
	return token.startsWith(agentTokenPrefix);
}

/**
 * Creates an agent token with the given scopes and stores only its hash.
 * Returns `{ token, record }`: the plaintext token exactly once — it is never stored or
 * recoverable afterwards — plus the saved row.
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

/** A valid agent token's identity and scopes, as handler.ts turns into a Principal. */
export type AgentPrincipal = {
	agentId: string;
	agentName: string;
	scopes: Set<McpScope>;
};

/**
 * Resolves a presented agent token. `principal` is null for unknown/revoked/expired
 * tokens; `rejected` (with a `reason` of 'revoked' or 'expired') is set only when the
 * token was real but no longer is, distinguishing it from "never existed" so the caller
 * can record it as a security-relevant analytics event. Never throws for a bad token.
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

	// Fire-and-forget: a failed lastUsedAt write must never block or fail the request.
	prisma.agentToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

	return {
		principal: { agentId: record.id, agentName: record.name, scopes: new Set(record.scope) }
	};
}
