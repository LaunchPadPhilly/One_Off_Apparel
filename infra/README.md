# Infrastructure (Terraform)

Terraform ≥ 1.11, AWS provider ~> 6.0. Credentials come from `AWS_PROFILE`; never hardcode
them in providers or backends.

```bash
export AWS_PROFILE=<operator-profile>
export AWS_REGION=us-east-1
```

## Roots (apply in this order the first time)

| Root | State | Owns |
|---|---|---|
| `bootstrap/` | **local** (gitignored) | the S3 state bucket |
| `global/` | s3: `global/terraform.tfstate` | ECR repos (+ keep-N lifecycle policies), the GitHub OIDC deploy role. The OIDC *provider* is referenced by ARN, not managed — it is account-shared. |
| `environments/<env>/` | s3: `environments/<env>/terraform.tfstate` | one environment: ALB, target groups, listeners, ECS cluster and services, security groups, ACM certificate, RDS, secret container, IAM roles, log groups |

`environments/example/` is the source you copy for each real environment (`uat/`,
`production/`). Change `environment`, `name_prefix`, `domain_name`, `app_secret_name`,
`db_deletion_protection`, and the state `key` in `versions.tf`; keep the shape identical.

Backends cannot read variables. Copy `example.backend.hcl` to a gitignored
`my.backend.hcl`, fill it, and pass `-backend-config=<path>` to every `init`.

If `bootstrap/`'s local state is ever lost, re-import by bucket name:
`terraform import aws_s3_bucket.state <bucket>` and the four sub-resources likewise.

## Load-bearing conventions

- **CI owns task-definition revisions.** Services set `ignore_changes = [task_definition]`,
  so `terraform apply` never moves a service to a new image and is not a deploy. After
  changing `image_uris`, `apply` alone leaves the service on the old revision: run
  `aws ecs update-service --task-definition <family>` explicitly. It causes no drift.
- **Terraform manages secret containers, never values.** No
  `aws_secretsmanager_secret_version` resource may ever be added to this tree.
- **Never apply a plan containing a replacement** without an explicit, recorded decision.
  Security-group descriptions, RDS storage encryption and the initial database name are all
  ForceNew.
- Secret key lists (`web_secret_keys`, `mcp_secret_keys`) are variables of the environment
  root. They must match the code's env reads; nothing enforces it. Both containers must
  read the same `DATABASE_URL`.

## Environment bring-up

Three applies, each a gate. `terraform.tfvars` documents the flags.

1. **Parked.** `enable_https = false`, `activate_services = false`, no images. Apply.
   Outputs `acm_validation_records` and `alb_dns_name`.
2. **Registrar (human).** Add the ACM validation CNAME, plus
   `<hostname> CNAME <alb_dns_name>`. Poll `aws acm describe-certificate ... --query
   Certificate.Status` until `ISSUED`. Set `enable_https = true`, apply.
3. **Secret (human).** Populate the flat JSON at `app_secret_name` from
   `secret.template.json` — `playbook/09-uat-secret.md` has the exact procedure,
   including building `DATABASE_URL` with `scripts/fix-secret-database-url.sh`. Register the
   Google callback URL for the hostname.
4. **Images.** Pin both `image_uris` to one 40-hex git SHA that `deploy.yml` built. Set
   `activate_services = true`, apply — the module refuses to scale up on unpinned images.
   **Then move the services onto the new revision explicitly:**

   ```bash
   for svc in <prefix>-web <prefix>-mcp; do
     aws ecs update-service --cluster <prefix>-cluster --service "$svc" --task-definition "$svc"
   done
   aws ecs wait services-stable --cluster <prefix>-cluster --services <prefix>-web <prefix>-mcp
   ```

   Until you do, tasks fail with `CannotPullContainerError` on the placeholder image.
5. **Schema.** One-off task with the web task definition — `playbook/14-operations.md`
   §E has the helper that waits and checks the exit code.
6. **Acceptance gate.** `scripts/smoke-test.sh https://<hostname>` exits 0.

## Deploys

`deploy.yml` on push to `main`: `build → deploy-uat → smoke-test-uat`, and stops.
`deploy-production.yml` is `workflow_dispatch` only:

```bash
gh workflow run deploy-production.yml -f image_sha=<sha>
```

It verifies both images exist in ECR at that tag and refuses otherwise. Do not edit
`terraform.tfvars` or apply Terraform for a normal application deploy.

**Why a separate workflow instead of an approval gate on the job:** required-reviewer
protection rules on a private repository need a paid GitHub plan. Without one, an
`environment:` approval gate silently does not exist. The dispatch-only workflow gives the
guarantee regardless of plan; add required reviewers on `Production` as well when the plan
allows, and keep the split.

## GitHub-side configuration the pipeline needs

- Environments `UAT` and `Production` exist. The names are load-bearing: `global/`'s trust
  policy matches `environment:<name>` in the OIDC token subject (`github_environments`),
  so a job that declares neither cannot obtain AWS credentials at all.
- Secret `AWS_ROLE_ARN` (from `terraform -chdir=infra/global output github_deploy_role_arn`)
  is readable from **both** environments. Environment-scoped values are invisible to jobs
  declaring a different environment — a Production-only secret leaves every UAT job unable
  to assume the role. Region and ECR repository names live in the workflows' own `env:`
  blocks for the same reason.
- The OIDC subject GitHub emits is `repo:<org>/<repo>:environment:<name>` unless the
  repository's OIDC customization returns a `sub_claim_prefix` (check with
  `gh api repos/<org>/<repo>/actions/oidc/customization/sub`); if it does, set
  `github_oidc_subject_prefix` to that value. **A repository transfer between owners changes
  the subject and breaks every deploy until the trust policy is updated.**

## Conventions

- New IAM role names follow `<name_prefix>-task-execution-role` and `<name_prefix>-task`;
  `global/variables.tf` `environment_name_prefixes` must list every environment's prefix or
  the deploy role cannot pass the roles to ECS.
- Cost, active, roughly: ALB ≈ $16/mo, two 0.5 vCPU / 1 GB Fargate tasks ≈ $18/mo,
  `db.t3.micro` ≈ $15/mo, logs and misc. `activate_services = false` parks compute.
- Verify AWS state directly rather than trusting a doc's transcription; this class of
  project has repeatedly found reality diverged.
