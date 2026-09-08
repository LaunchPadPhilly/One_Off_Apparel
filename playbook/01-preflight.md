# Play 01 — Toolchain and access preflight

**Goal:** every tool, account and permission needed by Plays 02–14 is in hand and proven
before anything is created. Nothing in this play changes any system.

**Needs:** nothing.

## Inputs to collect (write them down; none are secret)

| Name | Example | Used by |
|---|---|---|
| Client slug (init prompt PROJECT_SLUG) | `acme-data` | every resource name, cookie and token prefix |
| Display name | `Acme Data Platform` | UI titles |
| Production hostname (init prompt PRIMARY_DOMAIN) | `data.acme.org` | ACM, ALB, OAuth. UAT becomes `uat.data.acme.org` |
| Google Workspace domain(s) allowed to sign in | `acme.org,yourdevshop.com` | login gate. Include the dev team's domain while building |
| First admin's Workspace email | `ops@example.org` | one-shot admin bootstrap |
| GitHub org and repo | `AcmeOrg` / `acme-data` | OIDC trust policy |
| AWS region | `us-east-1` | everything |
| AWS account id | 12 digits | state bucket name, ECR URIs |
| Terraform state bucket | `acme-data-terraform-state-<acct>` | must be globally unique |

Consumer Gmail accounts can never sign in: the app checks Google's signed `hd` claim,
which only Workspace accounts carry. Every allowed domain must be a Workspace domain.

## Steps

### 1. Local tools

```bash
git --version
node --version            # must be v24.x
corepack enable && pnpm --version   # 11.x after corepack picks up package.json later
docker --version
terraform version         # >= 1.11
aws --version             # aws-cli/2.x
gh --version
jq --version
curl --version | head -1
openssl version
```

**EVIDENCE 01.1** — paste the full output.
**Accept when:** Node major is 24, Terraform is 1.11 or newer, AWS CLI is 2.x, and every
command printed a version.

### 2. AWS identity

```bash
export AWS_PROFILE=<operator-profile>
export AWS_REGION=<region>
aws sts get-caller-identity
```

**EVIDENCE 01.2** — paste the output (account id and ARN are not secret).
**Accept when:** the account id is the client's account and the ARN is the identity you
intend to run Terraform as.

The template ships **no IAM policy for this operator**. The least-privilege policy used on
the original engagement lives outside the repository and is hard-coded to that account.
For a first bring-up, run as an identity that can create: S3 buckets and bucket policies,
IAM roles and role policies, IAM OIDC providers, ECR repositories and lifecycle policies,
ECS clusters/services/task definitions, ALBs/target groups/listeners, EC2 security groups,
ACM certificates, RDS instances, Secrets Manager secrets (create, put and get values,
including the RDS-managed `rds!` secret), and CloudWatch log groups. `AdministratorAccess`
on a dedicated bring-up role satisfies this; tighten after Play 12.

### 3. GitHub

```bash
gh auth status
gh repo view <org>/<repo> --json name,owner,isPrivate,visibility 2>/dev/null || echo "repo not created yet (fine)"
```

**EVIDENCE 01.3** — paste the output.
**Accept when:** `gh` is logged in as an account with admin rights on the target org.

### 4. Google Cloud and DNS

Confirm, in words in the chat: (a) you can create a project or OAuth client in a Google
Cloud project tied to the client's Workspace, and (b) you can add CNAME records at the
DNS provider for `<domain>`.

**EVIDENCE 01.4** — one sentence for each.

## Success criteria

- [ ] 01.1 accepted (tool versions)
- [ ] 01.2 accepted (AWS identity in the right account)
- [ ] 01.3 accepted (GitHub admin)
- [ ] 01.4 accepted (Google Cloud and DNS access confirmed)
- [ ] Inputs table above filled in and pasted into the chat (no secrets appear in it)

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `SignatureDoesNotMatch` from STS | Access key is stale or rotated. Regenerate in IAM and update `~/.aws/credentials`. Not a clock problem. |
| `pnpm` not found after `corepack enable` | Restart the shell; corepack installs pnpm on first use once `package.json` pins it (Play 02). |
| Terraform below 1.11 | `versions.tf` requires `>= 1.11` (`use_lockfile` on the S3 backend). Upgrade. |
