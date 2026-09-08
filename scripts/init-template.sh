#!/usr/bin/env bash
# Fill the template's placeholders in a freshly generated repository.
#
# Usage: ./scripts/init-template.sh            (interactive prompts)
#        ./scripts/init-template.sh --check    (list unfilled placeholders, change nothing)
#
# Safety: refuses to run on a dirty working tree, on a checkout with more than one
# commit (i.e. anything that is not a fresh "Use this template" clone), or with any
# empty answer. Touches only tracked files; never writes to .env.local or any other
# ignored file, and never writes a real secret — placeholders here are identifiers.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PLACEHOLDERS=(
  __PROJECT_SLUG__
  __PROJECT_DISPLAY_NAME__
  __PRIMARY_DOMAIN__
  __GOOGLE_ALLOWED_DOMAIN__
  __GITHUB_ORG__
  __GITHUB_REPO__
  __AWS_REGION__
  __STATE_BUCKET__
)

list_unfilled() {
  git grep --untracked -l -E '__[A-Z_]+__' -- . ':!scripts/init-template.sh' ':!scripts/template-check.sh' || true
}

if [[ "${1:-}" == "--check" ]]; then
  files="$(list_unfilled)"
  if [[ -z "$files" ]]; then echo "No unfilled placeholders."; exit 0; fi
  echo "Files with unfilled placeholders:"; echo "$files" | sed 's/^/  /'
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash first." >&2; exit 1
fi
if [[ "$(git rev-list --count HEAD)" -gt 1 ]]; then
  echo "This checkout has more than one commit. Run this only on a fresh repository generated from the template." >&2; exit 1
fi

declare -A VALUES
prompt() {
  local key="$1" help="$2" pattern="$3" value
  while true; do
    read -r -p "$key — $help: " value
    if [[ -z "$value" ]]; then echo "  A value is required." >&2; continue; fi
    if [[ -n "$pattern" && ! "$value" =~ $pattern ]]; then echo "  Must match $pattern" >&2; continue; fi
    VALUES["$key"]="$value"; break
  done
}

prompt __PROJECT_SLUG__          "lowercase, url-safe; resource prefix, db name, cookie/token prefix (e.g. acme-data)" '^[a-z][a-z0-9-]{1,30}$'
prompt __PROJECT_DISPLAY_NAME__  "human-readable name for titles and emails (e.g. Acme Data Platform)" ''
prompt __PRIMARY_DOMAIN__        "production hostname; UAT becomes uat.<this> (e.g. data.acme.org)" '^[a-z0-9.-]+\.[a-z]{2,}$'
prompt __GOOGLE_ALLOWED_DOMAIN__ "comma-separated Workspace domains allowed to sign in — include your dev team's while building" '^[a-z0-9.-]+(,[a-z0-9.-]+)*$'
prompt __GITHUB_ORG__            "GitHub organization owning this repo" '^[A-Za-z0-9-]+$'
prompt __GITHUB_REPO__           "repository name" '^[A-Za-z0-9._-]+$'
prompt __AWS_REGION__            "AWS region (e.g. us-east-1)" '^[a-z]{2}-[a-z]+-[0-9]$'
prompt __STATE_BUCKET__          "Terraform state bucket, globally unique (e.g. acme-data-terraform-state-123456789012)" '^[a-z0-9.-]{3,63}$'

echo
echo "Rewriting placeholders in tracked files..."
files="$(list_unfilled)"
for key in "${PLACEHOLDERS[@]}"; do
  value="${VALUES[$key]}"
  escaped="$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    sed -i "s|$key|$escaped|g" "$f"
  done <<< "$files"
done

# package.json's name cannot carry the placeholder (npm rejects names starting with "_"),
# so it is set explicitly here.
node --input-type=module --eval '
  import { readFileSync, writeFileSync } from "node:fs";
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  pkg.name = process.argv[1];
  pkg.description = `${process.argv[2]}: SvelteKit + Prisma/PostgreSQL + read-only MCP server + Terraform ECS Fargate.`;
  writeFileSync("package.json", `${JSON.stringify(pkg, null, "\t")}\n`);
' "${VALUES[__PROJECT_SLUG__]}" "${VALUES[__PROJECT_DISPLAY_NAME__]}"

remaining="$(list_unfilled)"
if [[ -n "$remaining" ]]; then
  echo "Some placeholders remain:" >&2; echo "$remaining" | sed 's/^/  /' >&2; exit 1
fi

echo
echo "Done. Review with: git diff"
echo "Then: pnpm install && pnpm run check && pnpm run template:check"
echo "Next: playbook/README.md — Play 02 step 3 onward, then Plays 03–12."
