import { redirect, type RequestHandler } from '@sveltejs/kit';
import { destroySession, sessionCookieName } from '$lib/server/auth/session';
import { prisma } from '$lib/server/prisma';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	const token = cookies.get(sessionCookieName);
	await destroySession(token);
	cookies.delete(sessionCookieName, { path: '/' });

	if (locals.user) {
		await prisma.auditEvent.create({
			data: { actorId: locals.user.id, action: 'logout', resource: 'User', resourceId: locals.user.id }
		});
	}

	throw redirect(303, '/login?status=signed_out');
};
