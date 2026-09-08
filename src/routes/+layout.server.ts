import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.user) return { user: null };

	// Build the nav from granted scopes, not the admin role, so it mirrors exactly what
	// requireScopePage will allow — showing a link that 403s is worse than hiding it.
	// A domain page gated on a scope belongs here as `canRead<Thing>: activeScopes.has('…')`.
	const activeScopes = new Set(
		locals.user.mcpScopes.filter((grant) => grant.revokedAt === null).map((grant) => grant.scope)
	);

	return {
		user: {
			email: locals.user.email,
			displayName: locals.user.displayName,
			isAdmin: locals.user.roles.some((userRole) => userRole.role.name === 'ADMIN'),
			scopes: [...activeScopes]
		}
	};
};
