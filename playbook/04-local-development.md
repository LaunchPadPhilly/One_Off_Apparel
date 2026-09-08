# Play 04 — Local development

**Goal:** the SvelteKit web app and the standalone MCP server both run locally against a
database you own; the first admin signs in and lands in `/admin`; an authenticated MCP
tool call succeeds and a revoked token is refused.

**Needs:** Plays 02 and 03 closed. Nothing here touches AWS.

## Steps

### 1. Local PostgreSQL

```bash
docker run --name <slug>-postgres \
  --env POSTGRES_USER=app --env POSTGRES_PASSWORD=local-development-only \
  --env POSTGRES_DB=<slug> --publish 5432:5432 --detach postgres:16
docker ps --filter name=<slug>-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'
```

**EVIDENCE 04.1** — paste the `docker ps` line.
**Accept when:** status `Up`, port `5432` published.

### 2. `.env.local`

```bash
cp .env.example .env.local
```

Edit `.env.local` and set, using these exact local values where shown:

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgresql://app:local-development-only@localhost:5432/<slug>` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Play 03 |
| `GOOGLE_REDIRECT_URI` | `http://localhost:5173/api/auth/google/callback` |
| `GOOGLE_ALLOWED_DOMAIN` | the comma-separated Workspace domains (already filled by init) |
| `INITIAL_ADMIN_EMAIL` | your Workspace email, exact case, in an allowed domain |
| `MCP_PUBLIC_URL` | `http://localhost:3001/api/mcp` |
| `MCP_OAUTH_ISSUER_URL` | `http://localhost:5173` |
| `MCP_OAUTH_SCOPES` | `data:read reports:read` |
| `PORT` / `HOST` | `3001` / `0.0.0.0` (required by `pnpm run test` even though code has defaults) |

Leave `MCP_SERVER_TOKEN`, `RESEND_API_KEY`, `EMAIL_FROM` commented out.

```bash
for k in DATABASE_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI GOOGLE_ALLOWED_DOMAIN INITIAL_ADMIN_EMAIL MCP_PUBLIC_URL MCP_OAUTH_ISSUER_URL MCP_OAUTH_SCOPES PORT HOST; do
  printf '%s=%s\n' "$k" "$(grep -c "^$k=" .env.local)"
done
grep -c '^MCP_SERVER_TOKEN=' .env.local
grep -c '<' .env.local
```

**EVIDENCE 04.2** — paste the output (it prints key names and counts only).
**Accept when:** every listed key shows `1`, `MCP_SERVER_TOKEN` shows `0`, and the
angle-bracket count is `0` (no placeholders left).

### 3. Diagnostic, schema, generated client

```bash
pnpm run test
pnpm run db:validate
pnpm run db:generate
pnpm run db:deploy
```

**EVIDENCE 04.3** — paste the output of `pnpm run test` and the last 6 lines of
`db:deploy`. `pnpm run test` prints only host, port and database name, never the password.
**Accept when:** `All checks passed`, and `db:deploy` reports the migration `0001_init`
applied (or "No pending migrations" on a rerun).

### 4. Run both processes

Terminal 1: `pnpm dev`. Terminal 2: `pnpm run mcp:dev`.

```bash
./scripts/smoke-test.sh http://localhost:5173 --skip-redirect
curl --include --silent --request POST --header 'Content-Type: application/json' --data '{}' http://localhost:3001/api/mcp | head -5
```

**EVIDENCE 04.4** — paste both outputs.
**Accept when:** `SMOKE TEST PASSED`; the curl shows `HTTP/1.1 401` and a
`WWW-Authenticate: Bearer resource_metadata=...` header.

### 5. First admin and an authenticated tool call

In the browser: open `http://localhost:5173`, sign in with the `INITIAL_ADMIN_EMAIL`
account. This must be that account's **first ever** login; the bootstrap never reruns.
Open `/admin?screen=users` and confirm you are Admin with every scope. In
`/admin?screen=agents` create a token with scope `data:read`; copy it once into a shell
variable, never into the chat:

```bash
read -rs AGENT_TOKEN   # paste the token, press Enter; nothing is echoed
curl --silent --request POST http://localhost:3001/api/mcp \
  --header 'Content-Type: application/json' --header 'Accept: application/json' \
  --header "Authorization: Bearer $AGENT_TOKEN" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"service_status","arguments":{}}}'
```

Then revoke the token in `/admin?screen=agents` and run the same curl again with
`--include`, keeping only the status line.

**EVIDENCE 04.5** — paste: a one-line statement that `/admin?screen=users` shows you as
Admin; the JSON response of the first curl; the status line of the second.
**Accept when:** the first response contains `"status":"ok"`; the second is `401`.

### 6. Pre-push gates

```bash
pnpm run db:validate && pnpm run check && pnpm run build && BUILD_TARGET=docker pnpm run build && echo GATES_OK
```

**EVIDENCE 04.6** — paste the last line.
**Accept when:** `GATES_OK`.

## Success criteria

- [ ] 04.1–04.6 accepted
- [ ] No secret value appeared in the chat

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `DATABASE_URL is required` | Not in the repository root, or `.env.local` missing. All loaders use the relative path. |
| `pnpm run test` reports a missing key | Every uncommented key in `.env.example` is required, including `PORT`/`HOST`. |
| `redirect_uri_mismatch` | Console URI and `GOOGLE_REDIRECT_URI` differ. |
| Rejected after Google consent | Domain not in `GOOGLE_ALLOWED_DOMAIN`, or consumer Gmail. |
| `/admin` is 403 for the first admin | That email already had a `User` row before this login (invited earlier, or case mismatch in `INITIAL_ADMIN_EMAIL`). Drop the local database and start over: `docker rm -f <slug>-postgres`, redo steps 1 and 3. |
| Tool call says you lack permission | Token was created without `data:read`. |
| MCP port in use | Change both `PORT` and `MCP_PUBLIC_URL`, or stop the other listener. |
