import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '$lib/server/prisma';
import { sessionCookieName } from '$lib/appConfig';

// The cookie name lives in $lib/appConfig so it is renamed with the project.
export { sessionCookieName };
const sessionDurationMs = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashSessionToken(token: string) {
	return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string) {
	const token = randomBytes(32).toString('base64url');
	const session = await prisma.authSession.create({
		data: {
			userId,
			tokenHash: hashSessionToken(token),
			expiresAt: new Date(Date.now() + sessionDurationMs)
		}
	});
	return { token, session };
}

export async function getSessionUser(token: string | undefined) {
	if (!token) return null;

	let session;
	try {
		session = await prisma.authSession.findUnique({
			where: { tokenHash: hashSessionToken(token) },
			include: {
				user: {
					include: {
						roles: { include: { role: true } },
						mcpScopes: { where: { revokedAt: null } }
					}
				}
			}
		});
	} catch (err: any) {
		console.error('DATABASE QUERY ERROR in getSessionUser:');
		console.error('Error Name:', err.name);
		console.error('Error Code:', err.code);
		console.error('Error Message:', err.message);
		console.error('Full Error:', err);
		throw err;
	}

	if (!session || session.expiresAt.getTime() < Date.now()) return null;

	// Best-effort activity tracking; not on the critical auth path if it fails.
	prisma.authSession
		.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
		.catch(() => {});

	return session.user;
}

export async function destroySession(token: string | undefined) {
	if (!token) return;
	await prisma.authSession.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}
