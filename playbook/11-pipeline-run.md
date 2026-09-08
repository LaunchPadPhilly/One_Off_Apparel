# Play 11 — First green pipeline run

**Goal:** `deploy.yml` passes end to end (`build → deploy-uat → smoke-test-uat`) and
prints the promotion command; this proves the release path a developer will use daily.

**Needs:** Play 10 closed (the push at its step 6 already started a run).

## Steps

### 1. Watch the run

```bash
RUN_ID="$(gh run list --workflow deploy.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$RUN_ID" --exit-status; echo "watch exit: $?"
gh run view "$RUN_ID" --json headSha,conclusion,jobs --jq '{sha:.headSha, conclusion, jobs:[.jobs[]|{name,conclusion}]}'
```

**EVIDENCE 11.1** — paste the JSON.
**Accept when:** all three jobs `success`, `conclusion: success`.

### 2. Confirm the deploy moved the services to the new SHA

```bash
SHA=<sha from 11.1>
aws ecs describe-services --cluster <slug>-uat-cluster --services <slug>-uat-web <slug>-uat-mcp --query 'services[].taskDefinition' --output text | tr '\t' '\n' | while read -r td; do
  aws ecs describe-task-definition --task-definition "$td" --query 'taskDefinition.{family:family,rev:revision,image:containerDefinitions[0].image}' --output json
done
aws ecr describe-images --repository-name <slug>-web --image-ids imageTag="$SHA" --query 'imageDetails[0].imageDigest' --output text
```

**EVIDENCE 11.2** — paste it.
**Accept when:** both live images end in `:<sha>` from 11.1 and the ECR digest resolves.

### 3. Read the promotion summary

```bash
gh run view "$RUN_ID" --web >/dev/null 2>&1 || true
gh api repos/<org>/<repo>/actions/runs/$RUN_ID/jobs --jq '.jobs[] | select(.name|startswith("Smoke")) | .steps[] | {name,conclusion}'
```

Open the run's Summary tab; it shows `gh workflow run deploy-production.yml -f image_sha=<sha>`.

**EVIDENCE 11.3** — paste the step list and the promotion command as shown in the summary.
**Accept when:** the SHA in the command equals 11.1's `sha`.

### 4. Release discipline, stated

In the chat, in your own words, state: (a) what triggers a UAT deploy, (b) why production
never deploys from `deploy.yml`, (c) what the production workflow refuses.

**EVIDENCE 11.4**
**Accept when:** (a) push to `main` or manual dispatch; (b) it is a separate
`workflow_dispatch` workflow because environment approval gates do not exist on some
GitHub plans; (c) any SHA not already present in both ECR repositories.

## Success criteria

- [ ] 11.1–11.4 accepted

## Failure modes

| Symptom | Cause / fix |
|---|---|
| Smoke test fails on the redirect check | The :80 listener always redirects in Terraform, so this is DNS: the CNAME does not point at this ALB, or another listener was created by hand. |
| Smoke test fails on the 401 challenge | `MCP_OAUTH_ISSUER_URL` missing from the **mcp** container's keys; the challenge header is omitted without it. |
| `wait services-stable` times out | Circuit breaker rolled back; read the service events: `aws ecs describe-services ... --query 'services[0].events[:10]'`. |
