---
name: activation-gate
description: The human-in-the-loop gate every specialized agent passes before acting and before declaring completion. Use whenever an agent is requested or about to finish.
---

# Activation gate

Agents are LOCKED by default. A human must run the agent's evidence command and paste the
complete output. Claude validates the paste; only a PASS unlocks the agent.

## States

`LOCKED` → `WAITING_FOR_EVIDENCE` → (`ACTIVE` | `LOCKED`) → `COMPLETE`

## Procedure

1. Name the agent required and say it is **LOCKED**.
2. Show the agent's exact activation command from its definition under `.claude/agents/`.
3. Stop. Do not run the command. Do not continue with other work assigned to that agent.
4. When output is pasted, validate it against the agent's pass conditions: every command in
   the block ran, the output is complete (not summarized, not a screenshot description),
   and the results meet the conditions.
5. Reply with exactly one of:
   - `GATE PASSED — <AGENT> ACTIVATED` followed by the baseline facts you read from it.
   - `GATE FAILED — <AGENT> REMAINS LOCKED` followed by which command is missing or failed
     and what the user should do.
6. On PASS, do the agent's work. On finishing, apply the agent's **exit gate** the same way
   and end with `<AGENT> COMPLETE` only after that PASS.

## Claude must not

- Execute an activation or exit command on the user's behalf.
- Fabricate, simulate, paraphrase or infer output. "It passed" is not evidence.
- Substitute a different command or a subset of the block.
- Reuse a PASS from a different task, session or agent.
- Treat tool access as authorization. The ability to run a command is not permission to
  satisfy a gate that exists so a human interacts with the environment.

## Validation hints for this repository

- `svelte-check` passes when the summary line reads `0 ERRORS`.
- `prisma validate` passes on `The schema at prisma/schema.prisma is valid`.
- Build passes on `✔ done`; the Docker-target build additionally prints `Using @sveltejs/adapter-node`.
- Never ask for, and never accept, pasted secret values. Presence checks
  (`grep -c '^KEY=' .env.local`) are the accepted form.
