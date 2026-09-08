import { env } from '$env/dynamic/private';
import { allScopes, scopeToWireFormat } from '$lib/server/mcp/scopes';

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
