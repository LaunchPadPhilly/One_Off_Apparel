# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository. Prefer
executable sources over prose: `package.json` for commands, `.github/workflows/deploy.yml`
for release order, `infra/` for AWS resources, the environment root's `web_secret_keys` /
`mcp_secret_keys` for ECS secret keys, `.env.example` for value semantics.

## Project State

Re-derive from disk before assuming otherwise; check the actual files before assuming a
command works.

This project is the One Off Apparel scheduling system, built on the platform template
described below. Domain design (schema, engine logic, MCP tools/skills, open decisions) is
fully specified in **"Domain: One Off Apparel Scheduling System"** further down this file —
read it before touching any order/schedule/line-item logic. As of this writing that section
reflects the finalized design; update this paragraph once implementation actually begins so
it states what's built and verified end-to-end vs. still a shell. Also record here the
decisions Play 13 asks for: the MCP_SERVER_TOKEN choice, which scopes replace
DATA_READ / REPORTS_READ and the default grant, and who owns deployment, data and UI.

## Human Activation Gate Policy

Specialized agents under `.claude/agents/` are **locked by default**. Before invoking,
delegating to, or performing work assigned to one, Claude must require the user to run that
agent's activation command manually and paste the complete output here. The mechanics are
the `activation-gate` skill; the evidence each agent needs is in its own definition.

Claude must not run an activation or exit command on the user's behalf, simulate or infer
its output, accept "it passed" without the output, substitute another command, reuse a
PASS across tasks, or treat tool access as authorization. Human evidence is authoritative;
the gate exists so a human interacts with the development environment. The sequence is:
name the agent → state LOCKED → show the command → stop → validate the paste → reply
`GATE PASSED — <AGENT> ACTIVATED` or `GATE FAILED — <AGENT> REMAINS LOCKED` → work → exit
gate → `<AGENT> COMPLETE`. The same protocol governs the plays under `playbook/`.

## Agents and skills

Six agents (`architect`, `developer`, `reviewer`, `test-engineer`, `security-reviewer`,
`devops-engineer`) and nine skills (`activation-gate`, `implement-feature`,
`create-api-endpoint`, `database-change`, `debug-issue`, `write-tests`, `review-pr`,
`security-review`, `deploy-check`). Agents are *who*; skills are *how*. There is no
orchestrator agent by design. Use a subagent when work can run independently, isolated
context is valuable, specialist expertise is needed, or workstreams run in parallel. Do not
use one for trivial edits, single-file changes, simple searches, or tightly sequential work
that needs shared context. Claude instructions guide behavior; CI, branch protection and
required PR review enforce policy.

**These are development-tooling agents/skills, for building this repo.** They are distinct
from the domain-level "MCP Tools" and "Skills" described in the Domain section below, which
are the scheduling system's own runtime tools (`propose_schedule`, `commit_schedule`, etc.)
exposed to end users through the MCP server this repo builds. Don't conflate the two — an
`implement-feature` skill call and a `propose_schedule` MCP tool call are different layers.

## Where to start

- `playbook/README.md` — the run books. Play 04 is local development; Plays 05–12 stand up
  AWS, UAT and production; Play 14 is day-two operations. Follow them rather than
  improvising, and paste the evidence each play asks for.
- `infra/README.md` — Terraform runbook. **Read before touching any AWS resource.**
- `SECURITY.md` — non-negotiables.
- The **"Domain: One Off Apparel Scheduling System"** section below — read before touching
  any order/line-item/schedule/station logic or the domain-facing MCP tools.

## Environments

Both are AWS ECS Fargate, both defined in Terraform, both running the same image SHA
promoted from one to the other.

| | Production | UAT |
|---|---|---|
| URL | `https://__PRIMARY_DOMAIN__` | `https://uat.__PRIMARY_DOMAIN__` |
| Cluster | `__PROJECT_SLUG__-cluster` | `__PROJECT_SLUG__-uat-cluster` |
| Services | `__PROJECT_SLUG__-web`, `__PROJECT_SLUG__-mcp` | `__PROJECT_SLUG__-uat-web`, `__PROJECT_SLUG__-uat-mcp` |
| Secret | `prod/__PROJECT_SLUG__/app` | `uat/__PROJECT_SLUG__/app` |
| Terraform root | `infra/environments/production` | `infra/environments/uat` |

