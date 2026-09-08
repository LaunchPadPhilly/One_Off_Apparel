# Play 13 — Security acceptance

**Goal:** every non-negotiable in `SECURITY.md` is verified against the **live**
environment, not the prose; the known gaps are recorded where the team will see them.

**Needs:** Play 10 (UAT) or Play 12 (production) closed. Run once per environment; the
commands use UAT names.

## Steps

### 1. Edge and transport

```bash
H=uat.<domain>
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://$H/
curl -sSI https://$H/ | grep -iE '^(HTTP|strict-transport|x-frame|content-security)' 
curl -sS -X POST -H 'Content-Type: application/json' -d '{}' -D - -o /dev/null https://$H/api/mcp | grep -iE '^(HTTP|www-authenticate)'
curl -sS https://$H/.well-known/oauth-authorization-server | jq '{token_endpoint_auth_methods_supported, code_challenge_methods_supported, grant_types_supported}'
```

**EVIDENCE 13.1** — paste it.
**Accept when:** HTTP → `301 https://...`; MCP unauthenticated → `401` with
`WWW-Authenticate: Bearer resource_metadata=...`; auth methods `["none"]`, PKCE `["S256"]`,
grants `authorization_code` and `refresh_token`. The absence of HSTS, X-Frame-Options and
CSP headers is a **known gap** (see step 5); record it, do not fail the play on it.

### 2. Network posture

```bash
P=<slug>-uat
aws rds describe-db-instances --db-instance-identifier $P-db --query 'DBInstances[0].{encrypted:StorageEncrypted,public:PubliclyAccessible,managed:MasterUserSecret.SecretStatus,sgs:VpcSecurityGroups[].VpcSecurityGroupId}' --output json
for n in $P-alb-sg $P-web-ecs-sg $P-mcp-ecs-sg $P-db-sg; do
  aws ec2 describe-security-groups --filters Name=group-name,Values=$n \
    --query 'SecurityGroups[0].{name:GroupName,ingress:IpPermissions[].{port:FromPort,cidrs:IpRanges[].CidrIp,sgs:UserIdGroupPairs[].GroupId}}' --output json
done
aws ecs describe-services --cluster $P-cluster --services $P-web $P-mcp --query 'services[].{name:serviceName,publicIp:networkConfiguration.awsvpcConfiguration.assignPublicIp,sgs:networkConfiguration.awsvpcConfiguration.securityGroups,execCmd:enableExecuteCommand}' --output json
```

**EVIDENCE 13.2** — paste it.
**Accept when:** RDS `encrypted true`, `public false`, managed password `active`, attached
to the `db-sg` only; ALB SG ingress is ports 80 and 443 from `0.0.0.0/0` only; web SG
ingress is port 3000 **from the ALB SG id** only; mcp SG port 3001 from the ALB SG only;
db SG port 5432 from the web and mcp SG ids only, no CIDRs; services `assignPublicIp
ENABLED` (known design: public subnets, no NAT; ingress still SG-limited) and
`enableExecuteCommand false`.

### 3. IAM and secrets scoping

```bash
aws iam list-attached-role-policies --role-name $P-task-execution-role --query 'AttachedPolicies[].PolicyName' --output json
aws iam list-role-policies --role-name $P-task-execution-role --output json
aws iam get-role-policy --role-name $P-task-execution-role --policy-name $P-secrets-read --query 'PolicyDocument.Statement[].{action:Action,resource:Resource}' --output json
aws iam list-attached-role-policies --role-name $P-task --query 'AttachedPolicies' --output json
aws iam list-role-policies --role-name $P-task --output json
aws ecs describe-task-definition --task-definition $P-web --query 'taskDefinition.containerDefinitions[0].{secrets:secrets[].name,env:environment}' --output json
aws ecs describe-task-definition --task-definition $P-mcp --query 'taskDefinition.containerDefinitions[0].{secrets:secrets[].name,env:environment}' --output json
```

