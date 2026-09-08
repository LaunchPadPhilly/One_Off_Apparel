import { json, type RequestHandler } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { checkRateLimit, RateLimitExceededError } from '$lib/server/rateLimit';

function hashToken(token: string) {
	return createHash('sha256').update(token).digest('hex');
}

// RFC 7009: always return 200 regardless of whether the token existed, to avoid
// letting a caller probe for valid tokens.
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	try {
		await checkRateLimit(`mcp:revoke:${getClientAddress()}`, 30, 60);
	} catch (err) {
		if (err instanceof RateLimitExceededError) return json({ error: 'slow_down' }, { status: 429 });
		throw err;
	}

	const form = await request.formData();
	const token = form.get('token');
	const clientId = form.get('client_id');

	if (typeof token !== 'string' || !token || typeof clientId !== 'string' || !clientId) {
		return new Response(null, { status: 200 });
	}

	const tokenHash = hashToken(token);
	await prisma.mcpAccessToken.updateMany({
		where: { tokenHash, clientId, revokedAt: null },
		data: { revokedAt: new Date() }
	});
	await prisma.mcpRefreshToken.updateMany({
		where: { tokenHash, clientId, revokedAt: null },
		data: { revokedAt: new Date() }
	});

	return new Response(null, { status: 200 });
};
