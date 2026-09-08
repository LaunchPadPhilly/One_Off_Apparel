import { redirect, type RequestHandler } from '@sveltejs/kit';
import { verifyOAuthState } from '$lib/server/oauthState';
import {
	exchangeGoogleAuthorizationCode,
	getGoogleAuthConfig,
	googleOAuthStateCookie,
	googleRedirectCookie,
	isAllowedHostedDomain
} from '$lib/server/auth/google';
import { createSession, sessionCookieName } from '$lib/server/auth/session';
import { prisma } from '$lib/server/prisma';
import { allScopes, defaultScope } from '$lib/server/mcp/scopes';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const redirectTo = cookies.get(googleRedirectCookie.name) ?? '/';
	cookies.delete(googleRedirectCookie.name, { path: googleRedirectCookie.path });

	const error = url.searchParams.get('error');
	if (error) throw redirect(303, '/login?status=error');

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const stateValid = verifyOAuthState(cookies, googleOAuthStateCookie, state);
	if (!code || !stateValid) throw redirect(303, '/login?status=error');

	const config = getGoogleAuthConfig();

	let identity;
	try {
		identity = await exchangeGoogleAuthorizationCode(code);
	} catch {
		throw redirect(303, '/login?status=error');
	}

	if (!identity.emailVerified || !isAllowedHostedDomain(identity.hostedDomain, config.allowedDomains)) {
		await prisma.auditEvent.create({
			data: {
				action: 'login_rejected_domain',
				resource: 'User',
				metadata: { hostedDomain: identity.hostedDomain ?? 'none', emailVerified: identity.emailVerified }
			}
		});
		throw redirect(303, '/login?status=not_allowed');
	}

	const existingUser = await prisma.user.findUnique({ where: { email: identity.email } });
	const isFirstEverLogin = existingUser === null;

	// Someone invited (e.g. via /admin's "Invite a user", or the developer CSV seed)
	// has a User row already, sitting at status INVITED until they actually show up.
	// A real login is exactly that "showing up" — flip them to ACTIVE. Never touch
	// status the other direction here: an already-ACTIVE user stays ACTIVE, and a
	// DISABLED one (not currently settable anywhere in the UI, but defined in the
	// schema) doesn't get silently reactivated just by successfully authenticating.
	const user = await prisma.user.upsert({
		where: { email: identity.email },
		create: {
			email: identity.email,
			displayName: identity.displayName,
			status: 'ACTIVE',
			lastLoginAt: new Date()
		},
		update: {
			lastLoginAt: new Date(),
			displayName: identity.displayName,
			status: existingUser?.status === 'INVITED' ? 'ACTIVE' : undefined
		}
	});

	await prisma.authAccount.upsert({
		where: { provider_providerAccountId: { provider: 'google', providerAccountId: identity.sub } },
		create: { userId: user.id, provider: 'google', providerAccountId: identity.sub },
		update: { userId: user.id }
	});

	await prisma.auditEvent.create({
		data: { actorId: user.id, action: 'login', resource: 'User', resourceId: user.id }
	});

	if (isFirstEverLogin) {
		if (identity.email === config.initialAdminEmail) {
			await bootstrapInitialAdmin(user.id);
		} else {
			await grantDefaultScope(user.id);
		}
	}

	const { token } = await createSession(user.id);
	cookies.set(sessionCookieName, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 30
	});

	throw redirect(303, redirectTo);
};

/**
 * Every new user (other than the initial admin, who gets every scope via
 * bootstrapInitialAdmin) starts with `defaultScope` and nothing else. Every other
 * scope and the admin role require an explicit grant from an existing admin. Runs
 * only on isFirstEverLogin, so there's no prior grant row to conflict with — a plain
 * create, not an upsert.
 */
async function grantDefaultScope(userId: string) {
	await prisma.mcpUserScopeGrant.create({
		data: { userId, scope: defaultScope, grantedBy: 'system:default' }
	});

	await prisma.auditEvent.create({
		data: {
			actorId: userId,
			action: 'default_scope_granted',
			resource: 'User',
			resourceId: userId,
			metadata: { scope: defaultScope }
		}
	});
}

async function bootstrapInitialAdmin(userId: string) {
	const adminRole = await prisma.role.upsert({
		where: { name: 'ADMIN' },
		create: { name: 'ADMIN' },
		update: {}
	});

	await prisma.userRole.upsert({
		where: { userId_roleId: { userId, roleId: adminRole.id } },
		create: { userId, roleId: adminRole.id, assignedBy: 'system:bootstrap' },
		update: {}
	});

	await prisma.$transaction(
		allScopes.map((scope) =>
			prisma.mcpUserScopeGrant.upsert({
				where: { userId_scope: { userId, scope } },
				create: { userId, scope, grantedBy: 'system:bootstrap' },
				update: { revokedAt: null, revokedBy: null, grantedBy: 'system:bootstrap' }
			})
		)
	);

	await prisma.auditEvent.create({
		data: { actorId: userId, action: 'bootstrap_initial_admin', resource: 'User', resourceId: userId }
	});
}
