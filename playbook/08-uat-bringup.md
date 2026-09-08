# Play 08 — UAT bring-up, parked to HTTPS

**Goal:** the UAT environment exists in AWS in its **parked** state (ALB, ECS cluster and
two services at desired count 0, encrypted private RDS, secret container, IAM roles, log
groups), the certificate is ISSUED, and the HTTPS listener with the exact-path `/api/mcp`
rule is live. No application runs yet.

**Needs:** Play 06 closed. Shell exports active. Budget ~45 minutes; RDS creation alone
takes 10–15.

## Steps

### 1. Create the UAT root

The example root's defaults already describe UAT (`environment = "uat"`,
`name_prefix = "<slug>-uat"`, `domain_name = "uat.<domain>"`,
`app_secret_name = "uat/<slug>/app"`, state key `environments/uat/...`). Copy it unchanged:

```bash
cp -r infra/environments/example infra/environments/uat
grep -nE 'default *= *"' infra/environments/uat/variables.tf | grep -E 'environment|name_prefix|domain_name|app_secret_name|db_name'
grep -n 'key ' infra/environments/uat/versions.tf
grep -n -E '^(enable_https|activate_services|image_uris)' infra/environments/uat/terraform.tfvars
```

**EVIDENCE 08.1** — paste the output.
**Accept when:** the five defaults read `uat`, `<slug>-uat`, `uat.<domain>`,
`uat/<slug>/app`, `<slug>`; the key is `environments/uat/terraform.tfstate`; tfvars show
`false`, `false`, `{}`.

### 2. Parked apply (gate 1)

```bash
terraform -chdir=infra/environments/uat init -backend-config=../../my.backend.hcl
terraform -chdir=infra/environments/uat plan -out tf.plan | grep -E '^Plan:|must be replaced|will be destroyed'
```

**EVIDENCE 08.2** — paste the output.
**Accept when:** one `Plan:` line with `0 to change, 0 to destroy`, and no
"must be replaced" or "will be destroyed" lines. The add count is in the twenties; the
exact number is not the gate.

```bash
terraform -chdir=infra/environments/uat apply tf.plan
terraform -chdir=infra/environments/uat output
```

**EVIDENCE 08.3** — paste the outputs. They contain names, ARNs, a DNS name and the DB
endpoint hostname; no credentials.
**Accept when:** `acm_validation_records`, `alb_dns_name`, `certificate_arn`,
`cluster_name`, `db_endpoint` (ending in `:5432`), `db_master_user_secret_arn`,
`app_secret_arn`, `web_service_name`, `mcp_service_name` are all present.

### 3. Verify the parked shape

```bash
aws ecs describe-services --cluster <slug>-uat-cluster --services <slug>-uat-web <slug>-uat-mcp \
  --query 'services[].{name:serviceName,status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' --output json
aws rds describe-db-instances --db-instance-identifier <slug>-uat-db \
  --query 'DBInstances[0].{status:DBInstanceStatus,engine:EngineVersion,class:DBInstanceClass,encrypted:StorageEncrypted,public:PubliclyAccessible,managedPassword:MasterUserSecret.SecretStatus,deletionProtection:DeletionProtection}' --output json
aws secretsmanager describe-secret --secret-id uat/<slug>/app --query '{name:Name,versions:VersionIdsToStages}' --output json
aws ecs describe-task-definition --task-definition <slug>-uat-web --query 'taskDefinition.containerDefinitions[0].{image:image,secrets:secrets[].name,env:environment}' --output json
```

**EVIDENCE 08.4** — paste all four outputs.
**Accept when:** both services `ACTIVE`, `desired 0`, `running 0`; RDS `available`,
`encrypted true`, `public false`, `managedPassword active`; the secret has **no** versions
yet (`versions` is null); the web task definition image ends in
`:placeholder-not-deployable`, its `secrets` list equals the `web_secret_keys` you
committed in Play 02 (no `MCP_SERVER_TOKEN` under Option A), and `env` is null.

### 4. DNS at the registrar (human step)

From 08.3 create two CNAME records:

1. The ACM validation record: name → value from `acm_validation_records`.
2. `uat.<domain>` → `alb_dns_name`.

Then poll:

```bash
aws acm describe-certificate --certificate-arn "$(terraform -chdir=infra/environments/uat output -raw certificate_arn)" --query 'Certificate.{status:Status,domain:DomainName}' --output json
dig +short CNAME uat.<domain>
```

Repeat every few minutes until `ISSUED`. Propagation can take up to 30 minutes.

**EVIDENCE 08.5** — paste both outputs once `ISSUED`.
**Accept when:** status `ISSUED`, domain `uat.<domain>`, and `dig` returns the ALB DNS name.

### 5. HTTPS (gate 2)

Set `enable_https = true` in `infra/environments/uat/terraform.tfvars`, then:

```bash
terraform -chdir=infra/environments/uat plan -out tf.plan | grep -E '^Plan:|must be replaced|will be destroyed'
```

**EVIDENCE 08.6** — paste it.
**Accept when:** `Plan: 2 to add, 0 to change, 0 to destroy.` (the :443 listener and the
`/api/mcp` rule) and nothing replaced or destroyed. If services also show as changing,
stop and read the plan: nothing else should move.

```bash
terraform -chdir=infra/environments/uat apply tf.plan
ALB=$(aws elbv2 describe-load-balancers --names <slug>-uat-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text)
aws elbv2 describe-listeners --load-balancer-arn "$ALB" --query 'Listeners[].{port:Port,protocol:Protocol,ssl:SslPolicy,default:DefaultActions[0].Type}' --output json
L443=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB" --query 'Listeners[?Port==`443`].ListenerArn' --output text)
aws elbv2 describe-rules --listener-arn "$L443" --query 'Rules[].{priority:Priority,path:Conditions[0].PathPatternConfig.Values,action:Actions[0].Type}' --output json
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://uat.<domain>/
curl -sS -o /dev/null -w '%{http_code}\n' https://uat.<domain>/api/health
```

**EVIDENCE 08.7** — paste everything.
**Accept when:** listeners show port 80 `redirect` and port 443 `forward` with
`ELBSecurityPolicy-TLS13-1-2-2021-06`; the 443 rules include priority `10` with path
`/api/mcp` and a default rule; HTTP returns `301` to `https://uat.<domain>/`; HTTPS
returns `503` (TLS works, no targets yet — expected).

### 6. Commit the root

```bash
git add infra/environments/uat
git commit -m "infra: add the UAT environment root"
git push origin main
```

**EVIDENCE 08.8** — paste `git log --oneline | head -1`.

## Success criteria

- [ ] 08.1–08.8 accepted
- [ ] HTTPS answers with a certificate for `uat.<domain>` (503 is fine)
- [ ] Both services at desired 0, secret has no version yet

## Failure modes

| Symptom | Cause / fix |
|---|---|
| Plan wants to replace something later | Never apply a replacement without a recorded decision. SG descriptions, RDS encryption, `db_name`, identifiers are ForceNew. |
| `data.aws_subnets.public` returns empty | No default VPC (Play 05 step 3). Supply explicit subnet ids in `main.tf`. |
| ACM stuck `PENDING_VALIDATION` | CNAME name or value copied with a trailing dot mismatch or wrong zone. Re-check with `dig +short CNAME <validation name>`. |
| `enable_https = true` apply fails on the listener | Certificate not yet `ISSUED`. Terraform does not check this for you. |
| `CannotPullContainerError` in events | Someone set `activate_services = true` early. It is a soft `check` block in Terraform, it only warns. Set it back to `false`, apply, continue with Play 09. |
