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
read it before touching any order/schedule/line-item logic.

**Build status:** schema (`prisma/schema.prisma`), the engine (`src/lib/server/engine/`),
the Hoops import persistence layer (`src/lib/server/hoops/`), the schedule persistence
layer (`src/lib/server/schedule/`), and all six domain MCP tools
(`src/lib/server/mcp/tools.ts`) are built and merged. **Still a shell, not end-to-end
schedulable:** `estimate_hours` has real numbers for none of the six stations — every
station still throws `MissingFormulaError` (see the engine section and Known open items)
— so `propose_schedule`/`simulate_change` will flag every real job at_risk until the
client's actual Consolidated IT rate tables land. No file parser exists for the Hoops
export itself (format still undocumented); `import_hoops_export` takes already-structured
data, not a raw file. Also record here the decisions Play 13 asks for: the
MCP_SERVER_TOKEN choice, which scopes replace DATA_READ / REPORTS_READ and the default
grant (three domain scopes — `SCHEDULE_READ`, `IMPORT_WRITE`, `SCHEDULE_WRITE` — were added
alongside the originals for the six domain tools, not yet a full replacement/default-grant
decision), and who owns deployment, data and UI.

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
| URL | `https://ooa.launchpadphilly.org` | `https://uat.ooa.launchpadphilly.org` |
| Cluster | `ooa-cluster` | `ooa-uat-cluster` |
| Services | `ooa-web`, `ooa-mcp` | `ooa-uat-web`, `ooa-uat-mcp` |
| Secret | `prod/ooa/app` | `uat/ooa/app` |
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

<!-- INCOMPLETE — cut off mid-edit. Needs: the actual screen_print_auto rate table for
both regimes (screens < 5 and screens > 4), then the same per the client's Consolidated
IT sheet for embroidery, matte, relabel, fold_bag and hang_tag (see Known open items
below for which of those don't have a portable formula at all yet). Until this is
filled in, estimate_hours must keep throwing MissingFormulaError rather than guess. -->

#### `check_completion(line_item_id)`
Runs the moment the "Stop" button fires for the **last** station on a line item. This is
part of the start/stop + actuals flow, not the scheduling flow — do not call this from
inside `propose_schedule`.

```
function check_completion(line_item_id):
  mark line_item complete

  for each other line_item under the same order_id:
    if other.status == blocked:
      if other.depends_on == line_item_id:
        unlock other           // e.g. matte was waiting specifically on this one
      elif other.depends_on == "all_siblings":
        if every sibling except `other` itself is now complete:
          unlock other         // e.g. fold & bag was waiting on everyone

  if every line_item under order_id is complete:
    orders.status = complete
```

#### `propose_schedule(backlog, capacity)`
Builds a proposed schedule. Never writes to the live schedule — that only happens in
`commit_schedule`, after human approval.

```
function propose_schedule(backlog, capacity):
  jobs = backlog.map(estimate_hours)     // backlog only ever contains
                                          // status: needs_review — blocked
                                          // line items never reach here
  jobs.sort_by(due_date)                 // due date is the hard floor

  for job in jobs:
    best_slot = find_slot(job, capacity, prefer: batch_with(job, jobs))
    // batch_with groups jobs by shared setup — same ink color / screen
    // count / decoration type — this is the ATCS heuristic, published,
    // not invented here. This is what sequence_order is for.

    if best_slot is None:
      flag_at_risk(job)                  // due date can't be met — surfaced
    else:
      assign(job, best_slot)

  return { assignments, reasoning: explain(assignments) }
```

**Do not reintroduce dependency-checking inside `propose_schedule`.** An earlier draft of
this engine tried to enforce step order here (checking a prior assignment's date before
placing a job), which caused `sequence_order` to mean two conflicting things at once.
Dependency ordering is now handled entirely by `line_items.depends_on` + `check_completion`
— a blocked line item is simply never in the backlog. Keep it that way.

### Domain MCP tools (exposed through this repo's MCP server, distinct from dev-tooling agents/skills above)

| tool | does |
|---|---|
| `import_hoops_export(file)` | reads the export, pulls out order info, returns `{ order_ids[], line_items[], confidence_flags[] }` |
| `confirm_import(order_ids[], corrections?)` | locks the import in as real once a person has checked it |
| `get_schedule(date_range, station_id?)` | looks up what's currently scheduled |
| `propose_schedule(date_range)` | builds a suggested schedule, does not save it |
| `commit_schedule(assignment_ids[], approved_by)` | makes a proposed schedule official, writes to `schedule_assignments` + `audit_log` |
| `simulate_change(change)` | checks "what if" (a rush order, a moved job) without actually changing anything |

Each of these is a real MCP tool registered the same way as any other tool in
`src/lib/server/mcp/tools.ts`, gated by `guardedToolResult` and the scope system described
in Architecture above — these are not a separate auth mechanism.

### Domain skills (conversational, built by composing the tools above)

- **Import Hoops export** — hand Claude the export file, it pulls out orders and flags
  anything it's unsure of
- **Data completeness check** — ask what's missing, Claude scans orders for gaps (no due
  date, no color count, etc.)
