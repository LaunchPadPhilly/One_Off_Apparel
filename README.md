# __PROJECT_DISPLAY_NAME__

Internal data platform: staff sign in with Google Workspace, an admin grants each person
explicit data scopes, and AI clients reach the same data through a read-only MCP server
secured with OAuth 2.1. Deployed as two ECS Fargate services behind one load balancer, in
two environments defined in Terraform, released by a build-once / promote-unchanged
pipeline.

**Start with the checklist below, then [`playbook/README.md`](playbook/README.md).** The
playbook is a set of run books, in dependency order, from filling the template's
placeholders to production promotion. Each play states the evidence to paste to the
assistant you work with and what "done" means.

## New project setup

Work through this after creating a repository from the template. Each line names the play
that does it; the plays hold the commands, the evidence to paste, and the success criteria.

- [ ] Create the repository: **Use this template** → owner `LaunchPadPhilly`, name `client-<client-name>`, private
- [ ] Add the developer team with write access; confirm `.github/CODEOWNERS` slugs exist in the org
- [ ] Preflight tools and access (Play 01)
- [ ] Run `./scripts/init-template.sh` to rename the project, client, domain, region and state bucket (Play 02)
- [ ] Decide and apply the `MCP_SERVER_TOKEN` choice (Play 02 step 4)
- [ ] Install, run the gates, commit, confirm `ci.yml` is green (Play 02 steps 5–6)
- [ ] Create the Google OAuth client (Play 03)
- [ ] Copy `.env.example` to `.env.local`, configure the development database, run locally to a passing MCP call (Play 04)
- [ ] AWS account prerequisites: OIDC provider, operator identity, default VPC (Play 05)
- [ ] Terraform bootstrap and global: state bucket, ECR, deploy role (Play 06)
- [ ] Configure GitHub environments `UAT` and `Production`, the `AWS_ROLE_ARN` secret, branch protection (Play 07)
- [ ] Bring up UAT, populate its secret, activate, smoke test, first admin signs in (Plays 08–10)
- [ ] Verify the CI/CD pipeline end to end (Play 11)
- [ ] Bring up production and promote the proved SHA (Play 12)
- [ ] Security acceptance; record decisions and known gaps in `CLAUDE.md` → Project State (Play 13)
- [ ] Complete the architecture notes in `CLAUDE.md` for the client's domain
- [ ] Read the Human Activation Gate Policy in `CLAUDE.md`; every agent asks you for pasted evidence before it works

The new-client SOP is therefore: client approved → Use this template → `client-<name>`,
private → add the team → work the checklist above → first PR passes CI → development
starts. GitHub's API can create repositories from a template, so the first two steps can be
automated later.

## Shared across projects

Things that must change for every client at once do not belong in a generated repository.
Candidates to centralize at the organization level as they stabilize: reusable GitHub
Actions workflows (the build / migrate / deploy shape in `.github/workflows`), the security
policy, shared scripts, the Terraform environment module under `infra/modules`, and the
Dockerfile conventions. Until then this template is the single governed baseline; do not
fork it into per-stack variants until projects genuinely diverge.

## What is in the box

| Boundary | Where | What it gives you |
|---|---|---|
| **SvelteKit app** (`web`) | `src/routes`, `src/lib` | Google Workspace login gated by allowed domain, session cookies, the admin area (`/admin`: agent tokens, connected AI clients, activity log, users and scopes), settings, and the OAuth authorization server endpoints (`/.well-known/*`, `/api/mcp/{register,authorize,token,revoke}`, `/mcp/consent`). |
| **Prisma + PostgreSQL** | `prisma/` | Users, roles, sessions, audit events, rate-limit buckets, and the complete MCP OAuth model: clients, PKCE codes, rotating refresh tokens, access tokens, per-user scope grants, agent tokens. One squashed initial migration. |
| **MCP server** (`mcp`) | `src/mcp-server`, `src/lib/server/mcp` | A standalone Node process serving only `/api/mcp`. Three principals: scoped agent tokens, user OAuth tokens (effective scope is the *live* intersection of token scope and current grants), and an optional legacy static token. Tools are a plain list in `src/lib/server/mcp/tools.ts`. |
| **Infrastructure** | `infra/` | Terraform: account-level ECR + GitHub OIDC deploy role, and a per-environment module (ALB, ECS, IAM, logs, secret container, encrypted RDS) with a three-stage bring-up. |
| **Pipeline** | `.github/workflows` | `ci.yml` on every push; `deploy.yml` builds both images once, migrates and deploys UAT, smoke-tests it, and stops; `deploy-production.yml` is dispatch-only and promotes an already-built SHA. |
| **Claude Code setup** | `CLAUDE.md`, `.claude/` | Project rules, six specialized agents and nine skills. Agents are locked until the developer pastes real command output; see the Human Activation Gate Policy in `CLAUDE.md`. |
| **Scripts** | `scripts/` | Template init and check, connection-string builder/repairer that never prints the password, the smoke test, and the environment diagnostic. |

