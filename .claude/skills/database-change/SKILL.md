---
name: database-change
description: Safe schema change with Prisma 7 and the deploy pipeline's blocking migration task. Use for any edit to prisma/schema.prisma.
---

# Database change

1. **Review the schema** (`prisma/schema.prisma`) and the existing migrations under
   `prisma/migrations/`. Note that `0001_init` is squashed.
2. **Design the change.** Keep domain tables free of foreign keys into the auth tables
   unless a real relationship exists. Adding a `McpScope` value also needs the wire-name map
   in `src/lib/server/mcp/scopes.ts`.
3. **Backwards compatibility.** Deployments run `prisma migrate deploy` as a blocking
   one-off ECS task *before* either service updates, and the old tasks keep running until
   the new ones are healthy. Column drops or renames therefore need an expand/contract
   sequence across two releases. Prisma migrations do not run backwards; a rollback is a
   forward migration.
4. **Author the migration** against a database you own:
   `pnpm run db:format && pnpm run db:validate && pnpm run db:migrate --name <slug>`.
   Read the generated SQL before committing it.
5. **Regenerate and update code:** `pnpm run db:generate`, then the server code.
6. **Test the migration** on a fresh local database: `pnpm run db:deploy` from empty, then
   from the previous state.
7. **Document** in the PR: live-data safety, expected duration, and rollback concerns.

Never run `db:migrate` or `db:deploy` against UAT or production from a workstation; the
pipeline and Play 14 section E are the only paths.
