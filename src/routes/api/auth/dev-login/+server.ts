import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/prisma';
import { createSession, sessionCookieName } from '$lib/server/auth/session';
import { allScopes } from '$lib/server/mcp/scopes';

const DEV_EMAIL = 'dev@localhost';

export const GET: RequestHandler = async ({ cookies }) => {
	if (env.DEV_LOGIN_ENABLED !== 'true') throw error(404);
	if (process.env.NODE_ENV === 'production') throw error(404);

	const user = await prisma.user.upsert({
		where: { email: DEV_EMAIL },
		create: { email: DEV_EMAIL, displayName: 'Dev User', status: 'ACTIVE', lastLoginAt: new Date() },
		update: { lastLoginAt: new Date() }
	});

	const adminRole = await prisma.role.upsert({
		where: { name: 'ADMIN' },
		create: { name: 'ADMIN' },
		update: {}
	});

	await prisma.userRole.upsert({
		where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
		create: { userId: user.id, roleId: adminRole.id, assignedBy: 'system:dev-login' },
		update: {}
	});

	await prisma.$transaction(
		allScopes.map((scope) =>
			prisma.mcpUserScopeGrant.upsert({
				where: { userId_scope: { userId: user.id, scope } },
				create: { userId: user.id, scope, grantedBy: 'system:dev-login' },
				update: { revokedAt: null, revokedBy: null }
			})
		)
	);

	const { token } = await createSession(user.id);
	cookies.set(sessionCookieName, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		maxAge: 60 * 60 * 24 * 30
	});

	throw redirect(303, '/');
};
