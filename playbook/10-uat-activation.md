# Play 10 — First images, migration, activation

**Goal:** both images built once by the pipeline and present in ECR under the commit SHA;
the schema migrated by the pipeline's one-off task; services activated on pinned images;
`smoke-test.sh` exit 0; the first admin signs in and opens `/admin`.

**Needs:** Plays 07 and 09 closed. Shell exports active.

This play deliberately runs `deploy.yml` once **before** activation. Expected outcome of
that first run: `build` green, `deploy-uat` green (it registers revisions, runs the
migration, and "updates" services that still have desired count 0), `smoke-test-uat`
**red** because nothing serves traffic yet. That red is the gate you then satisfy.

## Steps

### 1. Trigger the pipeline

```bash
gh workflow run deploy.yml --ref main
sleep 20
RUN_ID="$(gh run list --workflow deploy.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "watch exit: $?"
gh run view "$RUN_ID" --json headSha,jobs --jq '{sha:.headSha, jobs:[.jobs[]|{name,conclusion}]}'
```

**EVIDENCE 10.1** — paste the final JSON.
**Accept when:** `Build and push images` = `success`, `Deploy to UAT` = `success`,
`Smoke test UAT (promotion gate)` = `failure`. Record `sha` (40 hex).

If `Deploy to UAT` failed, open the migration step log: `gh run view "$RUN_ID" --log
--job <id>` and consult Failure modes below before continuing.

### 2. Prove the images and the migration

```bash
SHA=<sha from 10.1>
for r in <slug>-web <slug>-mcp; do
  aws ecr describe-images --repository-name "$r" --image-ids imageTag="$SHA" \
    --query 'imageDetails[0].{repo:repositoryName,tags:imageTags,digest:imageDigest,pushed:imagePushedAt,sizeMB:to_string(imageSizeInBytes)}' --output json
done
aws logs filter-log-events --log-group-name /ecs/<slug>-uat-web --filter-pattern '"migration"' \
  --start-time $(( $(date +%s) - 3600 ))000 --query 'events[].message' --output text | tail -n 8
aws ecs describe-services --cluster <slug>-uat-cluster --services <slug>-uat-web <slug>-uat-mcp \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output json
```

**EVIDENCE 10.2** — paste all outputs.
**Accept when:** both images exist with tag `$SHA` and a `sha256:` digest; the log lines
show Prisma applying `0001_init` (or "No pending migrations"); both services now point at
a task definition revision **greater than 1** (the pipeline's) while still `desired 0`.

### 3. Pin and activate (gate 3)

Edit `infra/environments/uat/terraform.tfvars`:

```hcl
enable_https      = true
activate_services = true
image_uris = {
  web = "<acct>.dkr.ecr.<region>.amazonaws.com/<slug>-web:<sha>"
  mcp = "<acct>.dkr.ecr.<region>.amazonaws.com/<slug>-mcp:<sha>"
}
```

```bash
cat infra/environments/uat/terraform.tfvars | grep -vE '^\s*#'
terraform -chdir=infra/environments/uat plan -out tf.plan | grep -E '^Plan:|must be replaced|will be destroyed|Warning|activation'
```

**EVIDENCE 10.3** — paste both outputs.
**Accept when:** both image URIs end in `:<sha>` where `<sha>` is the 40-hex value from
10.1 (the assistant checks the regex `:[0-9a-f]{40}$` on each line — Terraform's own
check only *warns* on unpinned images, so this paste is the real gate); the plan shows the
two task definitions replaced (expected: Terraform re-registers its managed revision) and
the two services changed (`desired_count` 0 → 1); nothing else replaced or destroyed.

```bash
terraform -chdir=infra/environments/uat apply tf.plan
for svc in <slug>-uat-web <slug>-uat-mcp; do
  aws ecs update-service --cluster <slug>-uat-cluster --service "$svc" --task-definition "$svc" --query 'service.{name:serviceName,taskDef:taskDefinition,desired:desiredCount}' --output json
done
aws ecs wait services-stable --cluster <slug>-uat-cluster --services <slug>-uat-web <slug>-uat-mcp && echo STABLE
aws ecs describe-services --cluster <slug>-uat-cluster --services <slug>-uat-web <slug>-uat-mcp \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,taskDef:taskDefinition,rollout:deployments[0].rolloutState}' --output json
aws ecs describe-task-definition --task-definition <slug>-uat-web --query 'taskDefinition.containerDefinitions[0].image' --output text
aws ecs describe-task-definition --task-definition <slug>-uat-mcp --query 'taskDefinition.containerDefinitions[0].image' --output text
```

**EVIDENCE 10.4** — paste everything.
**Accept when:** `STABLE`; both services `desired 1, running 1`, `rollout COMPLETED`; both
latest task definitions' images end in `:<sha>`.

### 4. Acceptance

```bash
./scripts/smoke-test.sh https://uat.<domain>; echo "exit: $?"
curl -s https://uat.<domain>/.well-known/oauth-authorization-server | jq '{issuer, authorization_endpoint, code_challenge_methods_supported}'
curl -s https://uat.<domain>/.well-known/oauth-protected-resource | jq .
```

**EVIDENCE 10.5** — paste it.
**Accept when:** `SMOKE TEST PASSED`, `exit: 0`; issuer `https://uat.<domain>`; resource
`https://uat.<domain>/api/mcp`; `code_challenge_methods_supported` = `["S256"]`.

### 5. First admin in UAT

In the browser: `https://uat.<domain>`, sign in as `INITIAL_ADMIN_EMAIL` (first-ever login
of that account in this environment). Confirm `/admin?screen=users` shows you as Admin
with every scope. Create an agent token with `data:read`, call `service_status` as in
Play 04 step 5 against `https://uat.<domain>/api/mcp`, revoke it, confirm 401.

Then open `/admin?screen=activity` and find the `bootstrap_initial_admin` event.

**EVIDENCE 10.6** — paste: the one-line admin statement, the `"status":"ok"` JSON, the
`401` status line, and a one-line statement that the activity screen lists
`bootstrap_initial_admin` for your user.
**Accept when:** all four present.

### 6. Commit the pins

```bash
git add infra/environments/uat/terraform.tfvars
git commit -m "infra(uat): activate services on <short sha>"
git push origin main
```

This push starts `deploy.yml` again; that is Play 11.

## Success criteria

- [ ] 10.1–10.6 accepted
- [ ] `terraform.tfvars` pins committed

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `Deploy to UAT` fails at "Configure AWS credentials" | Play 07 (environment name, secret scope) or Play 06 step 3 (subject prefix). |
| Migration task `exitCode null`, `ResourceInitializationError` | A key in `web_secret_keys` is missing from the secret, or the execution role cannot read it. Play 09 steps 4 and 6. |
| Migration task exit 1, `P1013` or `P1001` | `DATABASE_URL` malformed or host unreachable. Run `./scripts/fix-secret-database-url.sh repair uat/<slug>/app` (dry run, then `--apply`), then re-run the pipeline. |
| Tasks start then stop, target unhealthy | Check `aws logs tail /ecs/<slug>-uat-web --since 15m`. Common: `GOOGLE_ALLOWED_DOMAIN` empty (throws at first login only), wrong `PORT` (should be baked in image). |
| `CannotPullContainerError` after apply | Services were still on the placeholder revision. The `update-service --task-definition <family>` step moves them; rerun it. |
| `/admin` 403 for the first admin | That email already exists as a user (invited first, or case mismatch). Fix via a one-off task, see Play 14. |