**EVIDENCE 13.3** — paste it.
**Accept when:** execution role has only `AmazonECSTaskExecutionRolePolicy` attached plus
the inline `<prefix>-secrets-read` scoped to `uat/<slug>/app*`; the task role has **no**
policies; both containers' `secrets` lists equal the committed key lists (no
`MCP_SERVER_TOKEN` under Option A) and `env` is null. Key **names** are safe to paste;
values never appear in task definitions.

### 4. Application controls (browser, as admin)

Do each and state the result in one line:

1. Sign in with an account from a domain **not** in `GOOGLE_ALLOWED_DOMAIN` (or a consumer
   Gmail). Expect rejection. `/admin?screen=activity` shows `login_rejected_domain`.
2. Create a second user via Invite, sign in as them: they see no data pages and `/admin`
   returns 403 (`admin_access_denied` appears in activity).
3. Grant that user `data:read`, connect an MCP client or use an agent token as them, then
   **revoke the scope**: the next tool call is refused. This proves live intersection.
4. `/admin?screen=agents`: create and revoke a token; activity shows
   `agent_token_created` and `agent_token_revoked`.
5. Confirm the raw token was shown exactly once and cannot be viewed again.

**EVIDENCE 13.4** — five lines.
**Accept when:** all five behave as stated.

### 5. Record the known gaps (file change)

These were found by reading the code and are **not** fixed by configuration. Add them to
`CLAUDE.md` → Project State (or the client's risk register) so nobody rediscovers them:

| Gap | Where | Consequence | Mitigation today |
|---|---|---|---|
| `User.status = DISABLED` is not enforced | `src/lib/server/auth/session.ts`, MCP OAuth path | A disabled user keeps a valid 30-day session and can refresh MCP tokens | Revoke all scopes and admin role; delete `AuthSession` rows via a one-off task (Play 14) |
| Single-token revoke leaves the refresh token alive | `/admin/users/[id]` | Client refreshes within the hour | Use "Revoke all" or disable the OAuth client |
| Rate limiting keys on the ALB address | no `ADDRESS_HEADER` in the task env | All clients share one bucket for register/authorize/revoke | Add `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` to the web container environment in Terraform |
| No anti-clickjacking / HSTS / CSP headers | `hooks.server.ts` | Consent page could be framed | Add headers in `handle` |
| No audit event for successful MCP tool calls | `guardedToolResult` | Only rejections are recorded | Add an audit write per call |
| Prisma TLS uses `rejectUnauthorized: false` | `src/lib/server/prisma.ts` | Encrypted but unauthenticated DB connection inside the VPC | Set `db_ca_cert_identifier` and verify |
| ECR `scan_on_push = false`, tags mutable | `infra/global/main.tf` | No vulnerability scan, tags could be overwritten | Enable scanning; consider immutable tags |
| Terraform image-pin gate is a `check` block | `infra/modules/environment/ecs.tf` | Activation with unpinned images only warns | The evidence rule in Play 10 step 3 is the real gate |
| `INITIAL_ADMIN_EMAIL` compare is case-sensitive | Google callback | A capitalized value silently disables bootstrap | Use lowercase |

Also record: the `MCP_SERVER_TOKEN` decision (Option A or B), which scopes replace
`DATA_READ`/`REPORTS_READ`, the default grant, and who owns deployment, data and UI.

```bash
git add CLAUDE.md && git commit -m "docs: record security acceptance and known gaps" && git push origin main
git log --oneline | head -1
```

**EVIDENCE 13.5** — paste the commit line and the added section text.

## Success criteria

- [ ] 13.1–13.5 accepted
- [ ] Known gaps recorded in the repository, not only in the chat

## Never change (from the code, not negotiable per client)

Hash-only storage of tokens and sessions; `httpOnly`/`SameSite=Lax`/`Secure` cookies;
`hd`-claim enforcement; PKCE S256-only with exact `redirect_uri` match and single-use
codes (these substitute for the disabled SvelteKit origin check — do not toggle either in
isolation); live scope intersection; read-only tools; parameterized queries; Terraform never
managing secret values; `db_publicly_accessible = false`; ALB-only ingress to task SGs;
`slug`, cookie name and token prefix after launch.
