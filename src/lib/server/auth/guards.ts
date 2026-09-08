import { error, redirect } from '@sveltejs/kit';
import { scopeToWireFormat } from '$lib/server/mcp/scopes';
import type { McpScope } from '../../../../prisma/generated/prisma/enums.ts';

export function isAdmin(user: App.Locals['user']) {
	return Boolean(user?.roles.some((userRole) => userRole.role.name === 'ADMIN'));
}

export function hasGrantedScope(user: App.Locals['user'], scope: McpScope) {
	return Boolean(user?.mcpScopes.some((grant) => grant.scope === scope && grant.revokedAt === null));
}

/**
 * For browser-facing routes: send anonymous users to Google login, then bounce
 * back. Authenticated non-admins get a 403 rather than a redirect loop.
 */
export function requireAdminPage(user: App.Locals['user'], returnTo: string) {
	if (!user) throw redirect(303, `/api/auth/google/login?redirectTo=${encodeURIComponent(returnTo)}`);
	if (!isAdmin(user)) throw error(403, 'Admin access required');
	return user;
}

/** For JSON endpoints: no redirects, just status codes. */
export function requireAdminApi(user: App.Locals['user']) {
	if (!user) throw error(401, 'Authentication required');
	if (!isAdmin(user)) throw error(403, 'Admin access required');
	return user;
}

/**
 * For pages gated on a granted MCP data scope rather than the admin role.
 *
 * Being an admin does NOT imply data access. Scopes are explicit, auditable, revocable
 * grants; the admin role only confers the ability to hand them out. An admin who has not
 * been granted a scope cannot read that scope's data — they must grant it to themselves
 * through /admin?screen=users, which leaves an AuditEvent behind. That trail is the whole point
 * of keeping scopes separate from roles, and an implicit admin bypass would erase it.
 */
export function requireScopePage(user: App.Locals['user'], scope: McpScope, returnTo: string) {
	if (!user) throw redirect(303, `/api/auth/google/login?redirectTo=${encodeURIComponent(returnTo)}`);
	if (!hasGrantedScope(user, scope)) {
		throw error(403, `This page requires the ${scopeToWireFormat(scope)} scope.`);
	}
	return user;
}
