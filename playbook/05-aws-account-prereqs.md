# Play 05 — AWS account prerequisites

**Goal:** the account-level, once-per-account facts are in place: region chosen, operator
identity working, GitHub OIDC identity provider present.

**Needs:** Play 01 closed.

## Steps

### 1. Fix the shell

Every AWS command in every later play assumes these two exports in the current shell:

```bash
export AWS_PROFILE=<operator-profile>
export AWS_REGION=<region>
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
aws configure get region
```

**EVIDENCE 05.1** — paste the output.
**Accept when:** account id matches Play 01; `aws configure get region` prints `<region>`
or is empty (the export wins).

### 2. GitHub OIDC identity provider (account-shared, create once)

```bash
aws iam list-open-id-connect-providers --output json
```

If the list contains an ARN ending in `oidc-provider/token.actions.githubusercontent.com`,
skip creation. Otherwise:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
aws iam list-open-id-connect-providers --output json
```

**EVIDENCE 05.2** — paste the final list output.
**Accept when:** exactly one ARN for `token.actions.githubusercontent.com`. Terraform in
Play 06 references this provider by ARN and does not manage it.

### 3. Confirm the default VPC exists

The environment module discovers the **default VPC** and its default-for-AZ subnets. A new
account has one unless someone deleted it.

```bash
aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[].{id:VpcId,cidr:CidrBlock}' --output json
aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'length(Subnets)'
```

**EVIDENCE 05.3** — paste both outputs (VPC ids are fine in the chat, never in the repo).
**Accept when:** one default VPC and at least two subnets. If there is no default VPC,
stop: the environment root's `data "aws_subnets"` returns nothing and you would have to
supply explicit subnet ids in `infra/environments/<env>/main.tf`. Decide that before
Play 08.

### 4. Service quotas worth a glance

```bash
aws service-quotas get-service-quota --service-code elasticloadbalancing --quota-code L-53DA6B97 --query 'Quota.Value'
aws service-quotas get-service-quota --service-code rds --quota-code L-7B6409FD --query 'Quota.Value'
```

**EVIDENCE 05.4** — paste both numbers.
**Accept when:** ALB quota ≥ 2 and DB instances quota ≥ 2 (two environments).

## Success criteria

- [ ] 05.1–05.4 accepted

## Failure modes

| Symptom | Cause / fix |
|---|---|
| `AccessDenied` on `create-open-id-connect-provider` | The operator identity lacks IAM rights. This is an account-admin task; have the admin run step 2. |
| `EntityAlreadyExists` | Provider exists; use the list output. |
| No default VPC | Create one with `aws ec2 create-default-vpc` (account admin) or plan explicit subnets. |
