import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../../prisma/generated/prisma/client.ts';

const globalForPrisma = globalThis as unknown as {
	prisma?: PrismaClient;
};

function createPrismaClient() {
	// Fail loudly. A missing DATABASE_URL used to fall back to a localhost placeholder,
	// which turned a configuration mistake into a connection error that looked like a
	// network problem. Build-time contexts (Dockerfile, CI) set a placeholder explicitly.
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error('DATABASE_URL is required. Set it in .env.local for local development; deployed tasks receive it from Secrets Manager.');
	}

	const isAwsRds = connectionString.includes('amazonaws.com');
	const pool = new pg.Pool({
		connectionString: isAwsRds
			? connectionString.replace(/([?&])sslmode=[^&]*&?/g, '$1').replace(/[?&]$/g, '')
			: connectionString,
		ssl: isAwsRds ? { rejectUnauthorized: false } : undefined
	});

	return new PrismaClient({ adapter: new PrismaPg(pool) });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

