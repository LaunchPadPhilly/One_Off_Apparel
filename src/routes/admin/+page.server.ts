import { error, fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/prisma';
import { requireAdminApi } from '$lib/server/auth/guards';
import { createAgentToken } from '$lib/server/mcp/agentTokens';
import { allScopes, isMcpScope, scopeToWireFormat } from '$lib/server/mcp/scopes';
import { sendInviteEmail } from '$lib/server/email';
import { deriveAccountStatus } from '$lib/server/userStatus';
import type { Actions, PageServerLoad } from './$types';

const securityActions = [
	'admin_access_denied',
	'mcp_token_rejected',
	'mcp_agent_token_rejected',
	'login_rejected_domain'
];

const ranges = {
	'24h': 24 * 60 * 60 * 1000,
	'7d': 7 * 24 * 60 * 60 * 1000,
	'30d': 30 * 24 * 60 * 60 * 1000
} as const;

type RangeKey = keyof typeof ranges | 'all';

function serializeEvent(event: {
	id: string;
	action: string;
	resource: string;
	createdAt: Date;
	metadata: unknown;
	actor: { email: string } | null;
}) {
	return {
		id: event.id,
		action: event.action,
		resource: event.resource,
		createdAt: event.createdAt,
		actorEmail: event.actor?.email ?? null,
		metadata: event.metadata ? JSON.stringify(event.metadata) : null
	};
}

/**
 * Admin is one route with four client-side screens (Agents/Connected Apps/Activity
 * Log/Users, switched via ?screen= — see +page.svelte), mirroring Schools and
 * Finance. This load fetches everything all four need up front — the four
 * previously-separate loaders (admin/agents, admin/clients, admin/activity-log,
 * admin/users), unchanged in substance, just run together. Gating stays entirely
 * in +layout.server.ts, same as before this merge — none of the four re-checked
 * isAdmin in their own `load` either. Only /admin/users/[id] remains a real route,
 * since it needs a user's id.
 */
export const load: PageServerLoad = async ({ url }) => {
	const rangeParam = url.searchParams.get('range') ?? '7d';
	const range: RangeKey = rangeParam in ranges || rangeParam === 'all' ? (rangeParam as RangeKey) : '7d';
	const since = range === 'all' ? undefined : new Date(Date.now() - ranges[range]);
	const activityWhere = since ? { createdAt: { gte: since } } : {};

	const [
		agents,
		clients,
		activeCounts,
		users,
		usersWithValidSessions,
		byAction,
		totalEvents,
		securityEvents,
		recentEvents,
		activeAgents,
		activeUserTokens,
		activeClients,
		usersWithScopes
	] = await Promise.all([
		prisma.agentToken.findMany({ orderBy: { createdAt: 'desc' } }),
		prisma.mcpOAuthClient.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { accessTokens: true } } } }),
		prisma.mcpAccessToken.groupBy({
			by: ['clientId'],
			where: { revokedAt: null, expiresAt: { gt: new Date() } },
			_count: { _all: true }
		}),
		prisma.user.findMany({
			orderBy: { createdAt: 'asc' },
			include: { roles: { include: { role: true } }, mcpScopes: { where: { revokedAt: null } } }
		}),
		// "Active" vs "Inactive" (see deriveAccountStatus) reads whether a user is
		// logged in right now, not just whether their account is enabled.
		prisma.authSession.findMany({ where: { expiresAt: { gt: new Date() } }, distinct: ['userId'], select: { userId: true } }),
		prisma.auditEvent.groupBy({
			by: ['action'],
			where: activityWhere,
			_count: { _all: true },
			orderBy: { _count: { action: 'desc' } }
		}),
		prisma.auditEvent.count({ where: activityWhere }),
		prisma.auditEvent.findMany({
			where: { ...activityWhere, action: { in: securityActions } },
			orderBy: { createdAt: 'desc' },
			take: 25,
			include: { actor: { select: { email: true } } }
		}),
		prisma.auditEvent.findMany({
			where: activityWhere,
			orderBy: { createdAt: 'desc' },
			take: 40,
			include: { actor: { select: { email: true } } }
		}),
		prisma.agentToken.count({ where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
		prisma.mcpAccessToken.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
		prisma.mcpOAuthClient.count({ where: { disabledAt: null } }),
		prisma.user.count({ where: { mcpScopes: { some: { revokedAt: null } } } })
	]);

	const activeByClient = new Map(activeCounts.map((row) => [row.clientId, row._count._all]));
	const loggedInUserIds = new Set(usersWithValidSessions.map((row) => row.userId));
	const securityCount = byAction
		.filter((row) => securityActions.includes(row.action))
		.reduce((total, row) => total + row._count._all, 0);

	return {
		// The scope vocabulary, so the UI renders one checkbox/column per scope and
		// never hardcodes a name — add a scope in scopes.ts and it appears here.
		scopeOptions: allScopes.map((scope) => ({ value: scope, label: scopeToWireFormat(scope) })),
		agents: agents.map((agent) => ({
			id: agent.id,
			name: agent.name,
			description: agent.description,
			tokenPrefix: agent.tokenPrefix,
			scope: agent.scope.map(scopeToWireFormat),
			createdAt: agent.createdAt,
			expiresAt: agent.expiresAt,
			revokedAt: agent.revokedAt,
			lastUsedAt: agent.lastUsedAt
		})),
		clients: clients.map((client) => ({
			id: client.id,
			clientId: client.clientId,
			clientName: client.clientName,
			redirectUris: client.redirectUris,
			createdAt: client.createdAt,
			disabledAt: client.disabledAt,
			activeTokens: activeByClient.get(client.clientId) ?? 0
		})),
		users: users.map((user) => ({
			id: user.id,
			email: user.email,
			displayName: user.displayName,
			status: deriveAccountStatus(user.status, loggedInUserIds.has(user.id)),
			lastLoginAt: user.lastLoginAt,
			isAdmin: user.roles.some((userRole) => userRole.role.name === 'ADMIN'),
			scopes: user.mcpScopes.map((grant) => grant.scope)
		})),
		activity: {
			range,
			totals: {
				events: totalEvents,
				securityEvents: securityCount,
				activeAgents,
				activeUserTokens,
				activeClients,
				usersWithScopes
			},
			byAction: byAction.map((row) => ({ action: row.action, count: row._count._all })),
			securityEvents: securityEvents.map(serializeEvent),
			recentEvents: recentEvents.map(serializeEvent)
		}
	};
};

