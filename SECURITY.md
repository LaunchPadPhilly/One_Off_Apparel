# Security

## Non-negotiable constraints

- Connector credentials (any external API) load server-side only — never in code paths
  reachable by the browser bundle, never as `PUBLIC_*` variables.
- All database queries are parameterized. Prisma's query builder, or `$queryRaw` with
  tagged-template parameters. Never string-interpolate user input into SQL.
- MCP tools are read-only: no INSERT/UPDATE/DELETE/DROP, and no side effects in upstream
  systems. Reviewers block any tool that writes.
- Logs never contain tokens, connection strings, raw upstream payloads, or personal data
  beyond what the audit log needs (actor id, action, resource id).
- Environment variables are validated at startup or first use without printing values.
- Sessions are `httpOnly`, `SameSite=Lax`, `Secure` in production. Tokens are stored
  only as SHA-256 hashes and shown to the user exactly once.
- Google login checks the signed `hd` claim against `GOOGLE_ALLOWED_DOMAIN`, never the
  email string alone.
- Scope grants are explicit, auditable and revocable. Admin does **not** imply data
  access; an admin grants scopes to themself through the UI, leaving an audit event.
- An OAuth token's effective scope is recomputed on every request as the intersection of
  the token's scope and the user's *current* grants, so revocation is immediate.

## Secrets handling for operators

- One flat JSON secret per environment in AWS Secrets Manager. Terraform creates the
  container; values are always written by a person with `put-secret-value`.
- Never print a secret value. Build `DATABASE_URL` with
  `scripts/fix-secret-database-url.sh`, which never passes the password through argv.
- ECS resolves secrets at task start. After changing a value, redeploy **both** services.
- `.env.local` is the only place for local credentials and is git-ignored. Check a key's
  presence with `grep -c '^KEY=' .env.local`; never grep with a pattern that prints values.

## Reporting

Report a suspected vulnerability privately to the repository owners listed in
`.github/CODEOWNERS`. Do not open a public issue. Rotate any credential you believe was
exposed before discussing how it happened.
