#!/usr/bin/env bash
# Zero-hit gates for a repository generated from the template.
#   1. no unfilled __PLACEHOLDER__ tokens (outside the files that document them)
#   2. no leftover identifiers from the engagement the template was extracted from
#   3. no email addresses committed anywhere
# Exit 0 only when all three are clean. Runs over tracked files only.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
status=0

echo "== unfilled placeholders"
if git grep --untracked -n -E '__[A-Z_]+__' -- . ':!scripts/init-template.sh' ':!scripts/template-check.sh'; then
  echo "   ^ run ./scripts/init-template.sh"; status=1
else echo "   none"; fi

echo "== stray identifiers (client names, AWS account ids, VPC/subnet/SG ids)"
if git grep --untracked -n -i -E 'elevate|[0-9]{12}\.dkr\.ecr|vpc-[0-9a-f]{8,}|subnet-[0-9a-f]{8,}|sg-[0-9a-f]{8,}' -- . ':!scripts/template-check.sh' ':!pnpm-lock.yaml'; then
  status=1
else echo "   none"; fi

echo "== email addresses"
if git grep --untracked -n -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- . ':!pnpm-lock.yaml' ':!scripts/template-check.sh' | grep -v -E 'example\.(org|com)|noreply@|no-reply@'; then
  status=1
else echo "   none"; fi

exit $status
