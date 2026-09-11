import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { createSession, sessionCookieName } from '$lib/server/auth/session';
import { allScopes } from '$lib/server/mcp/scopes';

const DEV_EMAIL = process.env.DEV_LOGIN_EMAIL ?? 'dev@localhost.dev';
const DEV_DISPLAY_NAME = 'Dev User';

function devLoginEnabled() {
	return process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED === 'true';
}

async function performDevLogin(cookies: Parameters<RequestHandler>[0]['cookies']) {
	if (!devLoginEnabled()) throw error(404, 'Not found');

	const user = await prisma.user.upsert({
		where: { email: DEV_EMAIL },
		create: {
			email: DEV_EMAIL,
			displayName: DEV_DISPLAY_NAME,
			status: 'ACTIVE',
			lastLoginAt: new Date()
		},
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
				update: { revokedAt: null, revokedBy: null, grantedBy: 'system:dev-login' }
			})
		)
	);

	await prisma.auditEvent.create({
		data: { actorId: user.id, action: 'dev_login', resource: 'User', resourceId: user.id }
	});

	const { token } = await createSession(user.id);
	cookies.set(sessionCookieName, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		maxAge: 60 * 60 * 24 * 30
	});
}

export const POST: RequestHandler = async ({ cookies }) => {
	await performDevLogin(cookies);
	throw redirect(303, '/');
};

export const GET: RequestHandler = async ({ cookies }) => {
	await performDevLogin(cookies);
	throw redirect(303, '/');
};