What is deliberately **not** here: any client domain, and nothing generated. `node_modules`,
`build/`, `.svelte-kit/` and `prisma/generated/` are produced by `pnpm install` and the
build on the developer's machine and in the Docker build; they are never committed.

## Quick start

```bash
corepack enable
cp .env.example .env.local                       # fill in real values; never commit it
DATABASE_URL=postgresql://u:p@localhost:5432/db pnpm install --frozen-lockfile
pnpm run test                                    # env + connection-string diagnostic, not a test suite
pnpm run db:deploy                               # apply committed migrations
pnpm dev                                         # web on :5173
pnpm run mcp:dev                                 # standalone MCP on :3001, second terminal
```

The full sequence, including the Google OAuth client and the first-admin bootstrap, is
[`playbook/04-local-development.md`](playbook/04-local-development.md).

## Commands

| Command | Purpose |
|---|---|
| `pnpm run check` | svelte-check. **The primary correctness gate**; there is no linter and no test suite. |
| `pnpm run build` / `BUILD_TARGET=docker pnpm run build` | Default adapter / the `adapter-node` output the containers run. |
| `pnpm run db:validate` · `db:generate` · `db:format` | Prisma schema checks and client generation. |
| `pnpm run db:deploy` | Apply committed migrations. |
| `pnpm run db:migrate` | `prisma migrate dev` — only for authoring a new migration against a database you own. |
| `pnpm run test` | Environment diagnostic: required keys present, `DATABASE_URL` structurally valid, then connects. |
| `pnpm run mcp:dev` | Run the standalone MCP server locally on port 3001. |
| `pnpm run template:check` | Zero-hit gate for leftover placeholders, stray identifiers and email addresses. |
| `./scripts/smoke-test.sh <base-url>` | curl-only acceptance check; the pipeline's promotion gate. |
| `./scripts/fix-secret-database-url.sh` | Build or repair the `DATABASE_URL` in a Secrets Manager secret without printing it. |

## Where to read next

- [`playbook/`](playbook/README.md) — the run books and [`CONFIDENCE.md`](playbook/CONFIDENCE.md).
- [`infra/README.md`](infra/README.md) — the Terraform runbook and the pipeline's GitHub-side settings.
- [`SECURITY.md`](SECURITY.md) — the non-negotiable constraints.
- [`CLAUDE.md`](CLAUDE.md) — conventions for contributors and coding agents.

## Adding the client's domain

1. **Schema:** add models to `prisma/schema.prisma`; author a migration with `pnpm run db:migrate`. Keep domain tables free of foreign keys into the auth tables unless a real relationship exists.
2. **Scopes:** add an `McpScope` value and its wire name in `src/lib/server/mcp/scopes.ts`. The admin UI, OAuth discovery and consent pick it up automatically.
3. **Tools:** append to `mcpTools` in `src/lib/server/mcp/tools.ts`. Read-only, Zod-validated, parameterized. Add the directory to `Dockerfile.mcp`'s `COPY` list.
4. **Pages:** gate a route with `requireScopePage(locals.user, 'REPORTS_READ', url.pathname)` and add its nav link in `src/routes/+layout.svelte`.
5. **Secrets:** any new env key goes in `.env.example` *and* in `web_secret_keys` / `mcp_secret_keys` in the environment root, or ECS never injects it.
6. **Connectors** (an external API) live under `src/lib/server/<connector>/`, load credentials server-side only, and are read-only from the MCP side.

Pull requests: one focused change; schema changes ship with their migration and a note on
live-data safety; a new env key ships with its `.env.example` entry and key-list entry; a
new MCP tool ships with its Zod schema and `Dockerfile.mcp` `COPY` line. The PR template
prompts for each.
