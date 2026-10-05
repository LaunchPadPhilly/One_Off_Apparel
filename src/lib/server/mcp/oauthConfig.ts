/**
 * MCP OAuth settings read from the environment, for the SvelteKit OAuth routes
 * (discovery, authorize, token). Uses `$env`, so it must never be imported by
 * mcp/handler.ts or anything the standalone MCP process loads — that process can't
 * resolve `$env` (CLAUDE.md, Architecture).
 */
import { env } from '$env/dynamic/private';
import { allScopes, scopeToWireFormat } from '$lib/server/mcp/scopes';

/**
 * Returns `{ issuerUrl, publicMcpUrl, supportedScopes }`. `supportedScopes` comes from
 * MCP_OAUTH_SCOPES (space-separated wire names) or, when unset, every known scope.
 * Throws if MCP_OAUTH_ISSUER_URL or MCP_PUBLIC_URL is missing.
 */
export function getMcpOAuthConfig() {
	return {
		issuerUrl: required('MCP_OAUTH_ISSUER_URL'),
		publicMcpUrl: required('MCP_PUBLIC_URL'),
		supportedScopes: (env.MCP_OAUTH_SCOPES ?? allScopes.map(scopeToWireFormat).join(' ')).split(/\s+/).filter(Boolean)
	};
}

function required(name: 'MCP_OAUTH_ISSUER_URL' | 'MCP_PUBLIC_URL') {
	const value = env[name];
	if (!value) throw new Error(`${name} is required for MCP OAuth`);
	return value;
}
