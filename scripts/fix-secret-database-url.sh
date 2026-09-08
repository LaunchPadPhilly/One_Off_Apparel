#!/usr/bin/env bash
# Build or repair the database connection string that goes into an AWS Secrets
# Manager secret. Two subcommands:
#
#   build   Format a connection string locally from a password you supply, or
#           straight from the RDS-managed master credential. Needs no read
#           access to the application secret.
#
#             scripts/fix-secret-database-url.sh build --env uat
#             scripts/fix-secret-database-url.sh build --env uat --from-rds-secret
#             scripts/fix-secret-database-url.sh build --env uat --merge-into ./uat.json
#
#   repair  Read an existing secret, fix a malformed connection string in place,
#           and write a new version. Dry run unless --apply.
#
#             scripts/fix-secret-database-url.sh repair uat/__PROJECT_SLUG__/app
#             scripts/fix-secret-database-url.sh repair uat/__PROJECT_SLUG__/app --apply
#
# Both modes fix the two faults that have actually broken this project:
#
#   1. A doubled port. `terraform output db_endpoint` already ends in `:5432`,
#      so appending the port again yields `host:5432:5432`, which Prisma
#      rejects with `P1013: invalid port number in database URL`.
#   2. Reserved characters in the password. A raw `#`, `?`, `/`, `@` or `<`
#      truncates the string at parse time. RDS-managed passwords routinely
#      contain them, so this is the common case, not the exotic one.
#
# Handling of secret material:
#   - The password is never taken as a command-line argument, so it cannot land
#     in `ps` output or shell history. `build` prompts for it silently, or reads
#     it from the RDS-managed secret.
#   - The finished URL contains the password, so it is written to a 0600 file
#     rather than printed. `--print` overrides that, deliberately and loudly.
#   - Diagnostics only ever report what follows the last `@` — host, port,
#     database, query string. Reading the query off the whole URL leaks
#     password material, because a raw `?` in the password is matched first.
#
# Deliberately not changed: the query string. `src/lib/server/prisma.ts` strips
# `sslmode` for `amazonaws.com` hosts and sets `ssl: { rejectUnauthorized:
# false }` itself, so adding or removing it here would be noise.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_LIB="$REPO_ROOT/scripts/lib/database-url.mjs"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
[ -f "$NODE_LIB" ] || { echo "missing helper: $NODE_LIB" >&2; exit 1; }

SUB="${1:-}"
case "$SUB" in
	build|repair) shift ;;
	""|-h|--help) usage; exit 0 ;;
	*)
		# Backwards compatible: a bare secret id means repair.
		SUB="repair"
		;;
esac

