#!/usr/bin/env bash
# Smoke test for a deployed environment (UAT or production).
#
#   scripts/smoke-test.sh https://uat.__PRIMARY_DOMAIN__
#   scripts/smoke-test.sh https://__PRIMARY_DOMAIN__ --skip-redirect
#   scripts/smoke-test.sh <base-url> --db-check /api/ready
#
# Checks (curl only, no other deps; exits nonzero if any check fails):
#   1. GET /api/health                          -> 200 with "ok": true   (web liveness)
#   2. GET /api/mcp (no auth)                   -> 401 + WWW-Authenticate (mcp service
#      reachable via the ALB path rule and its OAuth middleware alive — mcp's own
#      /health is only reachable by the target-group health check, never externally)
#   3. GET /.well-known/oauth-authorization-server -> 200, issuer contains this host
#      (guards the wrong-issuer misconfig class from RCA-2026-09-01)
#   4. GET /                                    -> 200 or 3xx (auth redirect is fine)
#   5. http://<host>/                           -> 301/308 to https (skip with
#      --skip-redirect for local development, which has no TLS listener)
#   6. optional --db-check <path>               -> 200 (a DB-touching endpoint;
#      /api/health is liveness-only and proves nothing about the database)
set -uo pipefail

BASE="${1:?usage: smoke-test.sh <base-url> [--skip-redirect] [--db-check <path>]}"
shift || true
SKIP_REDIRECT=0
DB_CHECK_PATH=""
while [ $# -gt 0 ]; do
	case "$1" in
		--skip-redirect) SKIP_REDIRECT=1 ;;
		--db-check) DB_CHECK_PATH="${2:?--db-check needs a path}"; shift ;;
		*) echo "unknown flag: $1" >&2; exit 2 ;;
	esac
	shift
done

BASE="${BASE%/}"
HOST="$(printf '%s' "$BASE" | sed -E 's|^https?://||; s|/.*||')"
FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

# 1. web liveness
body="$(curl -sS --max-time 15 -w '\n%{http_code}' "$BASE/api/health" 2>/dev/null)"
code="${body##*$'\n'}"
if [ "$code" = "200" ] && printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
	pass "/api/health -> 200 ok:true"
else
	fail "/api/health -> $code (expected 200 with ok:true)"
fi

# 2. mcp reachability + auth challenge
hdrs="$(curl -sS --max-time 15 -o /dev/null -D - -X POST "$BASE/api/mcp" \
	-H 'Content-Type: application/json' -d '{}' 2>/dev/null)"
code="$(printf '%s' "$hdrs" | head -1 | awk '{print $2}')"
if [ "$code" = "401" ] && printf '%s' "$hdrs" | grep -qi '^www-authenticate:'; then
	pass "/api/mcp unauthenticated -> 401 with WWW-Authenticate"
else
	fail "/api/mcp unauthenticated -> $code (expected 401 + WWW-Authenticate)"
fi

# 3. OAuth metadata issuer
meta="$(curl -sS --max-time 15 -w '\n%{http_code}' "$BASE/.well-known/oauth-authorization-server" 2>/dev/null)"
code="${meta##*$'\n'}"
if [ "$code" = "200" ] && printf '%s' "$meta" | grep -q "\"issuer\"[[:space:]]*:[[:space:]]*\"[^\"]*$HOST"; then
	pass "oauth-authorization-server -> 200, issuer matches $HOST"
else
	fail "oauth-authorization-server -> $code or issuer does not contain $HOST"
fi

# 4. root page
code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)"
case "$code" in
	200|30[0-8]) pass "/ -> $code" ;;
	*) fail "/ -> $code (expected 200 or 3xx)" ;;
esac

# 5. http -> https redirect
if [ "$SKIP_REDIRECT" = "0" ]; then
	line="$(curl -sSI --max-time 15 "http://$HOST/" 2>/dev/null | tr -d '\r')"
	code="$(printf '%s' "$line" | head -1 | awk '{print $2}')"
	loc="$(printf '%s\n' "$line" | grep -i '^location:' | head -1)"
	if { [ "$code" = "301" ] || [ "$code" = "308" ]; } && printf '%s' "$loc" | grep -q 'https://'; then
		pass "http://$HOST/ -> $code to https"
	else
		fail "http://$HOST/ -> $code (expected 301/308 to https; use --skip-redirect if the :80 fix hasn't landed)"
	fi
else
	printf 'SKIP  http->https redirect (--skip-redirect)\n'
fi

# 6. optional DB-touching endpoint
if [ -n "$DB_CHECK_PATH" ]; then
	code="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$BASE$DB_CHECK_PATH" 2>/dev/null)"
	if [ "$code" = "200" ]; then
		pass "db check $DB_CHECK_PATH -> 200"
	else
		fail "db check $DB_CHECK_PATH -> $code (expected 200)"
	fi
fi

if [ "$FAIL" = "0" ]; then
	echo "SMOKE TEST PASSED: $BASE"
else
	echo "SMOKE TEST FAILED: $BASE" >&2
fi
exit "$FAIL"
