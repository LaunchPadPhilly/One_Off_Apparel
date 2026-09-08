import { existsSync } from 'node:fs';

// Must be imported first in hooks.server.ts, and must have no other imports of its own — see
// src/mcp-server/load-env.ts for the same pattern and the reason (ES module imports evaluate
// in source order before any of an importing file's own top-level code, so a side-effecting
// loader has to be its own file, imported ahead of anything that transitively reads process.env
// at import time, like $lib/server/prisma).
//
// Needed because `$env/dynamic/private` in SvelteKit dev mode is populated from .env.local by
// SvelteKit's own internal env loading — a mechanism separate from process.env, not a thin
// wrapper around it. Lib files that read process.env directly (prisma.ts, and any connector
// config you add) rely on process.env actually being populated, which only happens for
// real in adapter-node production (where there's no separate dev-server env-loading step) and
// in the standalone mcp-server (which loads it explicitly) — not in `vite dev` without this.
if (existsSync('.env.local')) {
	process.loadEnvFile('.env.local');
}
