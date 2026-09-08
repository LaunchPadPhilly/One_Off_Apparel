import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Prisma CLI does not load .env.local by default (only .env). This project keeps
// real values in .env.local (git-ignored) and only documents names in .env.example.
// .env.local does not exist on Vercel (or CI) — env vars are injected directly into
// process.env there, so only load the file when it's actually present.
if (existsSync('.env.local')) {
	process.loadEnvFile('.env.local');
}

export default defineConfig({
	schema: 'prisma/schema.prisma',
	migrations: {
		path: 'prisma/migrations'
	},
	datasource: {
		url: env('DATABASE_URL')
	}
});
