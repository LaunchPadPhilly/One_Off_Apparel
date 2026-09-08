---
name: security-review
description: Lightweight threat-model walk for a change: actor, entry point, trust boundary, data, authorization, abuse, mitigation. Used by the security-reviewer agent.
---

# Security review

For each change, walk:

```text
Actor          who can reach it: anonymous, staff session, admin, agent token, OAuth client
Entry point    route, form action, MCP tool, workflow, Terraform resource
Trust boundary browser → SvelteKit; MCP client → mcp server; task → RDS; CI → AWS
Data           what is read or written; is any of it a secret, token or personal data
Authorization  which guard runs (requireAdminApi, requireScopePage, guardedToolResult),
               and is the effective scope the live intersection
Potential abuse injection, missing validation, replay, scope escalation, leakage via logs
               or errors, SSRF from a connector, public exposure in Terraform
Mitigation     what already prevents it, what is missing, severity
```

Checklist anchors: `hd` claim not email; cookie flags; PKCE S256 and exact redirect match;
single-use codes; hash-only storage; parameterized queries; Zod on every input; read-only
tools; no `PUBLIC_*` secrets; no secret in logs, audit metadata or error responses;
execution-role secret access scoped to the environment's secret; RDS not public; ALB-only
ingress to task security groups.

Output uses the reviewer severities. State security impact explicitly for any change to
authentication, authorization, secrets or production security configuration.
