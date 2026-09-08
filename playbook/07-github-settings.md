# Play 07 — GitHub repository settings

**Goal:** the two GitHub environments exist with load-bearing names, the deploy role ARN is
readable by both, and branch protection does not block merges.

**Needs:** Play 06 closed (you have `github_deploy_role_arn`).

## Steps

### 1. Environments

```bash
gh api --method PUT repos/<org>/<repo>/environments/UAT >/dev/null
gh api --method PUT repos/<org>/<repo>/environments/Production >/dev/null
gh api repos/<org>/<repo>/environments --jq '.environments[].name'
```

**EVIDENCE 07.1** — paste the names.
**Accept when:** exactly `UAT` and `Production`, matching case. The OIDC trust policy
matches these strings.

### 2. The one secret, readable from both environments

Set it at repository level so both environments (and the build job, which declares `UAT`)
can read it:

```bash
gh secret set AWS_ROLE_ARN --repo <org>/<repo> --body "$(terraform -chdir=infra/global output -raw github_deploy_role_arn)"
gh secret list --repo <org>/<repo>
```

**EVIDENCE 07.2** — paste the list.
**Accept when:** `AWS_ROLE_ARN` appears with no environment restriction.

### 3. Branch protection on `main`

Require one approving review and the `check-and-build` status check. Do **not** add a
"required deployments" rule that names `Production`: production deploys only after merge,
so that rule makes merging impossible.

```bash
gh api repos/<org>/<repo>/branches/main/protection 2>/dev/null | jq '{reviews:.required_pull_request_reviews.required_approving_review_count, checks:.required_status_checks.contexts, deployments:.required_deployments}' || echo "no branch protection yet"
```

If the plan offers rulesets instead, configure the equivalent in Settings → Rules and paste
a one-line description.

**EVIDENCE 07.3** — paste the output.
**Accept when:** `deployments` is `null` or absent, reviews ≥ 1.

### 4. Optional: required reviewers on Production

If the plan supports environment protection rules, add reviewers on `Production`. Keep the
dispatch-only production workflow regardless. Never add reviewers on `UAT`: the build job
declares `UAT` and would wait for approval on every push.

**EVIDENCE 07.4** — one sentence: what was configured, or "not available on this plan".

## Success criteria

- [ ] 07.1–07.4 accepted

## Failure modes

| Symptom | Cause / fix |
|---|---|
| Workflow later fails at "Configure AWS credentials" | Environment name mismatch, `AWS_ROLE_ARN` scoped to one environment only, or OIDC subject prefix changed (Play 06 step 3). |
| Cannot merge any PR | A required-deployment rule points at `Production`. Remove it. |