## Commands

- `pnpm install --frozen-lockfile` — `postinstall` runs SvelteKit sync and `prisma generate`; needs `DATABASE_URL` present (placeholder ok).
- `pnpm dev` / `pnpm run build` / `pnpm run preview` / `pnpm run start`.
- `pnpm run check` — svelte-check. **The primary correctness gate.** There is no linter and no test suite; say so rather than implying tests exist.
- `BUILD_TARGET=docker pnpm run build` — the `adapter-node` output ECS runs. A plain build only exercises `adapter-auto`. Keep both paths.
- `pnpm run test` — **not a test suite**: environment/DB diagnostic. Validates `DATABASE_URL`'s structure (shared rules with `scripts/fix-secret-database-url.sh`) before connecting.
- `pnpm run db:deploy` — apply committed migrations. `db:migrate` is `prisma migrate dev`, only for authoring against a database you own. After schema edits: `db:format`, `db:validate`, `db:generate`.
- `pnpm run mcp:dev` — standalone MCP server on port 3001, matching the deployed two-service shape.
- `pnpm run template:check` — zero-hit gate for placeholders, stray identifiers and email addresses.
- `./scripts/smoke-test.sh <base-url> [--skip-redirect] [--db-check <path>]` — the pipeline's promotion gate.

CI gates, in order: `db:validate`, `check`, `build`. Before pushing also run
`BUILD_TARGET=docker pnpm run build`; CI does not exercise the adapter the containers run.

## Architecture

Four boundaries: **SvelteKit** (UI, server routes, auth boundary), **Prisma + PostgreSQL**
(typed schema, canonical storage), the **MCP server** (read-only tool access), and
**connectors** (source-specific clients following one source → storage → MCP → interface
contract).

- `src/lib/server/mcp/handler.ts` is the shared MCP protocol/auth implementation; it
  imports no domain code and reads env through `process.env` (never `$env`, which the
  standalone process cannot resolve). Tools are the list in `src/lib/server/mcp/tools.ts`.
  `src/routes/api/mcp/+server.ts` is a same-origin fallback; production-equivalent MCP runs
  from `src/mcp-server/index.ts` on port 3001 and serves only `/health` and `/api/mcp`.
  `Dockerfile.mcp` runs through `tsx` and must `COPY` every directory the tools import.
- The ALB routes exact path `/api/mcp` to `mcp` and everything else to `web`. OAuth
  discovery, authorization, consent and token routes stay in SvelteKit.
- **MCP authorization** accepts three principals: a scoped `AgentToken`, a user
  `McpAccessToken` from the OAuth flow, or the legacy `MCP_SERVER_TOKEN` (unrestricted;
  see Play 02 step 4 for the required decision). For OAuth tokens the *effective* scope is
  computed live as the intersection of the token's scopes and the user's active
  `McpUserScopeGrant`s, so revocation applies on the next request. Tools register
  unconditionally; `guardedToolResult` is the gate.
- Scopes are the `McpScope` enum plus one map in `src/lib/server/mcp/scopes.ts`. Adding a
  scope is those two edits (plus a migration); the admin UI and discovery follow.
- Admin is one `/admin` route with `?screen=agents|clients|activity|users`; only
  `/admin/users/[id]` is a separate route.
- Svelte 5 runes mode is forced in `vite.config.ts` (there is no `svelte.config.js`):
  `$props`, `$state`, `$derived`, `$effect`, event properties. No legacy syntax.
- `vite.config.ts` disables SvelteKit's origin check because standards-compliant OAuth
  token requests carry no `Origin`. Cookie routes rely on `SameSite=Lax`; token exchange
  relies on PKCE, single-use codes and client/redirect validation. Do not toggle either in
  isolation.
- Identity strings (display name, slug, cookie name, token prefix, storage-key prefix)
  come from `src/lib/appConfig.ts`. `src/app.html` repeats the storage-key prefix because
  it cannot import; keep them equal.

