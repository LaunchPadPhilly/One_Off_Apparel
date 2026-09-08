import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { getActiveScopes, scopeToWireFormat } from '$lib/server/mcp/scopes';
import { mcpServerName } from '$lib/appConfig';
import { looksLikeAgentToken, resolveAgentToken } from '$lib/server/mcp/agentTokens';
import type { McpScope } from '../../../../prisma/generated/prisma/enums.ts';

/**
 * Three ways to reach this endpoint:
 *
 * - `agent` — a registered AgentToken: a named, individually-scoped, revocable machine
 *   credential. Its scopes are its own (no human user, so nothing to intersect against).
 * - `oauth` — a Claude.ai/user-facing access token, scoped to the live intersection of what the
 *   token was issued with and the user's currently active McpUserScopeGrant rows, so an admin
 *   revocation takes effect on the next request rather than waiting for the token to expire.
 * - `static` — the legacy MCP_SERVER_TOKEN. Unrestricted and unattributable; kept only for
 *   backwards compatibility and break-glass access. Prefer a scoped agent token instead, and
 *   leave MCP_SERVER_TOKEN unset in environments that don't need it.
 *
 * Framework-agnostic on purpose: this module is imported both by the SvelteKit passthrough
 * route (src/routes/api/mcp/+server.ts) and by the standalone mcp-server process
 * (src/mcp-server/index.ts), so it only depends on standard Request/Response and process.env.
 */
export type Principal =
	| { kind: 'static' }
	| { kind: 'agent'; agentId: string; agentName: string; scopes: Set<McpScope> }
	| { kind: 'oauth'; userId: string; scopes: Set<McpScope> };

/**
 * One read-only tool. The handler owns authentication and the scope gate; the tool owns
 * its input schema and its query. Callers (src/mcp-server/index.ts and the SvelteKit
 * passthrough) pass a list of these into `createMcpHandler`, so this module never imports
 * domain code and the domain never touches auth.
 */
export type McpToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> = {
	/** snake_case, unique per server; what the client sees in the tool list. */
	name: string;
	description: string;
	inputSchema: Shape;
	/** The scope a principal must hold. Checked live per request — see guardedToolResult. */
	requiredScope: McpScope;
	/** Must be read-only: no INSERT/UPDATE/DELETE/DROP. Its return value is JSON-serialized. */
	handler: (input: z.infer<z.ZodObject<Shape>>, principal: Principal) => Promise<unknown>;
};

export type McpHandler = {
	handleGet(request: Request): Promise<Response>;
	handlePost(request: Request): Promise<Response>;
};

/** Builds the two HTTP handlers for a given tool list. */
export function createMcpHandler(tools: readonly McpToolDefinition[]): McpHandler {
	return {
		async handleGet(request) {
			const principal = await authenticate(request);
			if (!principal) return unauthorized();
			return jsonResponse({ name: mcpServerName, status: 'ready' });
		},
		async handlePost(request) {
			const principal = await authenticate(request);
			if (!principal) return unauthorized();

			const server = createServer(principal, tools);
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true
			});
			await server.connect(transport);
			return transport.handleRequest(request);
		}
	};
}

function jsonResponse(body: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers }
	});
}

function createServer(principal: Principal, tools: readonly McpToolDefinition[]) {
	const server = new McpServer({
		name: mcpServerName,
		version: '0.1.0'
	});

	// Every tool registers unconditionally, whatever the principal holds, so a client
	// with insufficient scope sees the tool and gets a clear permission error when it
	// calls it — rather than a silently shorter tool list it cannot explain.
	// guardedToolResult is the single gate.
	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: { readOnlyHint: true }
			},
			async (input) => guardedToolResult(principal, tool.requiredScope, () => tool.handler(input, principal))
		);
	}

	return server;
}

function hasScope(principal: Principal, scope: McpScope) {
	return principal.kind === 'static' || principal.scopes.has(scope);
}