- **Propose the schedule** — ask Claude to build the schedule; it works out a plan and
  explains why, then waits for approval
- **Rush / what-if** — "can we get this out by Friday?" — Claude tests it against real
  capacity via `simulate_change`
- **Daily brief** — what does today look like; Claude summarizes what's running and what's
  at risk

Skills are not 1:1 with tools — a skill composes whichever tools it needs.

### Known open items — do not silently resolve these, they need a decision

- **Blank/apparel inventory is not modeled.** Nothing currently confirms stock exists for a
  given style/color/size before scheduling. Needs a decision with the client: (a) a manual
  confirmation checkbox at import time, or (b) a real inventory table synced from wherever
  blanks are tracked. Do not silently add a full inventory system without that conversation
  happening first.
- **Cure/dry buffer between a print and a downstream finish** (e.g. how long before a fresh
  print can be matte-finished or bagged) is not yet captured anywhere. Needs a real number
  from the client before `depends_on` unlocking is treated as "immediately schedulable."
- **PDF/export import accuracy** has not been validated against a real Hoops export sample
  — only against the client's spreadsheet formulas.
- **`LineItem` is missing the categorical fields the Fold & Bag and Matte formulas
  actually need.** The current schema only has `weightClass` (Thin/Poly/Bulky). Per the
  client's "Consolidated IT" sheet: Fold & Bag is keyed on "SS Tee" vs "Other," not weight
  class at all; Matte is keyed on weight class *and* a second dimension, "Surface = Flat"
  vs "Surface = Specialty," which uses a different formula entirely. Neither category
  exists in the schema yet. Must be added — as a new nullable field or two, decoration
  rows leave it null — before the engine PR ports `estimate_hours` for those two stations,
  or those two formulas will be unimplementable as specified.
- **Relabel has no formula in the source spreadsheet at all.** Unlike the embroidery
  poly/bulky gaps (missing constants in an otherwise-real table), the Relabel tab was never
  built out — there is no table to port. `estimate_hours` must keep throwing
  `MissingFormulaError` for this station. This is a direct question for Jeff, not something
  to fill in from a similar-looking station.
- **DTF and DTG are dropdown values with no backing station or formula.** They appear as
  valid `decoration_type` choices on the order form, but nothing in the spreadsheet defines a
  station or production-time formula for either. Needs a scope decision from Jeff: are these
  actually offered today, and if so, what are their formulas? Do not map them onto an
  existing station as a stand-in.
