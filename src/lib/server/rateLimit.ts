import { randomUUID } from 'node:crypto';
import { prisma } from '$lib/server/prisma';

export class RateLimitExceededError extends Error {
	retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		super('Rate limit exceeded');
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/**
 * Fixed-window counter backed by Postgres, so it works identically across serverless
 * invocations (no shared in-memory state) and survives the eventual move off Vercel.
 * Throws RateLimitExceededError when the bucket for the current window is full.
 */
export async function checkRateLimit(bucketKey: string, limit: number, windowSeconds: number) {
	const windowMs = windowSeconds * 1000;
	const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

	const result = await prisma.$queryRaw<{ count: number }[]>`
		INSERT INTO "RateLimitBucket" (id, "bucketKey", "windowStart", count)
		VALUES (${randomUUID()}, ${bucketKey}, ${windowStart}, 1)
		ON CONFLICT ("bucketKey", "windowStart")
		DO UPDATE SET count = "RateLimitBucket".count + 1
		RETURNING count
	`;

	const count = result[0]?.count ?? 0;
	if (count > limit) {
		const retryAfterSeconds = Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000);
		throw new RateLimitExceededError(Math.max(retryAfterSeconds, 1));
	}
}
