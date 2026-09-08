import { json, type RequestHandler } from '@sveltejs/kit';
import { getMcpOAuthConfig } from '$lib/server/mcp/oauthConfig';

export const GET: RequestHandler = () => {
	const config = getMcpOAuthConfig();

	return json({
		resource: config.publicMcpUrl,
		authorization_servers: [config.issuerUrl],
		scopes_supported: config.supportedScopes,
		bearer_methods_supported: ['header']
	});
};