- **Production board (provisional).** `/schedule` (`src/routes/schedule/`) is a bare,
  unstyled scaffold — a flat list of every `approved`/`in_progress` `schedule_assignments`
  row with Start/Stop buttons, gated on the `SCHEDULE_READ`/`SCHEDULE_WRITE` scopes already
  used by the domain MCP tools. It exists only so Start/Stop → `started_at`/`completed_at`
  → `check_completion` (on the last incomplete assignment for a line item) has somewhere to
  run from. Not decided, not invented: the route path (`/schedule` is a placeholder, rename
  freely), the actual layout/grouping (per-station queue? per-day? per-order? nothing says),
  any visual design, and whether/when `LineItem.status` should move to `in_production` (Start
  currently leaves it untouched — same category of gap as "when does `Order.status` become
  `scheduled`," left alone rather than guessed). Do not treat this route's current shape as
  a real spec — it's scaffolding pending a real answer on all four points above.

### Domain naming conventions to keep consistent

- Timestamps: `started_at` / `completed_at`, not `start_time` / `end_time` — an earlier
  draft used both names for the same concept across two tables; keep it to one convention.
- `apparel_color` vs `ink_color_count` are never the same field. If you see a single
  `colors` field anywhere, that's stale pre-redesign schema.
- `sequence_order` = batch ordering within one station's day. `depends_on` =
  cross-line-item dependency. Never conflate the two.

---

## Environment loading (four mechanisms)

SvelteKit/Vite loads `.env.local` itself; `src/hooks.server.ts` also loads it into
`process.env` for shared server code. The Prisma CLI does not, so `prisma.config.ts` loads
it explicitly. The MCP process (`src/mcp-server/load-env.ts`) and `scripts/test.ts` load it
independently. Every loader uses a path relative to the repository root. A new database
script must load `.env.local` explicitly before importing anything that instantiates Prisma.

Real local values live only in ignored `.env.local`; never print or commit populated env
files. Check presence with `grep -c '^NAME=' .env.local`, never `NAME=.*`.

## Infrastructure (Terraform, `infra/`)

Roots: `bootstrap` (state bucket, local state), `global` (ECR + GitHub OIDC deploy role),
and one per environment copied from `environments/example`.

- **CI owns task-definition revisions.** Services set `ignore_changes = [task_definition]`; `terraform apply` is never a deploy. After changing `image_uris`, an explicit `aws ecs update-service` is still required.
- **Terraform manages secret containers, never values.** No `aws_secretsmanager_secret_version` resource may be added.
- Backends take no variables: `terraform init -backend-config=../my.backend.hcl` (see `infra/example.backend.hcl`).
- Never apply a plan containing a replacement or a destroy without an explicit, recorded decision.
- The activation gate in `infra/modules/environment/ecs.tf` is a `check` block: it warns, it does not refuse. Play 10's evidence rule is the real gate.
- All AWS infrastructure for this project — including anything the Domain section above
  needs — is provisioned via this same Terraform setup. Do not hand-configure resources in
  the AWS console, and do not stand up a second, parallel Terraform structure for the
  domain; extend the existing environment roots instead.

## CI/CD Pipeline

`deploy.yml` on push to `main`: `build → deploy-uat → smoke-test-uat`, then **stops**.
`deploy-production.yml` is `workflow_dispatch` only and promotes an already-built SHA,
refusing any SHA not in ECR. Both images are built once and promoted unchanged. Do not
chain production onto the push pipeline.

In each environment: render both task definitions, run `prisma migrate deploy` as a
**blocking one-off `run-task`** (nonzero exit fails the workflow), then roll out both
services. The GitHub environment names `UAT` and `Production` are **not cosmetic**: the
OIDC trust policy checks them in the token subject.

## Database and secrets

One flat JSON secret per environment; ECS injects individual keys via `valueFrom`. The
authoritative key lists are `web_secret_keys` and `mcp_secret_keys` in the environment
root's `variables.tf`. A key listed there but absent from the JSON fails task start; a key
in the JSON but not listed never reaches the container. Nothing enforces the match.

**Both containers read the same `DATABASE_URL`.** ECS resolves secrets at task start, so
a value change reaches a service only on redeploy — always redeploy both.

## Verification limits

State what was verified and how. `svelte-check` proves types, not behavior; a green smoke
test proves liveness, not that a secret value is valid (a broken secret fails the *next*
deploy). RDS is private, so schema and data work runs as one-off ECS tasks. Two
connection-string faults recur: `terraform output db_endpoint` already ends in `:5432`,
and RDS-managed passwords contain `#`/`?`/`|` that must be percent-encoded. When live
state contradicts a document, report both readings rather than "fixing" either.

After any deploy that changes MCP tool definitions, connected MCP clients keep a stale
tool list until they reconnect; the server is stateless per request and cannot push it.

## Security constraints (non-negotiable)

- Connector credentials load server-side only — never in browser-reachable code paths or `PUBLIC_*` variables.
- All database queries are parameterized; validate tool inputs with Zod.
- MCP tools are read-only by default: no DELETE/UPDATE/INSERT/DROP, unless explicitly
  approved as a scoped exception (see the domain-specific note below).
- Logs never contain tokens, connection strings, raw upstream payloads, or sensitive data.
- Environment variables are validated at startup/first use without printing values.

**Domain-specific note — decision recorded:** the read-only-vs-write conflict this section
used to flag is resolved: domain write-tools are an **approved, scoped exception**, not
moved behind a separate server-action boundary. `import_hoops_export`, `confirm_import`
and `commit_schedule` are real MCP tools with `readOnly: false` (`McpToolDefinition` in
`src/lib/server/mcp/handler.ts` now carries a per-tool `readOnly` flag instead of a
hardcoded blanket `true`), each gated by its own scope (`IMPORT_WRITE` / `SCHEDULE_WRITE`)
and one of CLAUDE.md's two human approval gates — never a bare write with nothing in front
of it. Rationale: "no separate write path" in the Domain section's "What this system is"
implies one write path shared by chat and the production board, not two; splitting
confirmation out to a UI-only action would contradict that. See
`src/lib/server/mcp/tools.ts` for the six registered tools.

## Git and definition of done

Feature branches only; no direct commits to `main`; a PR with one approving review and
green CI is required. A change is complete when acceptance criteria are satisfied,
`db:validate`, `check`, both builds and any existing tests pass, the relevant
documentation (README, this file, the affected play, `.env.example`, key lists) is
updated, and the agent's exit gate has passed on pasted evidence.

## Working notes

<!-- Team ownership, pinned versions and why, dataset caveats, open decisions. -->

- Versions pinned to current stable: Node 24, pnpm 11, Prisma 7 (driver-adapter via `@prisma/adapter-pg`), Svelte 5 runes, TypeScript 6. Check `pnpm peers check` before bumping.