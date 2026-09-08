---
name: write-tests
description: Testing methodology for this codebase, including how to introduce the first suite. Used by the test-engineer agent.
---

# Write tests

## If no suite exists yet (the template's starting state)

Propose in its own PR: Vitest for `src/lib/server/**` (pure functions and Prisma-backed
logic against a local PostgreSQL), Playwright for browser flows against `pnpm dev` with a
test Google account in an allowed domain, and a `test` script in `package.json` wired into
`ci.yml` after `pnpm run check`. Rename the current diagnostic script (`pnpm run test`)
first so the names do not collide.

## For every change

Cover, where relevant: happy path · boundary condition · expected failure · authorization
failure (wrong scope, revoked grant, non-admin) · invalid input (Zod rejection).

## Priorities for this platform

`isAllowedHostedDomain` rejects missing/foreign `hd`; `guardedToolResult` denies a tool
without scope and after a grant is revoked; PKCE verifier mismatch is rejected; an
authorization code cannot be consumed twice; refresh-token reuse revokes the family;
`smoke-test.sh` checks stay green.

## Rules

Tests verify behavior; never change production behavior only to satisfy a test. Never use
UAT or production credentials. Keep fixtures free of real personal data.
