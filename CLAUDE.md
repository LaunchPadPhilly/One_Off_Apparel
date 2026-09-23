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
layer (`src/lib/server/schedule/`), all six domain MCP tools (`src/lib/server/mcp/tools.ts`),
and a first UI pass — Orders (`src/routes/orders/`, plus `/orders/archive`), an extended
Schedule/Production board (`src/routes/schedule/`), and a minimal Reports page
(`src/routes/reports/`) — are built and merged. Real Hoops PDF extraction now exists
(`src/lib/server/hoops/extractOrderFromPdf.ts`, via the Claude Messages API — needs
`ANTHROPIC_API_KEY`) rather than a deterministic parser. **Still not end-to-end
schedulable:** `estimate_hours` now has real numbers for every station
(`screen_print_auto`, `embroidery`, and all five finishing steps — matte, relabel,
fold_bag, hang_tag, wovens, added 2026-09-23); only DTF/DTG still throw
`MissingFormulaError` (see the engine section and Known open items). Even with real
formulas, `propose_schedule` still needs `Station`/`CapacityCalendar` rows
that barely exist in the real database — nothing in the app can create a *real* one
today. `fetchCapacity()` now fills that gap with a stand-in default (7.5h/day per known
station, matching the drafts workspace's own display fallback — see
`$lib/schedule/defaultCapacity.ts`, 2026-09-22) so a job with a real estimate but no real
capacity data no longer automatically comes back at_risk; a real `CapacityCalendar` row
still always overrides the default the moment one exists. A job still comes back
at_risk for a real reason (no formula / this job is missing a required field / its due
date already fell before the draft's window even starts) instead of one blanket cause.
Also record here the decisions Play 13
asks for: the MCP_SERVER_TOKEN choice, which scopes replace DATA_READ / REPORTS_READ and
the default grant (four domain scopes now — `SCHEDULE_READ`, `IMPORT_WRITE`,
`SCHEDULE_WRITE`, `ORDERS_READ` — added alongside the originals, not yet a full
replacement/default-grant decision), and who owns deployment, data and UI.

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
| `internal_due_date` | what production actually works toward — always computed as `external_ship_date` − 14 days, never an independent input (see Known open items) |
| `status` | `needs_review`, `confirmed`, `scheduled`, `in_production`, `complete`, `cancelled` |
| `imported_by` | who brought it in (usually "claude") |
| `created_at` | |

`orders.status` only flips to `complete` automatically, via `check_completion()` — see
Engine section. Never set it to `complete` directly from application code.

`cancelled` is Orders' "delete" (`cancelOrder.ts`, 2026-09-21) — deliberately
non-destructive: it only changes `status`, never removes the order or its line items,
schedule assignments or actuals. Blocked once an order is already `complete` (nothing
left to cancel) or already `cancelled`. A cancelled order drops out of the active
`/orders` list and `fetchBacklog()` (which only ever selects `confirmed` orders) with no
extra code, and shows up in `/orders/archive` alongside `complete` orders — that route
is a filtered view over both terminal statuses now, not a second archiving mechanism.

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
| `weight_class` | thin, poly, or bulky — meaningful for **flat** garments; null/ignored when `garment_style` is `cap` |
| `garment_style` | `flat` or `cap` — **decoration rows only**, meaningful today for embroidery's formula (flat and cap use genuinely different rate tables, not a weight-class variant — see estimate_hours below) |
| `cap_construction` | `structured` or `unstructured` — **only meaningful when `garment_style` is `cap`**, null otherwise |
| `apparel_color` | text — the garment color (e.g. "Grey") |
| `ink_color_count` | int — number of colors in the decoration itself. Used for screen-print ink setup and embroidery thread-change time — but is the "X" variable in screen print's formula and the **"Y" variable in embroidery's** (the letter mapping isn't consistent across stations — see estimate_hours below). Do not confuse with `apparel_color` — they used to be conflated into one ambiguous `colors` field; they are not the same thing. |
| `screens` | how many screens (screen print only) |
| `stitch_count` | embroidery only — the "X" variable in embroidery's formula (not `ink_color_count`) |
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
own numbers, not re-derived. Variables are **not consistent across stations** — confirmed
directly with the client per station, do not assume one station's letter mapping applies to
another:
- `screen_print_auto`: `X` = ink color count (`ink_color_count`), `Y` = screen count
  (`screens`), `Z` = quantity.
- `embroidery`: `X` = stitch count (`stitch_count`), `Y` = thread/ink color count
  (`ink_color_count`), `Z` = quantity — the **opposite** pairing of X/Y from screen print.

**`screen_print_auto`** — per print location. `screens < 5` and `screens > 4` are two
*different* rate regimes, not one flat table. Confirmed with the client (2026-09-18) and
implemented in `estimateHours.ts`:

```
initial_units = { thin: 100, poly: 80, bulky: 50 }        // does not vary by regime
rate_per_hr (screens < 5)  = { thin: 360, poly: 288, bulky: 180 }
rate_per_hr (screens > 4)  = { thin: 180, poly: 144, bulky: 90 }

setup = screens*5 + ink_color_count*15 + 30 + 30           // minutes
run   = max(0, quantity - initial_units[weight_class]) * (60 / rate_per_hr[weight_class])
hours = (setup + run) / 60
```

**`embroidery`** — confirmed with the client (2026-09-21) and implemented in
`estimateHours.ts`. Flat garments and headwear ("Cap") are genuinely different formulas,
not a weight-class variant of one table — this is why `LineItem` gained `garmentStyle`
(`flat`/`cap`) and `capConstruction` (`structured`/`unstructured`, cap-only) fields. Blank
cells in the client's table were confirmed to mean "identical to the row above," not
zero/N/A — several rows below intentionally share a constant for that reason:

```
thread_change = ink_color_count * 5                          // minutes, same for flat and cap

// flat (by weight_class)
setup_boxing_divisor = { thin: 240, poly: 180, bulky: 120 }
hooping_factor        = { thin: 1.5, poly: 2,   bulky: 1.5 }
load_unload_factor    = 2                                     // same across all three
cleanup_factor         = { thin: 4,   poly: 6,   bulky: 4 }
sew_rate_divisor       = 850                                   // same across all three

// cap (by cap_construction)
setup_boxing_divisor = 240                                     // same for both
hooping_factor        = { structured: 1,   unstructured: 2.5 }
load_unload_factor    = 1                                       // same for both
cleanup_factor         = 1.5                                    // same for both
sew_rate_divisor       = 650                                    // same for both, lower than flat's 850

setup_boxing = quantity * (60 / setup_boxing_divisor)
hooping      = (quantity/6) * hooping_factor
load_unload  = (quantity/6) * load_unload_factor
cleanup      = (quantity/6) * cleanup_factor
sew_time     = (quantity/6) * (stitch_count / sew_rate_divisor)

hours = (setup_boxing + thread_change + hooping + load_unload + cleanup + sew_time) / 60
```

**Not implemented: "Steaming (IF Dark/Pigment)".** The client's table has a real Steaming
step for flat garments (`quantity * (60/360)` minutes, N/A for caps), conditional on the
garment being dark or using pigment ink. Nothing in the schema signals that today —
`apparel_color` is free text, not a light/dark flag — and inferring "dark" from a color
string would be exactly the kind of guessed business logic CLAUDE.md says to ask about
instead. Every embroidery estimate is therefore a slight underestimate for dark/pigment
jobs until a real signal exists (a new boolean field, most likely). `estimateHours.ts`
flags this in a doc comment; it is not silently wrong, just deliberately incomplete.

**Finishing steps** — from the client's finishing flowcharts (provided 2026-09-23) and
implemented in `estimateHours.ts`. Every one is a flat per-garment time,
`hours = quantity * minutes_per_unit / 60`:

```
printed_relabel (RELABEL)   minutes/unit = 60 / { thin: 144, poly: 144, bulky: 72 }
hang_tags (HANG_TAG)        minutes/unit = 60 / { thin: 300, poly: 300, bulky: 150 }
fold_bag (FOLD_BAG)         minutes/unit = 60 / { ss_tee: 300, other: 100 }   // fold_bag_garment, NOT weight class
matte_finish (MATTE), flat  minutes/unit = 70 / { thin: 200, poly: 200, bulky: 100 }   // numerator is 70, per the chart
matte_finish, specialty     minutes/unit = 1                                   // same for every weight class
wovens (WOVENS)             minutes/unit = 60 / 90                             // ASSUMED — see below
```

`matte_surface` (`flat`/`specialty`) and `fold_bag_garment` (`ss_tee`/`other`) are
nullable `LineItem` fields for finishing rows only; a MATTE / FOLD_BAG row without its
field set throws `MissingLineItemDataError`, never a guessed default. **Wovens is
provisional:** the client's chart reads `QO * (60/90)` with no trailing `/ 60`, unlike
every other chart, and the client calls it not fully thought out. The engine assumes the
`/ 60` was left off (90 units/hour) — a decision made 2026-09-23 pending the client's
final formula. Read literally it would be 40 minutes per garment.

Still open, per Known open items below: `screen_print_auto`'s "Manual" variant (the
client's own sheet marks it "never fully developed" — every cell blank, nothing to port),
the Wovens formula (see above), and DTF/DTG (no station or formula defined at all). `estimate_hours` keeps throwing
`MissingFormulaError` for all of those until each is resolved. Separately,
`MissingLineItemDataError` (not a station-level gap) fires when a station's formula is
real but one specific job is missing a required field — e.g. an embroidery line item with
no `garmentStyle` set yet; a human resolves this by editing the line item, not by a
schema/decision change.

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
                                          // line items never reach here.
                                          // fetchBacklog() also excludes any
                                          // order whose due date has already
                                          // passed (2026-09-22) — see Known
                                          // open items; those never reach here
                                          // either, not even as a fallback.
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
| `add_order_note(hoops_order_id, note)` | *(added 2026-09-18, not in the original design)* appends a dated, attributed note to an order — the way a note given in conversation reaches `Order.notes` (and from there the order's page and Reports) without the web form |

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
- **Finishing formulas — resolved (2026-09-23), except Wovens.** The client supplied
  flowcharts for Printed Re-Label, Fold & Bag, Hang Tags, Matte (flat and specialty
  surface) and Wovens; all are now implemented (see estimate_hours above), and
  `LineItem.matteSurface` / `LineItem.foldBagGarment` were added for the two that aren't
  keyed on weight class. Still open: the Wovens formula itself (assumed 90 units/hour —
  confirm with the client), and `extractOrderFromPdf.ts` only fills `matteSurface` /
  `foldBagGarment` when the export states them clearly, so most imported MATTE and
  FOLD_BAG rows will need them set by hand on the order page.
- **DTF and DTG are dropdown values with no backing station or formula.** They appear as
  valid `decoration_type` choices on the order form, but nothing in the spreadsheet defines a
  station or production-time formula for either. Needs a scope decision from Jeff: are these
  actually offered today, and if so, what are their formulas? Do not map them onto an
  existing station as a stand-in.
- **Production board (provisional).** `/schedule` (`src/routes/schedule/`) is gated on
  the `SCHEDULE_READ`/`SCHEDULE_WRITE` scopes already used by the domain MCP tools. It
  covers the whole flow, not just Start/Stop: a date window (default 28 days from
  today — an arbitrary "3-4 weeks" pick, not a spec), grouped by date, showing
  proposed/approved/in-progress assignments with Propose, Approve (`commit_schedule`),
  Edit/Remove (proposed only — reassigning station/date, or deleting the draft so its
  line item returns to the backlog), and Start/Stop → `started_at`/`completed_at` →
  `check_completion`. Received a visual/UX pass (2026-09-21): a stat-tile summary
  (jobs placed / jobs at risk) instead of a plain sentence, at-risk jobs grouped into
  three collapsible cards by *why* they're blocked (no formula / missing job data / no
  capacity — the same three-way split `explainAtRisk.ts`'s `AtRiskCategory` already
  made, now with an icon+color per category instead of one undifferentiated list), and
  a standing banner when zero `Station`/`CapacityCalendar` rows exist at all (rather
  than only surfacing that after a Propose click). Still not decided, not invented: the
  route path (`/schedule` is a placeholder, rename freely), the actual layout/grouping
  (per-station queue? per-day? per-order? this is still a day-grouped flat list, just a
  better-looking one), the 28-day default window, and whether/when `LineItem.status`
  should move to `in_production` (Start currently leaves it untouched — same category
  of gap as "when does `Order.status` become `scheduled`," left alone rather than
  guessed). Do not treat this route's current shape as a real spec — it's scaffolding
  pending a real answer on all four points above, just no longer an unstyled one.
- **Drafts: manual and automatic creation, both gated on CONFIRMED orders
  (2026-09-22).** `/schedule/new` (manual — pick a name/window/strategy, then place line
  items yourself in `/schedule/drafts/[id]`'s drag-and-drop workspace) and a new "Create
  automatic schedule" button on `/schedule` (`proposeIntoNewDraft.ts`) are both real now.
  The automatic path runs the exact same deterministic `propose_schedule` engine the
  `propose_schedule` MCP tool already calls (`fetchBacklog` + `fetchCapacity` +
  `proposeSchedule`, unchanged) — no LLM decides placements, per this file's
  non-negotiable "Claude never computes a schedule" rule — and lands its output in a
  brand-new `ScheduleDraft` (`scheduleDraftId` set on every row), a 4-week window
  starting today. The MCP tool's own direct path (`proposeAndPersistSchedule.ts`) is
  unchanged and still writes un-drafted `PROPOSED` rows with no `scheduleDraftId` — the
  two coexist by design, not a duplication to clean up. Fixed a real gap while wiring
  this in: the manual draft workspace's candidate-order list used to be every order not
  `COMPLETE` (including `NEEDS_REVIEW`, which hasn't passed the import-confirmation
  gate) — now `CONFIRMED` only. Deliberately NOT the full `fetchBacklog()` gate set
  (blanks received, customer approval, artwork approval) for the *manual* path — a human
  planning ahead can still place a confirmed order before every pre-production gate is
  finalized; only the automatic engine path enforces every gate. Four follow-up fixes
  (2026-09-22): (1) the CONFIRMED-only rule is now enforced server-side in
  `placeAssignment` itself, not just by what the candidate sidebar shows — the sidebar
  filter never stopped a direct POST from attaching a NEEDS_REVIEW order's line item.
  (2) The automatic engine's placements now get a real `startMinuteOfDay`, not just a
  date/station/sequenceOrder — `$lib/schedule/shift.ts` (the 8:00–16:30 shift + break
  model, shared with `drafts/[id]/+page.svelte`'s rendering so the two can never drift
  apart) packs each station/day's jobs back-to-back in `sequenceOrder` via
  `packSequentialStarts`, skipping breaks automatically. Before this, every
  engine-placed job defaulted to the same 8:00 slot (`startMinuteOfDay ?? 8*60` in the
  load function) and visually stacked on top of each other until a human dragged them
  apart; a freshly-created automatic draft now already shows its jobs laid out on the
  timeline in batch order, no manual dragging needed to make it look right. (3)
  `fetchCapacity()` now assumes `DEFAULT_STATION_DAY_HOURS` (`$lib/schedule/
  defaultCapacity.ts`) for any (station, day) with no real `CapacityCalendar` row —
  before this fix, every automatic run came back "0 placed" with everything at risk,
  since the deterministic engine saw zero capacity everywhere even though the drafts
  workspace's own timeline was already *displaying* that same 7.5h/day default as a
  cosmetic fallback. This is a real, visible business assumption (every known station
  open every day, including weekends, until real numbers are entered), not an invented
  fact — a real `CapacityCalendar` row always overrides it the moment one exists. (4)
  An order whose due date already fell before the draft's window even starts (a real,
  recurring case — "today" always moves forward) was briefly given a "place it anyway,
  past due" fallback in `proposeSchedule.ts` — reverted the same day (2026-09-22) after
  a direct decision: an overdue order is excluded from scheduling entirely instead,
  not placed-with-a-flag. `fetchBacklog()` now requires `Order.internalDueDate >=
  today` (a `startOfToday()` helper shared conceptually with the drafts route's own
  candidate query, which applies the identical cutoff — see both files), so an overdue
  order's line items never reach the deterministic engine at all. The manual drafts
  workspace enforces the same cutoff twice: the candidate sidebar query excludes it
  (so it isn't offered to drag), and `placeAssignment` independently rejects it
  server-side too (verified directly: a raw POST for an overdue order's line item is
  rejected with a clear message, not just kept out of the UI's drag source) — the same
  defense-in-depth pattern already used for the CONFIRMED-only rule in fix (1) above.
  `propose_schedule`'s engine itself is back to its original hard-floor-only logic (no
  past-due fallback, no `pastDueDate` column — that migration was added and then
  dropped in the same session, `add_past_due_date_flag` then
  `remove_past_due_date_flag`). Getting an overdue order schedulable again means
  correcting its due date first (the order edit page), not scheduling around it.
  One more real fix from the same round of testing: the draft workspace's default
  station tab used to be whichever known station sorted first alphabetically
  ("Embroidery") — since `fetchCapacity()` now upserts all six known stations so the
  automatic engine has somewhere to place jobs (see above), that tab is very often
  empty and irrelevant to the order actually being scheduled, which made a
  successful automatic run look like it had placed nothing. The default now prefers
  whichever station the earliest assignment actually landed on, falling back to the
  first known station name only when the draft has no placements at all. A second,
  related confusion from the same testing round: the candidate sidebar listed every
  line item on an order unconditionally, with nothing distinguishing "already placed
  on the timeline" from "still needs placing" — a correct automatic run looked
  incomplete because the sidebar never reflected what had actually happened. Line
  items with a placement anywhere in the draft (`placedLineItemIds`, derived live from
  the same `placements` state the timeline itself renders from) now show a green
  "Placed" chip, are dimmed, and are no longer draggable (dragging one again would
  have created a second, duplicate assignment for the same job rather than moving the
  existing one — there was no protection against that before this fix either). A third
  bug surfaced by the same "why aren't these placed" question: the sidebar's per-line-item
  hours and "why can't this be placed" tooltip read `LineItem.estimatedHours` — the
  dormant column `estimateForDisplay.ts`'s own doc comment already says is never written
  to (see the entry below) — so they always silently evaluated to nothing; the order
  total always showed "0m" and no reason was ever surfaced for an unplaced item,
  regardless of what was actually wrong. `drafts/[id]/+page.server.ts`'s `load()` now
  computes `estimate: estimateForDisplay(item)` per line item (the exact same call the
  Orders page already uses) instead of passing the dormant column through, and the three
  client-side `estimate*()` helpers read `DisplayEstimate`'s real shape (`{ok:true,
  hours,station}` / `{ok:false,category,reason}`) instead of the old ad-hoc one that
  never matched anything real. Verified live: an order's total went from a permanent
  "0m" to a real "3.5h," and a relabel line item's tooltip now shows the actual
  `MissingFormulaError` reason instead of nothing.
- **Per-line-item and per-order hour estimates, shown before scheduling
  (2026-09-21).** `estimateForDisplay.ts` wraps the same `estimateHours()` the engine
  uses and turns its result (or `MissingFormulaError`/`MissingLineItemDataError`) into
  a display-ready shape. Shown on the Orders list (a live per-order total + a "N
  pending" count) and on an order's detail page (a per-line-item badge, plus an
  order-level stat row). Deliberately **not persisted** to `LineItem.estimatedHours`
  (that column stays dormant/unused, as it already was) — computed fresh on every page
  load instead, so it can never go stale relative to a line item a human just edited.
  Claude is not involved in computing any of these numbers or in building
  `propose_schedule`'s output — both stay 100% deterministic engine code, per this
  file's non-negotiable design principles; "Claude helps" here means explaining
  already-computed results in conversation, not an LLM call added to either page.
- **"Needs attention" is now answerable in one note, not just field-by-field
  (2026-09-22).** `orderGaps.ts` (`computeOrderGaps`) splits an order's outstanding gaps
  into `questions` (order approval gates, artwork approval, and per-line-item missing
  estimate data — each tagged with the exact field it maps to; `MissingLineItemDataError`
  now carries a `field` for this) and `infoNotes` (import-time flags, and estimate gaps
  with no backing field at all — a station with no formula yet — which no note can
  resolve). The order page phrases `questions` as questions and offers a notes textarea
  (`fillNeedsAttentionFromNotes.ts`) where a reviewer answers some or all of them in plain
  language; Claude reads the note against the exact outstanding question list (recomputed
  fresh from the database at submit time, not from anything the browser sends) and returns
  only the fields the note actually answers — never guessing an unaddressed one — applied
  through the same `updateOrderFields`/`updateLineItemFields` the per-field "Save" forms
  already use. This is a faster way to fill in those forms, not a second write path or a
  bypass of either human approval gate: every field stays directly editable by hand
  afterward, and "Confirm import" is still a separate, explicit click.
- **Real Hoops export samples now exist** (4 PDFs, provided 2026-09-18: Jobs 100127,
  100128, 100113, 100110) — the format is no longer undocumented in the sense of "we've
  never seen one," but extraction still has no deterministic parser and isn't validated at
  scale; treat these as one reference set, not a guarantee every future export looks the
  same. They confirmed the "Job <number>" line is the order identifier (`hoopsOrderId`) and
  the decoration+finishing line-item grouping — but also surfaced five concrete gaps the
  schema doesn't cover yet, each needing a real answer, not a guess:
  - **"Patch Install" (Job 100113) matches no `decoration_type` or `finishing_step` value.**
    Not screen print/embroidery/DTF/DTG, not matte/relabel/fold&bag/hang tag. No station,
    no formula. Needs a decision from Jeff on what it is and where it runs.
  - **No `weight_class` signal for headwear** (Job 100128's caps) — **partially
    resolved (2026-09-21)**: `LineItem.garmentStyle` (`flat`/`cap`) and
    `capConstruction` (`structured`/`unstructured`, cap-only) now exist and embroidery's
    formula uses them instead of `weight_class` when `garment_style` is `cap` (see
    estimate_hours above). What's still open: `extractOrderFromPdf.ts` does not populate
    these new fields yet — every sample's weight-class hint ("Thin - Trail Network",
    "Fleece/Bulky") still reads as textile-specific, and caps still default `weightClass`
    to `THIN` with a flagged low-confidence guess, same interim behavior as before. Real
    caps therefore still hit `MissingLineItemDataError` (garment_style not set) until
    either extraction is taught to recognize headwear, or a person sets `garmentStyle`
    manually via the order's line-item edit form (now exposed there).
  - **Only one date ("Deadline") appears per job, not two — resolved (2026-09-22).**
    Confirmed with the client: `internal_due_date` is never an independent value: the shop
    wants to be ready for an order two weeks before it's actually due, so
    `internal_due_date` = `external_ship_date` − 14 days, always. Implemented as a pure,
    deterministic computation (`computeInternalDueDate` in
    `src/lib/server/hoops/internalDueDate.ts`), never left to the extraction model and
    never a directly-editable field — Claude's extraction tool no longer asks for or emits
    `internalDueDate` at all (`extractOrderFromPdf.ts` computes it from the extracted
    `externalShipDate` after the model call returns); the order edit page shows it as a
    disabled/read-only field; `updateOrderFields.ts` and `confirmImport.ts` recompute it
    whenever `externalShipDate` changes and `orderCorrectionSchema` no longer accepts
    `internalDueDate` as a correction at all. The cure/dry-buffer open item below is a
    separate, still-unresolved question (a gap between a print and a downstream finishing
    step) — do not conflate the two.
  - **Administrative fee rows** ("One-Time Digitizing Fee," "Ink Color Change") appear in
    the job details table but aren't production work — they must not become `LineItem`
    rows. Extraction must exclude them (and flag that they were excluded), not force them
    into a decoration/finishing shape.
  - **`print_location` (front/back/left/right) doesn't cover every real position** — "Right
    of Back Seam," "Sleeve/Collar" appear in samples and fit none of the four values.
    Extraction should leave `printLocation` null and flag the raw text rather than guess
    the closest enum value.
- **PDF extraction cost/model choice not confirmed with the client.**
  `extractOrderFromPdf.ts` calls the Claude Messages API (`claude-sonnet-5`) per uploaded
  PDF — real per-import cost, no caching, no cheaper-model fallback considered. Needs
  `ANTHROPIC_API_KEY` in `.env.example`/`web_secret_keys` (added) but not yet in any real
  deployed secret. Revisit the model choice once real import volume/cost is known.
- **Reports (minimal) gaps.** `/reports` only shows what the schema already supports
  (estimate-vs-actual variance by station and by line item, on-time completion,
  currently-blocked count, a recent-changes feed off `audit_log`). One thing it still
  can't show without new work: a historical at-risk trend — `propose_schedule`'s
  `flag_at_risk` results are never persisted (see the engine section), so only a live
  snapshot is possible, not a trend over time. Not added silently; needs a decision on
  whether it's worth new persistence.
- **`Order.notes` is free-text, human-entered only** — e.g. why a job ran late. Nothing
  writes it automatically. Two paths reach it, both landing in the same field (no
  separate write path): the order's page (`updateOrderFields`), or telling Claude in
  conversation (the `add_order_note` MCP tool, matched by `hoops_order_id` since that's
  what a person actually says) — the latter appends a dated, attributed line rather than
  overwriting, since conversational notes are observations stacking up, not a field
  someone's deliberately rewriting. `/reports` surfaces it next to late orders. Two
  things this still doesn't do, both explicitly deferred rather than built: (1) any actual
  pattern-mining across accumulated notes ("Claude can learn off of that") — today a human
  or a future Claude session just reads the raw text; nothing summarizes trends across
  orders; (2) a recurring daily/weekly digest — no delivery mechanism (email/Slack/
  in-app), no scheduler, and no cadence decided (the request itself said "maybe daily
  maybe weekly"). Needs an actual decision on cadence + delivery before building, not a
  guess.

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