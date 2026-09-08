---
name: deploy-check
description: Pre-deploy and post-deploy checklist for the build-once / promote-unchanged pipeline. Used by the devops-engineer agent and before any production promotion.
---

# Deploy check

## Before merging to main

- `pnpm run db:validate && pnpm run check && pnpm run build && BUILD_TARGET=docker pnpm run build` pass.
- New env keys are in `.env.example` **and** in `web_secret_keys` / `mcp_secret_keys`, and
  the value exists in each environment's secret (Play 14 section C) before the deploy.
- Migration reviewed for live-data safety (`database-change` skill).
- Health checks unchanged or updated: web `/api/health`, mcp `/health`.
- Logging adds no tokens, connection strings or payloads.
- Rollback considered: previous SHA still in ECR; schema change is forward-compatible.
- MCP tool definitions changed? Release note tells connected clients to reconnect.

## UAT (automatic on push to main)

Watch `deploy.yml`; require `build`, `deploy-uat`, `smoke-test-uat` all green. Read the
image SHA from the run summary.

## Production (manual)

`gh workflow run deploy-production.yml -f image_sha=<sha>` with the SHA UAT proved. It
refuses any SHA not already in ECR. After it finishes: `./scripts/smoke-test.sh
https://<domain>` exit 0 and `aws ecs describe-services` showing both services stable on a
task definition whose image ends in `:<sha>`.

Evidence for each line above is pasted by a human; the agent does not run the deploy.
