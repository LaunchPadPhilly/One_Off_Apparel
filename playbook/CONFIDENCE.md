# Confidence assessment

Audience: a developer who can use a terminal and git but has **no prior experience** with
Terraform, AWS ECS/Fargate, Prisma, SvelteKit, GitHub Actions OIDC, or OAuth 2.1, working
through the plays with an AI assistant that enforces the evidence protocol.

Scale for **confidence** (that the play closes on the first serious attempt when followed
exactly): High ≥ 80 %, Medium 50–80 %, Low < 50 %. **Difficulty** is 1–5 for the concept
load, taken from the specialist reviews.

| Play | Difficulty | Confidence | Why, and the one concept to learn first |
|---|---|---|---|
| 01 Preflight | 2 | High | Installing tools. The trap is permissions: the template ships no operator IAM policy, so bring-up realistically runs as an admin identity. Learn: AWS profiles and `sts get-caller-identity`. |
| 02 Template init | 2 | High | The init script is deterministic and self-checking. The break-glass token decision is the only judgment call and the play makes it binary. Learn: what a placeholder rewrite touches. |
| 03 Google OAuth client | 3 | Medium | Console clicks, but the consent-screen type and byte-exact redirect URIs cause most first-time failures. Learn: the authorization-code redirect flow. |
| 04 Local development | 3 | Medium | Four different env-loading mechanisms and a one-shot admin bootstrap. `pnpm run test` names faults precisely, which helps. Learn: `.env.local` is loaded relative to the repo root; the first login is special. |
| 05 AWS prerequisites | 3 | High | Three commands; the OIDC provider may need an account admin. Learn: what an IAM identity provider is. |
| 06 Bootstrap and global | 4 | Medium | Local state that must be backed up; backend partial config on every `init`; OIDC trust-policy subjects. Learn: Terraform state and backends. |
| 07 GitHub settings | 3 | High | Few steps, but environment names and secret scope are load-bearing and fail silently later. Learn: environment-scoped vs repository secrets. |
| 08 UAT bring-up | 4 | Medium | Reading a 20-plus-resource plan, RDS wait times, DNS propagation, and a soft Terraform gate that only warns. The evidence rules substitute for Terraform's missing hard checks. Learn: what a plan's add/change/destroy/replace means. |
| 09 UAT secret | 5 | Medium | The most error-prone step on the original engagement (URL encoding, doubled port, missing keys). The script plus the key-diff check make it mechanical, but the operator needs `GetSecretValue` on the RDS-managed secret. Learn: ECS per-key `valueFrom` and why a missing key kills the task. |
| 10 Activation | 5 | Medium | A deliberate red pipeline run, then pinning, then moving services onto a revision. Every step has a describe-command check. Learn: task-definition families/revisions and `ignore_changes`. |
| 11 Pipeline run | 3 | High | Watching and reading a run. Learn: build-once/promote-unchanged. |
| 12 Production | 4 | Medium | Repetition of 08–10 with five value changes; the refusal test adds confidence. Learn: nothing new; discipline. |
| 13 Security acceptance | 4 | Medium | Commands are given; interpreting SG output and the three-layer model (session → token → live grant) takes thought. Learn: that layered model. |
| 14 Operations | 3–5 | Medium | Routine sections (release, secret change) are High; recovery and offboarding are Low without help because the code has gaps (DISABLED not enforced, loaders not in the mcp image). |

## Overall

**End-to-end, first attempt, with the assistant enforcing evidence: Medium (about 60–70 %).**
The most likely stall points, in order: Play 09 (secret and `DATABASE_URL`), Play 10
(first pipeline run and activation ordering), Play 06 (OIDC trust and backend config),
Play 03 (Google consent screen). None are dead ends; each has a failure table whose fixes
were derived from the code.

Without the assistant and evidence protocol, the same developer's confidence drops to
**Low**: the original engagement's history shows the recurring faults (doubled port,
unencoded password, environment-scoped secret invisible to the build job, repository
transfer changing the OIDC subject) were only caught by verifying live state.

## What would raise confidence to High

These are template changes, not playbook changes. They are listed so the owner can decide:

1. Turn the activation `check` block into a `lifecycle { precondition }` on both services
   so Terraform refuses unpinned activation instead of warning.
2. Remove `MCP_SERVER_TOKEN` from the default key lists and the secret template (make
   Play 02's Option A the shipped default).
3. Commit a placeholder-driven operator IAM policy (account id, slug and region as
   placeholders) so Play 01 step 2 is a file, not a paragraph.
4. Add `ADDRESS_HEADER=X-Forwarded-For` / `XFF_DEPTH=1` to the web task definition.
5. Enforce `User.status = DISABLED` in session lookup and the OAuth token path; add
   security headers on the consent page.
6. Copy `scripts/` into `Dockerfile.mcp` or delete the data-loader instructions.
7. Make `ci.yml` also run `BUILD_TARGET=docker pnpm run build` so the shipped adapter is
   exercised before merge.

## Parts of the template never exercised in a clean account

Stated by the template author and confirmed by the reviews: the variable-driven OIDC trust
policy in `infra/global`, the workflows' `describe-services`-derived migration networking,
and the squashed `0001_init` migration. Plays 06, 10 and 04 are their first real test; if
one of them teaches something, fix the template and the play together.
