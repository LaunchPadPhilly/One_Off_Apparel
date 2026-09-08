---
name: review-pr
description: Standard review rubric and output format. Used by the reviewer agent and by anyone reviewing a PR.
---

# Review a PR

Read the full diff (`git diff main...HEAD`) and open every touched file in context.

Rubric, in order: **Requirements** (acceptance criteria met, nothing extra) ·
**Correctness** (edge cases, error handling, concurrency) · **Security** (`SECURITY.md`
non-negotiables; hand anything auth/secret related to `security-reviewer`) ·
**Architecture** (right layer, existing patterns, runes, `process.env` in shared code) ·
**Testing** (suite or recorded manual verification) · **Maintainability** (complexity,
naming, dead code) · **Observability** (audit events for state changes, no sensitive logs) ·
**Documentation** (README, `CLAUDE.md`, the affected play, `.env.example`, key lists,
`Dockerfile.mcp` COPY).

Output findings most severe first, each as `SEVERITY file:line — claim; failure scenario;
fix`. Severities: BLOCKER, HIGH, MEDIUM, LOW, SUGGESTION. Findings only; no praise
paragraphs. If nothing is found, list what was checked and how.
