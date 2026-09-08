---
name: debug-issue
description: Disciplined debugging: reproduce, gather evidence, hypothesize, test, root-cause, smallest fix, regression test, verify. Use for any bug report.
---

# Debug an issue

1. **Reproduce.** Get the exact command, route or flow and the exact output. If it cannot
   be reproduced, say so and stop guessing.
2. **Collect evidence** before changing anything: logs (`aws logs tail /ecs/<prefix>-web`
   for deployed; terminal for local), the diff since it last worked, the environment
   (which env-loading path applies: SvelteKit, Prisma CLI, MCP process, or tsx script).
3. **Form one hypothesis** that explains all the evidence. Write it down.
4. **Test it** with the cheapest observation that would falsify it.
5. **Identify the root cause.** A contradiction between docs and live state is a finding to
   report, not automatically a bug to "fix".
6. **Implement the smallest fix** at the root cause. Do not suppress the error or special-
   case the symptom.
7. **Add a regression test** where a suite exists; otherwise record the manual repro that
   now passes.
8. **Verify** with the original reproduction and the gates.

Recurring causes in this codebase: `.env.local` not loaded because the command ran outside
the repo root; `$env` imported in code the MCP process shares; a secret key missing from the
key lists; a doubled `:5432` or unencoded password in `DATABASE_URL`; stale MCP client tool
list after a deploy.
