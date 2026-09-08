import { prisma } from '$lib/server/prisma';
import type { McpScope } from '../../../../prisma/generated/prisma/enums.ts';

/**
 * The scope vocabulary in one place. `McpScope` (prisma/schema.prisma) is the storage
 * form; the wire form is what OAuth clients request and what admins see. To add a
 * scope: add the enum value, add one row here, and TypeScript will flag any switch
 * that no longer covers every case.
 */
const scopeToWire: Record<McpScope, string> = {
	DATA_READ: 'data:read',
	REPORTS_READ: 'reports:read'
};

const wireToScope: Record<string, McpScope> = Object.fromEntries(
	Object.entries(scopeToWire).map(([scope, wire]) => [wire, scope as McpScope])
);

/** Every scope, in a stable order, for admin UIs and bootstrap grants. */
export const allScopes = Object.keys(scopeToWire) as McpScope[];

/** The scope every new user receives on first login. Keep it the least sensitive one. */
export const defaultScope: McpScope = 'DATA_READ';

export function scopeToWireFormat(scope: McpScope) {
	return scopeToWire[scope];
}

export function isMcpScope(value: unknown): value is McpScope {
	return typeof value === 'string' && value in scopeToWire;
}

/** Parses a space-delimited OAuth scope string, dropping anything unrecognized. */
export function parseScopeString(raw: string): McpScope[] {
	const scopes = raw
		.split(/\s+/)
		.map((token) => wireToScope[token])
		.filter((scope): scope is McpScope => Boolean(scope));
	return [...new Set(scopes)];
}

export async function getActiveScopes(userId: string) {
	const grants = await prisma.mcpUserScopeGrant.findMany({
		where: { userId, revokedAt: null },
		select: { scope: true }
	});
	return new Set(grants.map((grant) => grant.scope));
}
