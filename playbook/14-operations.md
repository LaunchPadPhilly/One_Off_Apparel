# Play 14 — Operations

**Goal:** the routine and exceptional procedures a developer will need after go-live,
each with its own evidence. Run the section you need; none depend on each other.

**Needs:** Play 10 closed for UAT, Play 12 for production. Shell exports active.
Replace `uat` / `<slug>-uat` with `production` / `<slug>` for production.

## A. Release a change

1. Open a PR; `ci.yml` must pass; merge to `main`.
2. `deploy.yml` runs: build → deploy-uat → smoke-test-uat, then stops.
3. Verify UAT in the browser (Play 11 step 2 commands for the image SHA).
4. Promote: `gh workflow run deploy-production.yml -f image_sha=<sha>`.
5. If tool definitions changed, tell anyone with a connected MCP client to reconnect; the
   server is stateless per request and cannot push the updated tool list.

**EVIDENCE 14.A** — `gh run view <id> --json conclusion,headSha` for both workflows.
**Accept when:** both `success` with the same `headSha`/`image_sha`.

## B. Roll back

Rollback is a promotion of an older SHA that is still in ECR (the lifecycle policy keeps
the last 50 images):

```bash
aws ecr describe-images --repository-name <slug>-web --query 'sort_by(imageDetails,&imagePushedAt)[-5:].{tag:imageTags[0],pushed:imagePushedAt}' --output table
gh workflow run deploy-production.yml -f image_sha=<older sha>
```

The migration step runs again and is a no-op if the schema did not change. **A rollback
across a schema migration is not automatic**: Prisma migrations do not run backwards. Plan
a forward-fix migration instead.

**EVIDENCE 14.B** — the table and the green run.

## C. Change a secret value

```bash
umask 077; F="$(mktemp /tmp/app-secret.XXXXXX)"
aws secretsmanager get-secret-value --secret-id uat/<slug>/app --query SecretString --output text > "$F"
"${EDITOR:-vi}" "$F"                          # edit; never replace the object with a partial one
jq 'keys' "$F"                                # names only
aws secretsmanager put-secret-value --secret-id uat/<slug>/app --secret-string "file://$F" --query VersionStages && rm -f "$F"
for s in <slug>-uat-web <slug>-uat-mcp; do
  aws ecs update-service --cluster <slug>-uat-cluster --service "$s" --force-new-deployment --query 'service.serviceName' --output text
done
aws ecs wait services-stable --cluster <slug>-uat-cluster --services <slug>-uat-web <slug>-uat-mcp && echo STABLE
```

ECS resolves secrets at task start; without the forced redeploy of **both** services the
old value stays live and a green smoke test proves nothing.

**EVIDENCE 14.C** — key list, `VersionStages`, `STABLE`.
**Accept when:** keys unchanged (or the intended addition, which must also be added to
`web_secret_keys`/`mcp_secret_keys` and applied), one `AWSCURRENT`, `STABLE`.

Rotating the Google client secret: create a new secret on the same client in Google Cloud,
put it here, redeploy, then delete the old one in Google Cloud. Rotating the database
password: rotate in RDS (managed), then
`./scripts/fix-secret-database-url.sh build --env uat --from-rds-secret --merge-into "$F"`
in the flow above.

## D. Repair a malformed `DATABASE_URL`

```bash
./scripts/fix-secret-database-url.sh repair uat/<slug>/app          # dry run, prints the diagnosis only
./scripts/fix-secret-database-url.sh repair uat/<slug>/app --apply
```

Then force-redeploy both services (section C). **EVIDENCE 14.D** — the dry-run diagnosis
and `STABLE`.

## E. Run a schema migration or a one-off command inside the VPC

RDS is private; never run `db:deploy` from a workstation.

```bash
CLUSTER=<slug>-uat-cluster
NET="$(aws ecs describe-services --cluster "$CLUSTER" --services <slug>-uat-web --query 'services[0].networkConfiguration' --output json)"
run_task() {  # <task-definition-family> <overrides-json>
  local arn code
  arn="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$1" --launch-type FARGATE \
    --network-configuration "$NET" --overrides "$2" --query 'tasks[0].taskArn' --output text)"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$arn"
  code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)"
  echo "task=$arn exit=$code"; test "$code" = "0"
}
run_task <slug>-uat-web '{"containerOverrides":[{"name":"web","command":["node_modules/.bin/prisma","migrate","deploy"]}]}'
```

`aws ecs run-task` exits 0 even when the container fails; the helper reads the container's
exit code. **EVIDENCE 14.E** — the `task=... exit=0` line and the last lines of
`aws logs tail /ecs/<slug>-uat-web --since 10m`.

**Data loaders:** earlier guidance said to run `tsx scripts/<loader>.ts` in
the `mcp` image. The `mcp` image does **not** copy `scripts/` today; add a
`COPY scripts ./scripts` line to `Dockerfile.mcp` (and any directories the loader imports)
before relying on that path.

## F. Offboard a user

In `/admin/users/<id>`: revoke every scope (kills MCP data access immediately), revoke the
admin role, "Revoke all" tokens. The user's **browser session** survives until expiry
because `DISABLED` is not enforced (Play 13 gap). To end it now, run a one-off task with a
parameterized SQL statement via Prisma, or wait for the 30-day expiry. Record the choice.

**EVIDENCE 14.F** — activity screen shows `revoke_scope`, `revoke_admin_role`,
`mcp_all_tokens_revoked` for the user.

## G. Infrastructure change

```bash
terraform -chdir=infra/environments/uat init -backend-config=../../my.backend.hcl
terraform -chdir=infra/environments/uat plan -out tf.plan | grep -E '^Plan:|must be replaced|will be destroyed'
```

Apply only when the plan contains no replacement or destroy you did not decide on. A
change to `web_secret_keys`/`mcp_secret_keys` re-registers task definitions but does not
move the services: follow with `aws ecs update-service --task-definition <family>` for each.

**EVIDENCE 14.G** — the plan line and, if keys changed, the `describe-task-definition`
secrets list afterwards.

## H. Park or unpark an environment (cost)

Set `activate_services = false` and apply: Fargate tasks and their public IPs stop billing.
ALB, RDS, secrets and logs keep billing. Reverse with `true` and the pinned `image_uris`.
Rough active cost: ALB ≈ $16/mo, two 0.5 vCPU / 1 GB tasks ≈ $18/mo, `db.t3.micro` ≈ $15/mo,
public IPv4 addresses ≈ $15/mo, plus logs and storage.

**EVIDENCE 14.H** — `describe-services` showing `desired 0, running 0` (parked) or `1, 1`.

## I. Diagnose a failed release

1. The Actions run: the migration step prints `stopCode`/`stoppedReason`.
2. `aws logs tail /ecs/<slug>-uat-web --since 30m --follow` and the `-mcp` group.
3. `aws ecs describe-services ... --query 'services[0].events[:10]'` for circuit-breaker
   rollbacks and `CannotPullContainerError`.
4. `/api/health` is liveness only; it does not touch the database.

## J. Recover lost state

- **Bootstrap state lost:** `terraform -chdir=infra/bootstrap import aws_s3_bucket.state <bucket>` and the versioning, encryption, public-access-block and bucket-policy resources likewise.
- **Environment state lost:** the S3 bucket is versioned; restore the previous object version of `environments/<env>/terraform.tfstate`.
- **Repository transferred to another owner:** the OIDC subject changes. Re-run Play 06 step 3 and re-apply `global`, or every deploy fails at assume-role.
