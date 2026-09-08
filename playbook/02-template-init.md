# Play 02 — Template initialization

**Goal:** a fresh repository generated from the template with every placeholder filled,
coupled values consistent, the break-glass token decision made and applied, and the
repository's own gates green.

**Needs:** Play 01 closed.

## Steps

### 1. Generate and clone

On GitHub, use **Use this template** on the template repository to create
`<org>/<repo>` (private). Then:

```bash
git clone https://github.com/<org>/<repo>.git
cd <repo>
git log --oneline | wc -l      # must be 1: the init script refuses otherwise
git status --porcelain | wc -l # must be 0
```

**EVIDENCE 02.1** — paste both counts.
**Accept when:** `1` and `0`.

### 2. Fill placeholders

```bash
./scripts/init-template.sh
```

Answer the eight prompts from the Play 01 inputs table. The script validates each value
against a pattern and rewrites tracked files only. Then:

```bash
git diff --stat | tail -1
./scripts/init-template.sh --check
```

**EVIDENCE 02.2** — paste the `--check` output and the diff summary line.
**Accept when:** `No unfilled placeholders.`

### 3. Coupled values

These must agree and nothing enforces it:

```bash
grep -n "slug:" src/lib/appConfig.ts
grep -n "localStorage.getItem" src/app.html
grep -n "environment:" .github/workflows/deploy.yml .github/workflows/deploy-production.yml
grep -n -A1 'variable "github_environments"' infra/global/variables.tf | head -3
grep -n "default" infra/global/variables.tf | grep -i prefixes
```

**EVIDENCE 02.3** — paste the output.
**Accept when:** the slug in `appConfig.ts` equals the prefix inside both
`localStorage.getItem('<slug>:…')` calls; the workflow `environment:` values are exactly
`UAT` and `Production`; `github_environments` defaults to those two names; and
`environment_name_prefixes` contains `<slug>-uat` and `<slug>`.

### 4. Decide the break-glass token (mandatory decision)

`MCP_SERVER_TOKEN` is an unscoped, unattributed static bearer token. The code treats it
as optional and the docs say to leave it unset, but the Terraform key lists include it, and
ECS refuses to start a task when a listed key is missing from the secret. Pick one:

**Option A (recommended): remove it everywhere.**

Edit `infra/environments/example/variables.tf`: delete `"MCP_SERVER_TOKEN"` from both the
`web_secret_keys` and `mcp_secret_keys` defaults. Edit
`infra/environments/example/secret.template.json`: delete the `MCP_SERVER_TOKEN` line
(mind the trailing comma on the previous line). Then:

```bash
grep -c MCP_SERVER_TOKEN infra/environments/example/variables.tf
jq 'has("MCP_SERVER_TOKEN")' infra/environments/example/secret.template.json
jq empty infra/environments/example/secret.template.json && echo JSON_OK
```

**EVIDENCE 02.4** — paste the output and the word `OPTION A`.
**Accept when:** `0`, `false`, `JSON_OK`.

**Option B: keep it as a real credential.** Leave the files alone. In Play 09 you will
generate a value with `openssl rand -base64 48`, store it only in the secret, and treat it
as production credential material. Paste `OPTION B` as **EVIDENCE 02.4**. The assistant
records this in `CLAUDE.md` → Project State at Play 13.

### 5. Install and run the gates

Prisma needs `DATABASE_URL` to be *present* to generate; a placeholder is fine here:

```bash
DATABASE_URL=postgresql://u:p@localhost:5432/db pnpm install --frozen-lockfile
DATABASE_URL=postgresql://u:p@localhost:5432/db pnpm run db:validate
pnpm run check
pnpm run template:check
DATABASE_URL=postgresql://u:p@localhost:5432/db pnpm run build
DATABASE_URL=postgresql://u:p@localhost:5432/db BUILD_TARGET=docker pnpm run build && ls build/index.js
```

**EVIDENCE 02.5** — paste the last 5 lines of each command's output and the final `ls`.
**Accept when:** `db:validate` says the schema is valid; `check` reports
`0 ERRORS`; `template:check` prints `none` under all three headings and exits 0 (run
`echo $?` if unsure); both builds finish and `build/index.js` exists.

Two deprecation warnings about `csrf.checkOrigin` are expected and are not errors.

### 6. Commit

```bash
git add -A
git commit -m "chore: initialize template for <slug>"
git push origin main
```

**EVIDENCE 02.6** — paste `git log --oneline | head -2`.
**Accept when:** two commits, the top one is yours. The push starts two workflows.
`ci.yml` must pass: `gh run list --workflow ci.yml --limit 1`. `deploy.yml` also runs and
**fails at "Configure AWS credentials"**; that is expected until Plays 06 and 07 exist and
is not a defect. Paste both run conclusions.

## Success criteria

- [ ] 02.1–02.6 accepted
- [ ] The `MCP_SERVER_TOKEN` decision is recorded in the chat as OPTION A or OPTION B
- [ ] `ci.yml` run for the init commit is green

## Failure modes

| Symptom | Cause / fix |
|---|---|
| Init script refuses: "more than one commit" | You are not on a fresh template clone. Re-generate the repository. |
| `template:check` shows stray identifiers | You typed the original engagement's name into a value. Fix and rerun. |
| `pnpm install` fails on `DATABASE_URL` | Prefix the command as shown; Prisma only needs the key present. |
| `check` reports errors after init | The init script only rewrites literal placeholders; do not hand-edit `appConfig.ts` slugs to something with spaces or uppercase. |