/** Tools register unconditionally now, so this is the only gate — see createServer(). */
async function guardedToolResult(principal: Principal, requiredScope: McpScope, operation: () => Promise<unknown>) {
	if (!hasScope(principal, requiredScope)) {
		return {
			isError: true,
			content: [
				{
					type: 'text' as const,
					text: `You don't have permission to access this data. Ask an administrator to grant you the ${scopeToWireFormat(requiredScope)} scope.`
				}
			]
		};
	}
	return toolResult(operation);
}

async function toolResult(operation: () => Promise<unknown>) {
	try {
		const result = await operation();
		return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
	} catch {
		return {
			isError: true,
			content: [{ type: 'text' as const, text: 'The requested data is unavailable.' }]
		};
	}
}

async function authenticate(request: Request): Promise<Principal | null> {
	const presented = bearerToken(request);
	if (!presented) return null;

	if (matchesStaticToken(presented)) return { kind: 'static' };

	// Agent tokens carry a recognizable prefix, so they route straight to the agent lookup
	// instead of speculatively querying the OAuth token table first.
	if (looksLikeAgentToken(presented)) return authenticateAgentToken(presented);

	return authenticateOAuthToken(presented);
}

async function authenticateAgentToken(presented: string): Promise<Principal | null> {
	const { principal, rejected } = await resolveAgentToken(presented);

	if (rejected) {
		// Analytics: a real agent credential that is no longer usable. Distinct from an
		// entirely unknown token, since it usually means an automation is still running
		// with credentials an admin already revoked.
		await prisma.auditEvent
			.create({
				data: {
					action: 'mcp_agent_token_rejected',
					resource: 'AgentToken',
					resourceId: rejected.id,
					metadata: { agentName: rejected.name, reason: rejected.reason }
				}
			})
			.catch(() => {});
		return null;
	}

	if (!principal) return null;
	return { kind: 'agent', agentId: principal.agentId, agentName: principal.agentName, scopes: principal.scopes };
}

function bearerToken(request: Request) {
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) return null;
	return header.slice('Bearer '.length);
}

function matchesStaticToken(presented: string) {
	const configuredToken = process.env.MCP_SERVER_TOKEN;
	if (!configuredToken) return false;

	const expected = Buffer.from(configuredToken);
	const actual = Buffer.from(presented);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function authenticateOAuthToken(presented: string): Promise<Principal | null> {
	const tokenHash = createHash('sha256').update(presented).digest('hex');
	const record = await prisma.mcpAccessToken.findUnique({ where: { tokenHash } });

	if (!record) return null;
	if (record.revokedAt || record.expiresAt.getTime() < Date.now()) {
		// Analytics: a real but no-longer-valid token was presented. Worth recording
		// separately from an entirely unknown token, since it can indicate a client
		// still holding credentials after an admin revoked them.
		await prisma.auditEvent
			.create({
				data: {
					actorId: record.userId,
					action: 'mcp_token_rejected',
					resource: 'McpAccessToken',
					resourceId: record.id,
					metadata: { reason: record.revokedAt ? 'revoked' : 'expired' }
				}
			})
			.catch(() => {});
		return null;
	}

	const activeGrants = await getActiveScopes(record.userId);
	const effectiveScopes = new Set(record.scope.filter((scope) => activeGrants.has(scope)));

	prisma.mcpAccessToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

	return { kind: 'oauth', userId: record.userId, scopes: effectiveScopes };
}

function unauthorized() {
	// The WWW-Authenticate resource_metadata URL must point at the well-known route's own
	// origin — the OAuth issuer (MCP_OAUTH_ISSUER_URL), which is where .well-known/
	// oauth-protected-resource is actually served (the SvelteKit app), not at this resource
	// server's own origin (MCP_PUBLIC_URL). Those two URLs are only identical while the MCP
	// server still lives inside the SvelteKit app; once split, using MCP_PUBLIC_URL here would
	// point clients at a 404 on the standalone server instead of the real discovery document.
	const issuerUrl = process.env.MCP_OAUTH_ISSUER_URL ?? '';
	const resourceMetadataUrl = issuerUrl
		? new URL('/.well-known/oauth-protected-resource', issuerUrl).toString()
		: undefined;

	return jsonResponse(
		{ error: 'Unauthorized' },
		{
			status: 401,
			headers: resourceMetadataUrl
				? { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }
				: {}
		}
	);
}
