import { json, type RequestHandler } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '$lib/server/prisma';
import { checkRateLimit, RateLimitExceededError } from '$lib/server/rateLimit';

const registrationSchema = z.object({
	redirect_uris: z.array(z.string()).min(1),
	client_name: z.string().optional(),
	token_endpoint_auth_method: z.literal('none').optional()
});

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	try {
		await checkRateLimit(`mcp:register:${getClientAddress()}`, 5, 60);
	} catch (error) {
		if (error instanceof RateLimitExceededError) {
			return json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } });
		}
		throw error;
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, { status: 400 });
	}

	const parsed = registrationSchema.safeParse(body);
	if (!parsed.success) {
		return json({ error: 'invalid_client_metadata', error_description: parsed.error.message }, { status: 400 });
	}

	const invalidUri = parsed.data.redirect_uris.find((uri) => !isAllowedRedirectUri(uri));
	if (invalidUri) {
		return json(
			{ error: 'invalid_redirect_uri', error_description: `Redirect URI must be https://, or http:// on localhost: ${invalidUri}` },
			{ status: 400 }
		);
	}

	const clientId = randomUUID();
	const client = await prisma.mcpOAuthClient.create({
		data: {
			clientId,
			clientName: parsed.data.client_name,
			redirectUris: parsed.data.redirect_uris,
			tokenEndpointAuthMethod: 'none'
		}
	});

	return json(
		{
			client_id: client.clientId,
			client_name: client.clientName,
			redirect_uris: client.redirectUris,
			token_endpoint_auth_method: client.tokenEndpointAuthMethod,
			client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000)
		},
		{ status: 201 }
	);
};

function isAllowedRedirectUri(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}

	if (url.protocol === 'https:') return true;
	if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
	return false;
}
