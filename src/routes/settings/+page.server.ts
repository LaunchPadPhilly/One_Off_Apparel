import { redirect } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { scopeToWireFormat } from '$lib/server/mcp/scopes';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/api/auth/google/login?redirectTo=${encodeURIComponent(url.pathname)}`);
	}

	const [activeTokenCount, connectedClients] = await Promise.all([
		prisma.mcpAccessToken.count({
			where: { userId: locals.user.id, revokedAt: null, expiresAt: { gt: new Date() } }
		}),
		prisma.mcpAccessToken.findMany({
			where: { userId: locals.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
			distinct: ['clientId'],
			include: { client: { select: { clientName: true, clientId: true } } }
		})
	]);

	return {
		scopes: locals.user.mcpScopes
			.filter((grant) => grant.revokedAt === null)
			.map((grant) => scopeToWireFormat(grant.scope)),
		activeTokenCount,
		connectedClients: connectedClients.map((token) => ({
			clientId: token.client.clientId,
			clientName: token.client.clientName ?? token.client.clientId
		}))
	};
};
