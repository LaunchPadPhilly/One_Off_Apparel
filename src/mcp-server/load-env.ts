import { existsSync } from 'node:fs';

// Must be imported first, and must have no other imports of its own: ES module imports are
// evaluated in source order before any of an importing file's own top-level code runs, so this
// side-effecting module has to be a separate file imported ahead of anything (like
// $lib/server/mcp/handler) that transitively instantiates the Prisma client at import time.
// Mirrors prisma.config.ts's local-env loading: real values in .env.local (git-ignored, never
// shipped in the container — real values arrive there via docker-compose's env_file).
if (existsSync('.env.local')) {
	process.loadEnvFile('.env.local');
}