---

## Domain: One Off Apparel Scheduling System

This section is the business-domain design for what this instance of the platform template
is actually being built to do. It sits inside the four architectural boundaries above (UI in
SvelteKit, canonical storage in Prisma/PostgreSQL, domain tools exposed read-and-write
through the MCP server, Hoops as the one connector). Everything below assumes those
boundaries and does not redefine them.

### What this system is

A production scheduling system for a custom apparel decorator (screen print, embroidery,
DTF, DTG). Orders come in through Hoops (no usable API — manual export only). Claude reads
the export, a human confirms it, a deterministic engine proposes a schedule, a human
approves it, and the result shows up on both a chat interface and a production board — same
data, no separate write path.

### When unsure, ask — don't assume

If anything in this section is ambiguous, missing, or seems to conflict with what you find
in the codebase, stop and ask rather than guessing or picking a reasonable-sounding default.
This applies especially to:

- Anything touching the domain schema below (field meaning, a new field, a dependency rule)
  — the `depends_on` / `sequence_order` split exists specifically because an earlier design
  pass silently conflated two different concepts. Don't repeat that pattern.
- Anything in "Known open items" below — those are open because they need a decision from
  the client, not because they need Claude to pick something reasonable and move on.
- Business logic that isn't explicitly documented here (a formula, a threshold, a status
  transition) — check the source spreadsheet or ask, don't infer from a similar-looking
  case elsewhere in the code.

A wrong guess here costs real production time for a real shop. Asking is always cheaper
than an incorrect assumption shipping quietly. (This is in addition to, not a replacement
for, the repo-wide instruction above to re-derive project state from disk.)

### Non-negotiable design principles

- **Claude never computes hours or schedules itself.** All math (time estimates,
  slot-finding, batching) happens in deterministic engine code, not in an LLM call. Claude's
  job is to call MCP tools, explain results, and hold a conversation — never to "figure out"
  a schedule on its own.
- **Two human approval gates, both required:**
  1. Import confirmation — Claude parses the Hoops export, flags anything it's unsure of,
     and a person confirms before any of it becomes schedulable.
  2. Schedule approval — the engine proposes a schedule with reasoning, and a person
     approves before it's committed.
- **Nothing commits without a human.** `propose_schedule` never writes to the real schedule.
  Only `commit_schedule`, called after approval, does.
- **Conflicts get flagged, not hidden.** If a job can't hit its due date, it's surfaced
  (`flag_at_risk`), never silently dropped or silently rescheduled without saying why.

### Database note specific to this domain

The domain's Postgres database is **AWS RDS for Postgres**, provisioned via the Terraform
roots described earlier in this file — not Neon, not any other provider. If you see "Neon"
anywhere in domain code, comments, or docs, that's stale and should be corrected. No
additional infrastructure pattern beyond what's already documented above under
Infrastructure/Environments is needed for this — the domain reuses the platform's existing
ECS/RDS/Terraform setup rather than introducing a second one.

### Domain data schema (Prisma models, canonical storage)

#### `orders`
One row per order.

| field | notes |
|---|---|
| `id` | |
| `hoops_order_id` | back-reference to Hoops |
| `customer_name` | |
| `external_ship_date` | promised to the customer |
| `internal_due_date` | what production actually works toward |
| `status` | `needs_review`, `confirmed`, `scheduled`, `in_production`, `complete` |
| `imported_by` | who brought it in (usually "claude") |
| `created_at` | |

`orders.status` only flips to `complete` automatically, via `check_completion()` — see
Engine section. Never set it to `complete` directly from application code.

#### `line_items`
One row per **design/print job or finishing step** on an order.

