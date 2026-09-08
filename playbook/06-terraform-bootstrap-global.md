# Play 06 — Terraform bootstrap and global

**Goal:** the Terraform state bucket exists (local state, backed up), the shared backend
config file is written, and the `global` root has created both ECR repositories and the
GitHub deploy role.

**Needs:** Plays 02 and 05 closed. Shell exports from Play 05 active.

## Steps

### 1. Bootstrap the state bucket

The bucket name was the STATE_BUCKET answer given to the init script (Play 02).

```bash
grep -n default infra/bootstrap/variables.tf
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap plan -out tf.plan | grep -E '^Plan:'
```

**EVIDENCE 06.1** — paste the `Plan:` line.
**Accept when:** `Plan: 5 to add, 0 to change, 0 to destroy.` (bucket, versioning,
encryption, public-access block, bucket policy).

```bash
terraform -chdir=infra/bootstrap apply tf.plan
terraform -chdir=infra/bootstrap output
aws s3api get-bucket-versioning --bucket "$(terraform -chdir=infra/bootstrap output -raw state_bucket)"
aws s3api get-public-access-block --bucket "$(terraform -chdir=infra/bootstrap output -raw state_bucket)" --query 'PublicAccessBlockConfiguration'
```

**EVIDENCE 06.2** — paste the output and versioning/public-access results.
**Accept when:** `Status: Enabled` and all four public-access flags `true`.

**Back up the local state now.** `infra/bootstrap/terraform.tfstate` is gitignored and is
the only record that Terraform owns this bucket. Copy it to the team's secure store (not
the repo, not the chat). If lost, recovery is `terraform import aws_s3_bucket.state
<bucket>` plus the four sub-resources.

```bash
ls -la infra/bootstrap/terraform.tfstate && echo "BACKED_UP_TO: <where>"
```

**EVIDENCE 06.3** — paste the line with the destination filled in.

### 2. Backend config file

```bash
cp infra/example.backend.hcl infra/my.backend.hcl
# edit: bucket = "<state bucket>", region = "<region>"
git check-ignore -v infra/my.backend.hcl
cat infra/my.backend.hcl
```

**EVIDENCE 06.4** — paste both outputs (a bucket name is not secret).
**Accept when:** `check-ignore` matches a `*.backend.hcl` rule and the file holds the real
bucket and region.

### 3. OIDC subject check (before applying global)

GitHub can emit an id-annotated subject prefix instead of the standard
`repo:<org>/<repo>`. Check:

```bash
gh api repos/<org>/<repo>/actions/oidc/customization/sub
```

`{"use_default":true}` means the standard subject applies and nothing changes. If the
response instead shows a `sub_claim_prefix` (or `include_claim_keys`), copy the prefix
verbatim into `github_oidc_subject_prefix` in `infra/global/variables.tf`, without the
trailing `:environment:` part.

**EVIDENCE 06.5** — paste the response.
**Accept when:** the assistant states whether the default subject applies and, if not,
that the variable was set to the printed prefix.

### 4. Apply global

```bash
terraform -chdir=infra/global init -backend-config=../my.backend.hcl
terraform -chdir=infra/global plan -out tf.plan | grep -E '^Plan:'
```

**EVIDENCE 06.6** — paste the `Plan:` line.
**Accept when:** `Plan: 6 to add, 0 to change, 0 to destroy.` (two ECR repositories, two
lifecycle policies, the deploy role, its inline policy).

```bash
terraform -chdir=infra/global apply tf.plan
terraform -chdir=infra/global output
aws ecr describe-repositories --query 'repositories[].{name:repositoryName,uri:repositoryUri,mutability:imageTagMutability}' --output json
aws iam get-role --role-name <slug>-github-deploy --query 'Role.AssumeRolePolicyDocument' --output json
```

**EVIDENCE 06.7** — paste all of it (role ARNs and trust policies are not secret).
**Accept when:** outputs show `github_deploy_role_arn`, `ecr_web_url`, `ecr_mcp_url`;
repositories `<slug>-web` and `<slug>-mcp` exist; the trust policy's `StringLike`
`token.actions.githubusercontent.com:sub` lists exactly
`repo:<org>/<repo>:environment:UAT` and `repo:<org>/<repo>:environment:Production` (or the
custom prefix from 06.5 followed by `:environment:<name>`), and `aud` equals
`sts.amazonaws.com`.

### 5. Commit

`infra/my.backend.hcl` and the bootstrap state are ignored. Nothing else changed unless
you set `github_oidc_subject_prefix`; if you did, commit that.

```bash
git status --porcelain
```

**EVIDENCE 06.8** — paste it.
**Accept when:** empty, or only `infra/global/variables.tf` which you then commit and push.

## Success criteria

- [ ] 06.1–06.8 accepted
- [ ] Bootstrap state backed up outside the repo
- [ ] `github_deploy_role_arn` recorded in the chat for Play 07

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `BucketAlreadyExists` | Names are global. Pick another; update the placeholder in `infra/bootstrap/variables.tf` and `infra/example.backend.hcl` and commit. |
| `init` asks for the bucket interactively | You forgot `-backend-config=../my.backend.hcl`. Every `init` needs it. |
| Trust policy has the wrong org | You gave a different GitHub org to the init script, or the repo was transferred. Fix `infra/global/variables.tf`, re-apply. A transfer changes the subject and breaks deploys until this is redone. |
| `AccessDenied` creating the role | Operator identity lacks `iam:CreateRole`. See Play 01 step 2. |
