import { error } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { scopeToWireFormat } from '$lib/server/mcp/scopes';
import { deriveAccountStatus } from '$lib/server/userStatus';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const user = await prisma.user.findUnique({
		where: { id: params.id },
		include: {
			roles: { include: { role: true } },
			mcpScopes: { orderBy: { grantedAt: 'desc' } },
			mcpTokens: {
				where: { revokedAt: null, expiresAt: { gt: new Date() } },
				orderBy: { createdAt: 'desc' },
				include: { client: { select: { clientId: true, clientName: true } } }
			}
		}
	});
	if (!user) throw error(404, 'User not found');

	const [auditEvents, hasValidSession] = await Promise.all([
		prisma.auditEvent.findMany({
			where: { resourceId: user.id, resource: 'User' },
			orderBy: { createdAt: 'desc' },
			take: 25
		}),
		prisma.authSession.findFirst({ where: { userId: user.id, expiresAt: { gt: new Date() } }, select: { id: true } })
	]);

	return {
		user: {
			id: user.id,
			email: user.email,
			displayName: user.displayName,
			status: deriveAccountStatus(user.status, Boolean(hasValidSession)),
			lastLoginAt: user.lastLoginAt,
			isAdmin: user.roles.some((userRole) => userRole.role.name === 'ADMIN')
		},
		scopeHistory: user.mcpScopes.map((grant) => ({
			scope: scopeToWireFormat(grant.scope),
			grantedAt: grant.grantedAt,
			grantedBy: grant.grantedBy,
			revokedAt: grant.revokedAt,
			revokedBy: grant.revokedBy
		})),
		activeTokens: user.mcpTokens.map((token) => ({
			id: token.id,
			clientName: token.client.clientName ?? token.client.clientId,
			scope: token.scope.map(scopeToWireFormat),
			createdAt: token.createdAt,
			expiresAt: token.expiresAt,
			lastUsedAt: token.lastUsedAt
		})),
		auditEvents: auditEvents.map((event) => ({
			action: event.action,
			createdAt: event.createdAt,
			metadata: event.metadata
		}))
	};
};

export const actions: Actions = {
	revokeToken: async ({ request, locals, params }) => {
		const actingUserId = requireAdmin(locals);
		const data = await request.formData();
		const tokenId = data.get('tokenId');
		if (typeof tokenId !== 'string' || !tokenId) throw error(400, 'tokenId is required');

		await prisma.mcpAccessToken.updateMany({
			where: { id: tokenId, userId: params.id, revokedAt: null },
			data: { revokedAt: new Date() }
		});
		await prisma.auditEvent.create({
			data: {
				actorId: actingUserId,
				action: 'mcp_token_revoked',
				resource: 'User',
				resourceId: params.id,
				metadata: { tokenId }
			}
		});

		return { success: true };
	},

	revokeAllTokens: async ({ locals, params }) => {
		const actingUserId = requireAdmin(locals);

		const revoked = await prisma.mcpAccessToken.updateMany({
			where: { userId: params.id, revokedAt: null },
			data: { revokedAt: new Date() }
		});
		await prisma.mcpRefreshToken.updateMany({
			where: { userId: params.id, revokedAt: null },
			data: { revokedAt: new Date() }
		});
		await prisma.auditEvent.create({
			data: {
				actorId: actingUserId,
				action: 'mcp_all_tokens_revoked',
				resource: 'User',
				resourceId: params.id,
				metadata: { accessTokensRevoked: String(revoked.count) }
			}
		});

		return { success: true };
	}
};

function requireAdmin(locals: App.Locals) {
	const isAdmin = locals.user?.roles.some((userRole) => userRole.role.name === 'ADMIN');
	if (!locals.user || !isAdmin) throw error(403, 'Admin access required');
	return locals.user.id;
}
