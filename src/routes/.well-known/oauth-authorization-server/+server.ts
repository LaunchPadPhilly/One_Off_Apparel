import { json, type RequestHandler } from '@sveltejs/kit';
import { getMcpOAuthConfig } from '$lib/server/mcp/oauthConfig';

export const GET: RequestHandler = () => {
	const config = getMcpOAuthConfig();
	const issuer = config.issuerUrl;

	return json({
		issuer,
		authorization_endpoint: `${issuer}/api/mcp/authorize`,
		token_endpoint: `${issuer}/api/mcp/token`,
		registration_endpoint: `${issuer}/api/mcp/register`,
		revocation_endpoint: `${issuer}/api/mcp/revoke`,
		scopes_supported: config.supportedScopes,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none'],
		code_challenge_methods_supported: ['S256']
	});
};
