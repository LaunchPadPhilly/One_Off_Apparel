# Play 12 — Production bring-up and promotion

**Goal:** the production environment exists with the same shape as UAT (different names,
deletion protection on), its secret is populated, and it serves the exact image SHA that
UAT proved, promoted through `deploy-production.yml`.

**Needs:** Play 11 closed. Shell exports active. The Google client already lists the
production redirect URI (Play 03).

Production differs from UAT by five variable defaults and the state key. Nothing else.

## Steps

### 1. Create the production root

```bash
cp -r infra/environments/example infra/environments/production
```

Edit `infra/environments/production/variables.tf` defaults:

| Variable | Production value |
|---|---|
| `environment` | `production` |
| `name_prefix` | `<slug>` |
| `domain_name` | `<domain>` |
| `app_secret_name` | `prod/<slug>/app` |
| `db_deletion_protection` | `true` |

Edit `infra/environments/production/versions.tf`: `key = "environments/production/terraform.tfstate"`.

```bash
grep -nE 'default *= *' infra/environments/production/variables.tf | grep -E 'environment|name_prefix|domain_name|app_secret_name|db_deletion_protection'
grep -n 'key ' infra/environments/production/versions.tf
grep -n 'environment_name_prefixes' -A3 infra/global/variables.tf | grep default
```

**EVIDENCE 12.1** — paste it.
**Accept when:** the five values match the table, the key is
`environments/production/terraform.tfstate`, and `environment_name_prefixes` in global
contains `<slug>` (it does by default; the deploy role can only pass roles named after
listed prefixes).

### 2. Parked apply, DNS, HTTPS

Repeat Play 08 steps 2–5 with `uat` replaced by `production` in every path, `<slug>-uat-`
replaced by `<slug>-`, `uat/<slug>/app` by `prod/<slug>/app`, and `uat.<domain>` by
`<domain>`. Produce the same evidence, numbered **12.2** through **12.7**, with the same
Accept rules, plus:

- RDS shows `deletionProtection true`.
- The plan's `Plan:` line still says `0 to destroy`.

### 3. Secret

Repeat Play 09 with `--env production`, secret id `prod/<slug>/app`, template
`infra/environments/production/secret.template.json`, `GOOGLE_REDIRECT_URI =
https://<domain>/api/auth/google/callback`, `MCP_OAUTH_ISSUER_URL = https://<domain>`,
`MCP_PUBLIC_URL = https://<domain>/api/mcp`. Under Option B, generate a **new** token;
never reuse UAT's. Produce evidence **12.8** through **12.12** with Play 09's Accept rules.

### 4. First promotion (expected red at the smoke test)

```bash
SHA=<sha proved in Play 11>
gh workflow run deploy-production.yml -f image_sha="$SHA"
sleep 20
RUN_ID="$(gh run list --workflow deploy-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "watch exit: $?"
gh api repos/<org>/<repo>/actions/runs/$RUN_ID/jobs --jq '.jobs[0].steps[] | {name,conclusion}'
```

**EVIDENCE 12.13** — paste the step list.
**Accept when:** `Verify both images already exist in ECR` = success; the migration step =
success; both deploy steps = success; `Smoke test production` = failure (desired 0). Any
earlier failure: stop and use Play 10's failure table.

### 5. Pin, activate, move, verify

Repeat Play 10 step 3 for `infra/environments/production/terraform.tfvars` with the same
`$SHA`, cluster `<slug>-cluster`, services `<slug>-web` and `<slug>-mcp`. Produce evidence
**12.14** (tfvars + plan) and **12.15** (STABLE, desired 1 running 1, images end in
`:<sha>`).

```bash
./scripts/smoke-test.sh https://<domain>; echo "exit: $?"
```

**EVIDENCE 12.16** — paste it. **Accept when:** `exit: 0`.

### 6. Second promotion (must be green)

```bash
gh workflow run deploy-production.yml -f image_sha="$SHA"
sleep 20
RUN_ID="$(gh run list --workflow deploy-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "watch exit: $?"
```

**EVIDENCE 12.17** — paste `watch exit: 0` and the run URL.

### 7. Refusal test (proves the gate)

```bash
gh workflow run deploy-production.yml -f image_sha=0000000000000000000000000000000000000000
sleep 20
RUN_ID="$(gh run list --workflow deploy-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "watch exit: $?"
gh run view "$RUN_ID" --log 2>/dev/null | grep -m2 'has no image tagged'
```

**EVIDENCE 12.18** — paste the exit code and the grep line.
**Accept when:** exit `1` and the line says the repository has no image tagged with that
SHA. Production was untouched.

### 8. First admin in production, then commit

Sign in at `https://<domain>` as the production `INITIAL_ADMIN_EMAIL`, confirm `/admin`.
Then:

```bash
git add infra/environments/production
git commit -m "infra: add the production environment root, activated on <short sha>"
git push origin main
```

Note: this push deploys to **UAT** again (that is the design). Production is unaffected.

**EVIDENCE 12.19** — one-line admin statement and `git log --oneline | head -1`.

## Success criteria

- [ ] 12.1–12.19 accepted
- [ ] Production and UAT run the same image SHA
- [ ] Refusal test proved the promotion gate

## Failure modes

Play 10's table applies. In addition:

| Symptom | Cause / fix |
|---|---|
| `iam:PassRole` denied during production deploy | `environment_name_prefixes` in `infra/global` lacks `<slug>`; add, apply global. |
| Production smoke test fails on redirect | The :80 listener always redirects in Terraform; check the production CNAME points at the production ALB. |
