import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import type { McpToolDefinition } from '$lib/server/mcp/handler';

/**
 * The tools this deployment exposes over MCP. Both entry points import this list
 * (src/mcp-server/index.ts and src/routes/api/mcp/+server.ts), so adding a tool here
 * adds it everywhere.
 *
 * Rules for every tool, enforced by review rather than by the type system:
 *  - Read-only. No INSERT/UPDATE/DELETE/DROP, and no side effects in an upstream API.
 *  - Parameterized queries only. Prisma's query builder does this; `$queryRaw` must use
 *    tagged-template parameters, never string interpolation.
 *  - Validate input with the Zod shape; the handler receives the parsed object.
 *  - Never return secrets, raw upstream payloads, or another user's private data.
 *
 * `service_status` is the one shipped example: it demonstrates the scope gate, the input
 * schema, and the JSON result shape without inventing a domain. Replace it with the
 * client's real tools and delete it once you have at least one.
 */
export const mcpTools: readonly McpToolDefinition[] = [
	{
		name: 'service_status',
		description:
			'Read-only health summary of this data service: counts of registered users and active data scopes. ' +
			"Example question: 'is the data service up and who can use it?' → {}. " +
			'Returns { status, users, activeScopeGrants, checkedAt }.',
		inputSchema: {
			includeCounts: z
				.boolean()
				.optional()
				.describe('Set false to skip the database counts and return liveness only.')
		},
		requiredScope: 'DATA_READ',
		handler: async ({ includeCounts = true }) => {
			if (!includeCounts) return { status: 'ok', checkedAt: new Date().toISOString() };
			const [users, activeScopeGrants] = await Promise.all([
				prisma.user.count(),
				prisma.mcpUserScopeGrant.count({ where: { revokedAt: null } })
			]);
			return { status: 'ok', users, activeScopeGrants, checkedAt: new Date().toISOString() };
		}
	}
];