export const actions: Actions = {
	// --- Agents screen ---
	create: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const data = await request.formData();

		const name = data.get('name');
		if (typeof name !== 'string' || !name.trim()) {
			return fail(400, { screen: 'agents', message: 'Name is required.' });
		}

		const description = data.get('description');
		const scope = allScopes.filter((candidate) => data.get(candidate) === 'on');
		if (scope.length === 0) {
			return fail(400, {
				screen: 'agents',
				message: 'Select at least one scope — an agent with no scopes cannot do anything.'
			});
		}

		const expiresInDays = Number(data.get('expiresInDays'));
		const expiresAt =
			Number.isFinite(expiresInDays) && expiresInDays > 0
				? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
				: null;

		const { token, record } = await createAgentToken({
			name: name.trim(),
			description: typeof description === 'string' && description.trim() ? description.trim() : null,
			scope,
			createdBy: actingUserId,
			expiresAt
		});

		await prisma.auditEvent.create({
			data: {
				actorId: actingUserId,
				action: 'agent_token_created',
				resource: 'AgentToken',
				resourceId: record.id,
				metadata: { name: record.name, scope: scope.join(' ') }
			}
		});

		// Returned exactly once — it is stored only as a hash and cannot be shown again.
		return { screen: 'agents', createdToken: token, createdName: record.name };
	},

	revoke: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const data = await request.formData();
		const agentId = data.get('agentId');
		if (typeof agentId !== 'string' || !agentId) throw error(400, 'agentId is required');

		await prisma.agentToken.updateMany({
			where: { id: agentId, revokedAt: null },
			data: { revokedAt: new Date(), revokedBy: actingUserId }
		});
		await prisma.auditEvent.create({
			data: { actorId: actingUserId, action: 'agent_token_revoked', resource: 'AgentToken', resourceId: agentId }
		});

		return { screen: 'agents', success: true };
	},

	// --- Connected Apps screen ---
	disable: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const clientId = await readClientId(request);

		await prisma.mcpOAuthClient.update({ where: { clientId }, data: { disabledAt: new Date() } });
		// Disabling a client should also cut off anything it already holds.
		await prisma.mcpAccessToken.updateMany({ where: { clientId, revokedAt: null }, data: { revokedAt: new Date() } });
		await prisma.mcpRefreshToken.updateMany({ where: { clientId, revokedAt: null }, data: { revokedAt: new Date() } });

		await prisma.auditEvent.create({
			data: { actorId: actingUserId, action: 'mcp_client_disabled', resource: 'McpOAuthClient', resourceId: clientId }
		});
		return { screen: 'clients', success: true };
	},

	enable: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const clientId = await readClientId(request);

		await prisma.mcpOAuthClient.update({ where: { clientId }, data: { disabledAt: null } });
		await prisma.auditEvent.create({
			data: { actorId: actingUserId, action: 'mcp_client_enabled', resource: 'McpOAuthClient', resourceId: clientId }
		});
		return { screen: 'clients', success: true };
	},

	// --- Users screen ---
	inviteUser: async ({ request, locals, url }) => {
		const actingUser = requireAdminApi(locals.user);
		const data = await request.formData();

		const emailRaw = data.get('email');
		if (typeof emailRaw !== 'string' || !emailRaw.trim()) {
			return fail(400, { screen: 'users', message: 'Email is required.' });
		}
		const email = emailRaw.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return fail(400, { screen: 'users', message: 'Enter a valid email address.' });
		}

		// An invite to a domain Google login itself would reject is a dead end —
		// catch that here instead of leaving a stuck "Invited" row nobody can ever
		// turn into "Active".
		const allowedDomains = (env.GOOGLE_ALLOWED_DOMAIN ?? '')
			.split(',')
			.map((domain) => domain.trim().toLowerCase())
			.filter(Boolean);
		const domain = email.split('@')[1];
		if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
			return fail(400, {
				screen: 'users',
				message: `${domain} isn't an allowed Workspace domain — they wouldn't be able to sign in.`
			});
		}

		const existing = await prisma.user.findUnique({ where: { email } });
		if (existing) {
			return fail(400, {
				screen: 'users',
				message: `${email} is already a user here (status: ${existing.status.toLowerCase()}).`
			});
		}

		const invited = await prisma.user.create({ data: { email, status: 'INVITED' } });
		await logAudit(actingUser.id, 'user_invited', invited.id, { email });

		const signInUrl = new URL('/api/auth/google/login', url.origin).toString();
		const result = await sendInviteEmail({ to: email, invitedByEmail: actingUser.email, signInUrl });

		return {
			screen: 'users',
			invitedEmail: email,
			emailSent: result.sent,
			signInUrl
		};
	},

	grantScope: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const data = await request.formData();
		const { userId, scope } = parseScopeAction(data);

		await prisma.mcpUserScopeGrant.upsert({
			where: { userId_scope: { userId, scope } },
			create: { userId, scope, grantedBy: actingUserId },
			update: { revokedAt: null, revokedBy: null, grantedBy: actingUserId, grantedAt: new Date() }
		});

		await logAudit(actingUserId, 'grant_scope', userId, { scope });
		return { screen: 'users', success: true };
	},

	revokeScope: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const data = await request.formData();
		const { userId, scope } = parseScopeAction(data);

		await prisma.mcpUserScopeGrant.updateMany({
			where: { userId, scope, revokedAt: null },
			data: { revokedAt: new Date(), revokedBy: actingUserId }
		});

		await logAudit(actingUserId, 'revoke_scope', userId, { scope });
		return { screen: 'users', success: true };
	},

	grantAdmin: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const userId = requireUserId(await request.formData());

		const adminRole = await prisma.role.upsert({ where: { name: 'ADMIN' }, create: { name: 'ADMIN' }, update: {} });
		await prisma.userRole.upsert({
			where: { userId_roleId: { userId, roleId: adminRole.id } },
			create: { userId, roleId: adminRole.id, assignedBy: actingUserId },
			update: {}
		});

		await logAudit(actingUserId, 'grant_admin_role', userId);
		return { screen: 'users', success: true };
	},

	revokeAdmin: async ({ request, locals }) => {
		const actingUserId = requireAdminApi(locals.user).id;
		const userId = requireUserId(await request.formData());

		if (userId === actingUserId) {
			return fail(400, { screen: 'users', message: 'You cannot revoke your own admin access.' });
		}

		const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
		if (adminRole) {
			await prisma.userRole.deleteMany({ where: { userId, roleId: adminRole.id } });
		}

		await logAudit(actingUserId, 'revoke_admin_role', userId);
		return { screen: 'users', success: true };
	}
};

async function readClientId(request: Request) {
	const data = await request.formData();
	const clientId = data.get('clientId');
	if (typeof clientId !== 'string' || !clientId) throw error(400, 'clientId is required');
	return clientId;
}

function requireUserId(data: FormData) {
	const userId = data.get('userId');
	if (typeof userId !== 'string' || !userId) throw error(400, 'userId is required');
	return userId;
}

function parseScopeAction(data: FormData) {
	const userId = requireUserId(data);
	const scope = data.get('scope');
	if (!isMcpScope(scope)) throw error(400, 'Invalid scope');
	return { userId, scope };
}

function logAudit(actorId: string, action: string, resourceId: string, metadata?: Record<string, string>) {
	return prisma.auditEvent.create({
		data: { actorId, action, resource: 'User', resourceId, metadata }
	});
}
