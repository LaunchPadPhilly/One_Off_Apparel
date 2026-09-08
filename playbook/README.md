# Playbook: recreate this platform for a new client

This directory is a set of **plays**. Each play is a self-contained run book with one
goal, an ordered command sequence, the **evidence** the developer must paste into the
chat with their AI assistant, and the **success criteria** the assistant checks before
the next play is unlocked. No evidence, no advance.

The plays were derived from the repository as it exists (Terraform under `infra/`, the
workflows under `.github/workflows/`, the scripts under `scripts/`, and the setup guides
and `SECURITY.md`), then cross-checked against the code rather than the prose. Where
the two disagree, the play follows the code and says so.

## The plays, in dependency order

| # | Play | Goal | Needs |
|---|---|---|---|
| 01 | [Toolchain and access preflight](01-preflight.md) | Every tool, account and permission in hand before anything is created | — |
| 02 | [Template initialization](02-template-init.md) | Placeholders filled, coupled values consistent, the break-glass token decision made, gates green | 01 |
| 03 | [Google OAuth client](03-google-oauth-client.md) | A Web OAuth client with local and UAT redirect URIs registered | 02 |
| 04 | [Local development](04-local-development.md) | Web + MCP running locally; authenticated MCP tool call succeeds | 02, 03 |
| 05 | [AWS account prerequisites](05-aws-account-prereqs.md) | OIDC provider, operator identity, region fixed | 01 |
| 06 | [Terraform bootstrap and global](06-terraform-bootstrap-global.md) | State bucket, ECR repositories, GitHub deploy role | 02, 05 |
| 07 | [GitHub repository settings](07-github-settings.md) | Environments, role secret, OIDC subject verified, branch protection | 06 |
| 08 | [UAT bring-up, parked to HTTPS](08-uat-bringup.md) | UAT ALB, ECS (desired 0), RDS, secret container, certificate ISSUED, HTTPS listener | 06 |
| 09 | [UAT secret population](09-uat-secret.md) | The flat JSON secret complete and valid, DATABASE_URL built by script | 03, 08 |
| 10 | [First images, migration, activation](10-uat-activation.md) | Images in ECR, schema migrated, services running, smoke test exit 0, admin signs in | 07, 09 |
| 11 | [First green pipeline run](11-pipeline-run.md) | `deploy.yml` passes build → deploy-uat → smoke-test-uat end to end | 10 |
| 12 | [Production bring-up and promotion](12-production.md) | Production environment live on the SHA UAT proved | 11 |
| 13 | [Security acceptance](13-security-acceptance.md) | Every non-negotiable verified live; known gaps recorded | 10 or 12 |
| 14 | [Operations](14-operations.md) | Secret change, recovery, rollback, offboarding, on demand | 10 |

[CONFIDENCE.md](CONFIDENCE.md) rates each play for a developer with no prior experience
of this stack and names the concept they must learn first.

## The evidence protocol

1. Run the step exactly as written. Do not improvise flags.
2. Where a step says **EVIDENCE**, paste the complete command and its complete output into
   the chat, prefixed with the play and step number, for example `EVIDENCE 08.4`.
3. The assistant compares the output to the play's **Accept when** rule. If it does not
   match, the assistant says why and the developer fixes it before continuing. The
   assistant must not infer success from a partial paste.
4. A play is **closed** only when every item in its Success criteria has matching
   evidence in the chat. The assistant states "Play NN closed" explicitly.

### Never paste

These print secret material. If one of them appears in the chat, treat the credential as
exposed: say so at once, rotate it (Play 14), then continue.

- Any line of `.env.local`, `.env.uat`, `.env.production`, or a filled secret JSON.
- `aws secretsmanager get-secret-value` output.
- `DATABASE_URL`, `GOOGLE_CLIENT_SECRET`, `MCP_SERVER_TOKEN`, agent tokens, OAuth codes.
- `terraform.tfstate` or `terraform show` output (state can embed credentials).
- `aws ecs describe-task-definition` output is safe: it holds secret *ARNs*, not values.

Presence checks are always safe and are what the plays ask for:

```bash
grep -c '^DATABASE_URL=' .env.local          # prints a count, never a value
jq 'keys' "$F"                                # prints key names, never values
```

## Conventions used in every play

- `<slug>` is the project slug given to the init script; `<domain>` is the production hostname;
  `<region>` is the AWS region; `<acct>` is the 12-digit AWS account id.
- UAT names are `<slug>-uat-*`; production names are `<slug>-*`. Secrets are
  `uat/<slug>/app` and `prod/<slug>/app`.
- Commands run from the repository root unless a `cd` or `-chdir` is shown.
- `AWS_PROFILE` and `AWS_REGION` are exported once per shell (Play 05) and never hardcoded.
- Terraform: `init` always takes `-backend-config=<path to your backend.hcl>`; never
  apply a plan that contains a **replacement** or a **destroy** you did not intend.
