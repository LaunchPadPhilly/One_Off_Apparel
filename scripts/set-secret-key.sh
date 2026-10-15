#!/usr/bin/env bash
# Set (or replace) one key in an environment's flat JSON app secret, without the value
# ever appearing on screen, in shell history or in a command line.
#
#   AWS_PROFILE=ooa scripts/set-secret-key.sh uat/ooa/app ANTHROPIC_API_KEY
#
# Prompts for the value (input hidden), merges it into the current secret with every
# other key untouched, uploads a new version and deletes the temp file. A key the app
# should receive must also be listed in web_secret_keys / mcp_secret_keys (and applied),
# and the services redeployed — ECS reads secrets only at task start (Play 14 C).
set -euo pipefail

SECRET_ID="${1:?usage: set-secret-key.sh <secret-id> <KEY>}"
KEY="${2:?usage: set-secret-key.sh <secret-id> <KEY>}"
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "KEY must look like ANTHROPIC_API_KEY" >&2; exit 2; }
for c in aws jq; do command -v "$c" >/dev/null || { echo "$c not found" >&2; exit 1; }; done
# Git Bash: aws.exe needs a Windows path for file:// arguments.
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf 'Value for %s (input hidden): ' "$KEY" >&2
IFS= read -rs VALUE
printf '\n' >&2
[ -n "$VALUE" ] || { echo "No value entered; nothing changed." >&2; exit 1; }
printf '%s' "$VALUE" > "$WORK/value"
unset VALUE

aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text > "$WORK/old.json"
before="$(jq -c 'keys' "$WORK/old.json")"
jq --rawfile v "$WORK/value" --arg k "$KEY" '.[$k] = $v' "$WORK/old.json" > "$WORK/new.json"
after="$(jq -c 'keys' "$WORK/new.json")"
# Every other key must be unchanged.
jq -e --arg k "$KEY" --slurpfile old "$WORK/old.json" 'del(.[$k]) == ($old[0] | del(.[$k]))' "$WORK/new.json" >/dev/null \
	|| { echo "Refusing: keys other than $KEY would change." >&2; exit 1; }

aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$(winpath "$WORK/new.json")" --query VersionStages --output text >/dev/null
if [ "$before" = "$after" ]; then echo "Replaced $KEY in $SECRET_ID."; else echo "Added $KEY to $SECRET_ID."; fi
echo "Keys now: $after"
