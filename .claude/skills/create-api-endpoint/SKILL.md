---
name: create-api-endpoint
description: Shape for a new server route or MCP tool so validation, authorization, logic and data access stay in their layers. Use when adding any +server.ts route, form action, or MCP tool.
---

# Create an API endpoint or MCP tool

## SvelteKit route (`src/routes/**/+server.ts` or a form action)

```text
route handler
  ↓ parse + validate input with Zod (reject early, no partial trust)
  ↓ authorize: requireAdminApi / requireScopePage / session check from src/lib/server/auth/guards.ts
  ↓ call a function in src/lib/server/<area>/  (business logic lives here, not in the route)
  ↓ data access through Prisma (parameterized; $queryRaw only as a tagged template)
  ↓ structured response: json(...) with a stable shape; errors as { error } with correct status
  ↓ audit event if the action changes state (prisma.auditEvent.create; no tokens or payloads)
```

## MCP tool (`src/lib/server/mcp/tools.ts`)

- Append to `mcpTools`: `name`, description that says *when* to call it, Zod `inputSchema`,
  `requiredScope`, and a read-only `handler`. Return text content; no side effects.
- If the handler imports a new directory, add it to `Dockerfile.mcp`'s `COPY` list.
- If it needs a new env key, add it to `.env.example` and `mcp_secret_keys`.
- Shared code must read env via `process.env`, not `$env` (the MCP process has no `$env`).

## Forbidden

Business logic in the route file; direct database calls from a Svelte component; string
interpolation into SQL; returning raw upstream payloads or stack traces; `PUBLIC_*` secrets.
