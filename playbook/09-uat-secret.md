# Play 09 — UAT secret population

**Goal:** the flat JSON secret `uat/<slug>/app` holds every key the task definitions
inject, every value is real, and `DATABASE_URL` was built by the script from the
RDS-managed master password, never typed by hand.

**Needs:** Plays 03 and 08 closed. Shell exports active. `jq` installed.

No secret value may appear in the chat during this play. Every evidence command below
prints key names, counts, or booleans only.

## Steps

### 1. Start from the template, outside the repo

```bash
umask 077
F="$(mktemp /tmp/app-secret.XXXXXX)"
jq 'del(._comment)' infra/environments/uat/secret.template.json > "$F"
jq 'keys' "$F"
```

**EVIDENCE 09.1** — paste the key list.
**Accept when:** the keys are exactly the union of `web_secret_keys` and
`mcp_secret_keys` from `infra/environments/uat/variables.tf` (under Option A, no
`MCP_SERVER_TOKEN`). The assistant compares against the committed lists.

### 2. Fill the human-owned values

Edit `$F` with `"${EDITOR:-vi}" "$F"` and set:

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Play 03 client |
| `GOOGLE_REDIRECT_URI` | `https://uat.<domain>/api/auth/google/callback` (pre-filled; verify) |
| `GOOGLE_ALLOWED_DOMAIN` | pre-filled by init; verify |
| `INITIAL_ADMIN_EMAIL` | first admin, exact case, in an allowed domain |
| `MCP_OAUTH_ISSUER_URL` | `https://uat.<domain>` (no path) |
| `MCP_PUBLIC_URL` | `https://uat.<domain>/api/mcp` |
| `MCP_OAUTH_SCOPES` | `data:read reports:read` |
| `MCP_SERVER_TOKEN` | **Option B only:** output of `openssl rand -base64 48` |

Leave `DATABASE_URL` as the template placeholder; the next step overwrites it.

### 3. Build `DATABASE_URL` from RDS, never by hand

```bash
./scripts/fix-secret-database-url.sh build --env uat --from-rds-secret --merge-into "$F"
```

The script reads `db_endpoint` and `db_master_user_secret_arn` from Terraform outputs,
fetches the managed password, percent-encodes it, refuses duplicated ports, and merges the
result into `$F` with mode 600. It prints only the host and database name.

**EVIDENCE 09.2** — paste the script's output.
**Accept when:** it reports success and names `<slug>-uat-db...:5432` and database
`<slug>`; no password fragment is visible.

### 4. Validate, printing nothing

```bash
jq --exit-status --slurpfile t infra/environments/uat/secret.template.json '
  ($t[0] | del(._comment) | keys) as $req | keys as $have |
  (($req - $have) | length == 0) and
  all(to_entries[]; (.value|type=="string") and (.value|length>0) and ((.value|startswith("<"))|not))
' "$F" > /dev/null && echo VALUES_OK
comm -13 <(jq -r 'keys[]' "$F" | sort) <(grep -oE '"[A-Z_]{4,}"' infra/environments/uat/variables.tf | tr -d '"' | sort -u) | sed 's/^/MISSING_FROM_SECRET: /'
jq -r '.DATABASE_URL | capture("^postgresql://[^:]+:[^@]+@(?<hostport>[^/]+)/(?<db>[^?]+)(?<q>\\?.*)?$") | "host=\(.hostport) db=\(.db) query=\(.q // "")"' "$F"
jq -r '.GOOGLE_REDIRECT_URI, .MCP_OAUTH_ISSUER_URL, .MCP_PUBLIC_URL, .MCP_OAUTH_SCOPES, .GOOGLE_ALLOWED_DOMAIN' "$F"
```

**EVIDENCE 09.3** — paste all four outputs.
**Accept when:** `VALUES_OK`; no `MISSING_FROM_SECRET:` lines (every key Terraform injects
exists in the JSON); the `DATABASE_URL` summary shows one `:5432` and `db=<slug>`; the
four URL values match Play 08's hostname and the allowed domains are correct. The
`capture` prints host, database and query only.

### 5. Upload, then destroy the file

```bash
aws secretsmanager put-secret-value --secret-id uat/<slug>/app --secret-string "file://$F" --query 'VersionStages' && rm -f "$F"
aws secretsmanager describe-secret --secret-id uat/<slug>/app --query '{name:Name,stages:VersionIdsToStages}' --output json
ls "$F" 2>/dev/null || echo FILE_REMOVED
```

**EVIDENCE 09.4** — paste the outputs.
**Accept when:** one version carries `AWSCURRENT`, and `FILE_REMOVED`.

### 6. Prove ECS can read it

Task startup needs the execution role to read this exact secret. Confirm the scoped
policy:

```bash
aws iam list-role-policies --role-name <slug>-uat-task-execution-role --output json
aws iam get-role-policy --role-name <slug>-uat-task-execution-role --policy-name <slug>-uat-secrets-read --query 'PolicyDocument.Statement[].{action:Action,resource:Resource}' --output json
```

**EVIDENCE 09.5** — paste it.
**Accept when:** the inline policy grants `secretsmanager:GetSecretValue` on the
`uat/<slug>/app` secret ARN followed by `*`, and nothing broader.

## Success criteria

- [ ] 09.1–09.5 accepted
- [ ] No secret value in the chat; the temp file is gone

## Failure modes

| Symptom | Cause / fix |
|---|---|
| Script cannot read the RDS secret | Operator lacks `secretsmanager:GetSecretValue` on `rds!*`. Grant it, or run `build` without `--from-rds-secret` and paste the password at the hidden prompt. |
| Script refuses: password "mixes %XX and raw reserved characters" | Ambiguous input. Use the RDS-managed source, not a copied string. |
| `MISSING_FROM_SECRET:` lines | You removed a key from the JSON but not from `variables.tf` (or the reverse). Both must agree or the task fails at start. |
| Later: `ResourceInitializationError` on task start | Same cause, or the execution role policy points at a different secret ARN. |