# ----------------------------------------------------------------- build mode
if [ "$SUB" = "build" ]; then
	ENVIRONMENT="uat"
	DB_USER=""
	DB_ENDPOINT=""
	DB_NAME="__PROJECT_SLUG__"
	OUT_FILE=""
	MERGE_INTO=""
	FROM_RDS=0
	PRINT=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--env) ENVIRONMENT="${2:?--env needs uat or production}"; shift ;;
			--user) DB_USER="${2:?--user needs a value}"; shift ;;
			--endpoint) DB_ENDPOINT="${2:?--endpoint needs host[:port]}"; shift ;;
			--database) DB_NAME="${2:?--database needs a value}"; shift ;;
			--out) OUT_FILE="${2:?--out needs a path}"; shift ;;
			--merge-into) MERGE_INTO="${2:?--merge-into needs a path}"; shift ;;
			--from-rds-secret) FROM_RDS=1 ;;
			--print) PRINT=1 ;;
			*) echo "unknown argument for build: $1" >&2; exit 2 ;;
		esac
		shift
	done

	TF_ROOT="$REPO_ROOT/infra/environments/$ENVIRONMENT"
	if [ -z "$DB_ENDPOINT" ] && [ -d "$TF_ROOT" ]; then
		echo "Reading db_endpoint from $ENVIRONMENT Terraform outputs ..."
		DB_ENDPOINT="$(terraform -chdir="$TF_ROOT" output -raw db_endpoint 2>/dev/null || true)"
	fi
	[ -n "$DB_ENDPOINT" ] || { echo "Could not determine the endpoint. Pass --endpoint host:port." >&2; exit 1; }

	umask 077
	PW_FILE="$(mktemp "${TMPDIR:-/tmp}/dburl-pw.XXXXXX")"
	URL_FILE="$(mktemp "${TMPDIR:-/tmp}/dburl-out.XXXXXX")"
	cleanup_build() { rm -f "$PW_FILE" "$URL_FILE"; }
	trap cleanup_build EXIT

	if [ "$FROM_RDS" -eq 1 ]; then
		command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
		RDS_SECRET_ARN="$(terraform -chdir="$TF_ROOT" output -raw db_master_user_secret_arn 2>/dev/null || true)"
		[ -n "$RDS_SECRET_ARN" ] || { echo "No db_master_user_secret_arn output; this environment's password is not RDS-managed." >&2; exit 1; }
		echo "Reading the RDS-managed master credential ..."
		if ! aws secretsmanager get-secret-value --secret-id "$RDS_SECRET_ARN" \
			--query SecretString --output text > "$PW_FILE" 2>/dev/null; then
			echo "Could not read $RDS_SECRET_ARN — this identity may lack secretsmanager:GetSecretValue on rds!* secrets." >&2
			echo "Re-run without --from-rds-secret to enter the password instead." >&2
			exit 1
		fi
	else
		# -s keeps it off the screen; reading into a variable keeps it out of argv.
		printf 'Password for the database role (input hidden): ' >&2
		IFS= read -rs DB_PASSWORD
		printf '\n' >&2
		[ -n "$DB_PASSWORD" ] || { echo "No password entered." >&2; exit 1; }
		printf '%s' "$DB_PASSWORD" > "$PW_FILE"
		unset DB_PASSWORD
	fi

	BUILD_MODE="$([ "$FROM_RDS" -eq 1 ] && echo rds-secret || echo raw-password)" \
	PW_FILE="$PW_FILE" URL_FILE="$URL_FILE" DB_USER="$DB_USER" \
	DB_ENDPOINT="$DB_ENDPOINT" DB_NAME="$DB_NAME" REPO_ROOT="$REPO_ROOT" \
	node "$NODE_LIB" build

	if [ -n "$MERGE_INTO" ]; then
		[ -f "$MERGE_INTO" ] || { echo "No such file: $MERGE_INTO" >&2; exit 1; }
		URL_FILE="$URL_FILE" MERGE_INTO="$MERGE_INTO" REPO_ROOT="$REPO_ROOT" \
		node "$NODE_LIB" merge
		echo ""
		echo "Updated $MERGE_INTO in place. Upload it with:"
		echo "  aws secretsmanager put-secret-value --secret-id <secret-id> --secret-string \"file://$MERGE_INTO\""
		echo "Then delete the file."
		exit 0
	fi

	if [ "$PRINT" -eq 1 ]; then
		echo ""
		echo "--- connection string (contains the password; it is now in your scrollback) ---"
		cat "$URL_FILE"; echo
		exit 0
	fi

	# Default deliberately outside the repository. An earlier draft defaulted to
	# the repo root, where `.gitignore`'s .env rules would NOT have matched it —
	# a password-bearing file one `git add -A` away from being committed.
	DEST="${OUT_FILE:-${TMPDIR:-/tmp}/__PROJECT_SLUG__-database-url.$ENVIRONMENT}"
	install -m 600 /dev/null "$DEST"
	cat "$URL_FILE" > "$DEST"
	echo ""
	echo "Connection string written to $DEST (mode 600, outside the repository)."
	echo ""
	echo "Next: set it as DATABASE_URL in the secret's flat JSON — either paste it,"
	echo "or re-run with --merge-into <downloaded-secret.json> to have it inserted"
	echo "without the value passing through your clipboard or scrollback."
	echo "Delete $DEST when finished."
	if [ -n "$OUT_FILE" ] && [ "${OUT_FILE#$REPO_ROOT}" != "$OUT_FILE" ]; then
		echo ""
		echo "WARNING: $OUT_FILE is inside the repository and contains a password."
		echo "         Confirm it is ignored before running any git add."
	fi
	exit 0
fi

# ---------------------------------------------------------------- repair mode
SECRET_ID="${1:-}"
[ -n "$SECRET_ID" ] || { echo "repair needs a secret id" >&2; exit 2; }
shift || true

KEY="DATABASE_URL"
APPLY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--apply) APPLY=1 ;;
		--key) KEY="${2:?--key needs a value}"; shift ;;
		*) echo "unknown argument for repair: $1" >&2; exit 2 ;;
	esac
	shift
done

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }

umask 077
BEFORE="$(mktemp "${TMPDIR:-/tmp}/secret-before.XXXXXX")"
AFTER="$(mktemp "${TMPDIR:-/tmp}/secret-after.XXXXXX")"
cleanup_repair() { rm -f "$BEFORE" "$AFTER"; }
trap cleanup_repair EXIT

echo "Reading $SECRET_ID ..."
if ! aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
	--query SecretString --output text > "$BEFORE" 2>/dev/null; then
	echo "Could not read $SECRET_ID. This identity may lack secretsmanager:GetSecretValue on it." >&2
	echo "Use the build subcommand instead — it needs no read access." >&2
	exit 1
fi
[ -s "$BEFORE" ] || { echo "Secret read returned nothing." >&2; exit 1; }

set +e
SECRET_KEY="$KEY" BEFORE_FILE="$BEFORE" AFTER_FILE="$AFTER" REPO_ROOT="$REPO_ROOT" \
	node "$NODE_LIB" repair
STATUS=$?
set -e

case "$STATUS" in
	3) echo ""; echo "No change needed."; exit 0 ;;
	0) : ;;
	*) echo ""; echo "Aborted without writing." >&2; exit "$STATUS" ;;
esac

if [ "$APPLY" -ne 1 ]; then
	echo ""
	echo "Dry run — nothing written. Re-run with --apply to update the secret."
	exit 0
fi

echo ""
echo "Writing new version of $SECRET_ID ..."
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" \
	--secret-string "file://$AFTER" \
	--query '{VersionId:VersionId,Stages:VersionStages}' --output json

cat <<'NOTE'

Done. ECS resolves secrets at task start, so running tasks keep the old value
until they are replaced. Redeploy the services that read this key.
NOTE
