---
name: implement-feature
description: The standard SDLC workflow for a scoped change in this SvelteKit + Prisma + MCP codebase, from requirement to proven result. Used by the developer agent.
---

# Implement a feature

1. **Read the requirement.** Issue text, acceptance criteria, and any ADR under
   `docs/decisions/`. Restate the acceptance criteria in one list.
2. **Inspect the code you will touch.** Open the files; do not describe from memory.
   Boundaries: routes `src/routes/**`, server logic `src/lib/server/**`, MCP tools
   `src/lib/server/mcp/tools.ts`, scopes `src/lib/server/mcp/scopes.ts`, schema
   `prisma/schema.prisma`.
3. **Decide the smallest viable change.** Name the files. If a migration, a new scope, a
   new env key or a new tool directory is involved, say so now (each has a coupled edit:
   migration file; scope map; `.env.example` + key lists; `Dockerfile.mcp` COPY).
4. **Implement** inside existing patterns. Runes only. Zod at inputs. Parameterized
   queries. `process.env` in code the MCP process shares.
5. **Add or update tests** where a suite exists; otherwise write down the manual
   verification you performed (browser flow, curl, MCP call).
6. **Run the gates:** `pnpm run db:validate && pnpm run check && pnpm run build`.
7. **Docker target:** `BUILD_TARGET=docker pnpm run build`.
8. **Report:** files changed, migration yes/no, new keys, what was exercised, anything
   deferred. Then hand to the exit gate.

Do not widen scope, refactor unrelated files, or add abstractions for hypothetical needs.