| field | notes |
|---|---|
| `id` | |
| `order_id` | FK to `orders.id` |
| `item_type` | `"decoration"` or `"finishing"` — governs how every field below behaves |
| `design` | what the design is |
| `print_location` | front, back, left, or right |
| `decoration_type` | screen print / embroidery / DTF / DTG — **decoration rows only**, blank on finishing rows. Determines the primary `station_id` via lookup. |
| `finishing_step` | matte / relabel / fold & bag / hang tag — **finishing rows only**, blank on decoration rows |
| `depends_on` | **finishing rows only.** Either another `line_items.id` (this finish waits on one specific job — e.g. matte waits on the print it's finishing) or the literal string `"all_siblings"` (this finish waits on every other line item under the same order — this is how fold & bag / final packaging works: it can't start until every decoration *and* every other finish on that order is done) |
| `status` | `needs_review`, `blocked`, `in_production`, `complete`. Finishing rows are created with `status: blocked` and only become schedulable once `check_completion()` unlocks them. |
| `weight_class` | thin, poly, or bulky |
| `apparel_color` | text — the garment color (e.g. "Grey") |
| `ink_color_count` | int — number of colors in the decoration itself. This is the "X" variable in the spreadsheet formulas, used for both screen-print ink setup and embroidery thread-change time. Do not confuse with `apparel_color` — they used to be conflated into one ambiguous `colors` field; they are not the same thing. |
| `screens` | how many screens (screen print only) |
| `stitch_count` | embroidery only |
| `quantity` | total units |
| `size_breakdown` | units per size |
| `estimated_hours` | jsonb — how long it should take, per station |
| `review_confidence` | how sure Claude was when reading this in from the export |

**Key rule to preserve:** a physical garment with a front print and a back embroidery is
**two line items sharing one `order_id`**, not one line item. If it also gets a matte
finish and then fold & bag, that's two more line items (`item_type: finishing`), each with
its own `depends_on`. An order with a print, an embroidery, and two finishes is four rows
in this table.

#### `stations`
One row per machine/station.

| field | notes |
|---|---|
| `id` | |
| `name` | e.g. "screen_print_auto" |
| `type` | what kind of station it is |

#### `capacity_calendar`
How much time each station has open, per day.

| field | notes |
|---|---|
| `station_id` | FK |
| `date` | |
| `available_hrs` | hours open that day |

#### `schedule_assignments`
The actual schedule — one row per job assigned to a slot.

| field | notes |
|---|---|
| `id` | |
| `line_item_id` | FK |
| `station_id` | FK |
| `date` | |
| `sequence_order` | **Batch ordering only** — where in a station's queue this job runs that day, so similar-setup jobs run back-to-back (the ATCS heuristic). This is NOT for cross-step dependency — that's what `depends_on` on `line_items` is for. Do not repurpose this field to enforce "step B after step A" logic; that redesign was tried and removed (see Engine section). |
| `estimated_hours` | |
| `status` | `proposed`, `approved`, `in_progress`, `complete` |
| `proposed_by` | usually "claude" |
| `approved_by` / `approved_at` | |
| `started_at` | set when the "Start" button fires on the Production Board |
| `completed_at` | set when the "Stop" button fires |

#### `actuals`
Historical record of real time taken, for validating estimate formulas.

| field | notes |
|---|---|
| `line_item_id` | |
| `station_id` | |
| `actual_hours` | `completed_at` minus `started_at`, written when a station is marked done |
| `completed_at` | |

#### `audit_log`
Everything that happened, for accountability. (Distinct from any generic activity log the
platform template already provides for `/admin?screen=activity` — this one is
domain-specific to orders/schedule/line-item changes; if the template's admin activity log
can absorb this instead of a separate table, raise that as a question, don't assume either
way.)

| field | notes |
|---|---|
| `entity` / `entity_id` | what changed, which one |
| `action` | what happened |
| `actor` | who did it |
| `diff` | what changed |
| `at` | when |

### The engine (deterministic, runs server-side — not an MCP tool itself, called by them)

#### `estimate_hours(item)`
Works out how long one job takes. Each station's formula is a direct port of one table from
the client's own "Consolidated IT" spreadsheet tab — unit-tested against the spreadsheet's
own numbers, not re-derived. Variables throughout: `X` = ink/thread color count
(`ink_color_count`), `Y` = screen count (screen print only), `Z` = quantity.

**`screen_print_auto`** — per print location. `screens < 5` and `screens > 4` are two
*different* rate regimes, not one flat table: