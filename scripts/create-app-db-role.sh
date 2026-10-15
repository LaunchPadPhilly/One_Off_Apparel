#!/usr/bin/env bash
# Give the app its own database login, so RDS's automatic rotation of the master
# password stops breaking the app. Run once per environment.
#
#   scripts/create-app-db-role.sh --env uat
#   scripts/create-app-db-role.sh --env production
#
# Why: the RDS-managed master password (manage_master_user_password) is rotated by
# Secrets Manager every 7 days. A DATABASE_URL copied from it breaks on the next
# rotation (Postgres 28P01, every DB call 500s). After this script the app logs in
# as its own role (default `<slug>_app`) whose password only changes when someone
# re-runs this script. The master login keeps rotating and is used for nothing day
# to day; it stays a member of the app role, so it can still manage everything.
#
# What it does, stopping at the first failure:
#   1. Generates a random password locally (0600 temp file, never printed, never sent
#      to AWS in clear — only its SCRAM-SHA-256 verifier goes into the one-off task).
#   2. One-off ECS task, connected with the CURRENT DATABASE_URL (the master login):
#      creates or re-passwords the role, grants it CONNECT and USAGE+CREATE on schema
#      public, and makes it the owner of every table, view, sequence and enum type in
#      public — so `prisma migrate deploy` can keep altering them as this role.
#   3. Builds the new DATABASE_URL (same host, port and database) and writes it into
#      the app secret, every other key untouched.
#   4. One-off task as the NEW role: checks it owns everything and can create objects,
#      then runs `prisma migrate deploy`. If either fails, the previous secret value is
#      put back and the script exits non-zero.
#   5. Force-redeploys web and mcp and waits for both to be stable.
#
# Re-running while the app already uses the role is refused (there is nothing to move);
# to change that role's password, run with --rotate.
#
# Needs: aws CLI with a profile that can run ECS tasks and read/write the app secret
# (AWS_PROFILE), node, jq. Works in Git Bash on Windows.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_LIB="$REPO_ROOT/scripts/lib/database-url.mjs"

ENVIRONMENT=""
SLUG="ooa"
ROLE=""
ROTATE=0
while [ $# -gt 0 ]; do
	case "$1" in
		--env) ENVIRONMENT="${2:?--env needs uat or production}"; shift ;;
		--slug) SLUG="${2:?--slug needs a value}"; shift ;;
		--role) ROLE="${2:?--role needs a value}"; shift ;;
		--rotate) ROTATE=1 ;;
		-h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done
ROLE="${ROLE:-${SLUG}_app}"
[[ "$ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "role must match ^[a-z_][a-z0-9_]*$" >&2; exit 2; }

case "$ENVIRONMENT" in
	uat) PREFIX="$SLUG-uat"; SECRET_ID="uat/$SLUG/app" ;;
	production) PREFIX="$SLUG"; SECRET_ID="prod/$SLUG/app" ;;
	*) echo "--env must be uat or production" >&2; exit 2 ;;
esac
CLUSTER="$PREFIX-cluster"
WEB="$PREFIX-web"
MCP="$PREFIX-mcp"
LOG_GROUP="/ecs/$PREFIX-web"

for c in aws node jq; do command -v "$c" >/dev/null || { echo "$c not found" >&2; exit 1; }; done
# Git Bash: aws.exe and node.exe need Windows paths for files they open.
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OLD="$WORK/old.json"; NEW="$WORK/new.json"; PW="$WORK/pw"; URL="$WORK/url"

echo "Environment $ENVIRONMENT: cluster $CLUSTER, secret $SECRET_ID, app role \"$ROLE\""

# -------------------------------------------------- current secret and endpoint
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text > "$OLD"
CURRENT="$(OLD="$(winpath "$OLD")" node -e '
	const u = new URL(JSON.parse(require("fs").readFileSync(process.env.OLD, "utf8")).DATABASE_URL);
	console.log([decodeURIComponent(u.username), u.host, u.pathname.slice(1)].join(" "));
')"
read -r CURRENT_USER DB_ENDPOINT DB_NAME <<<"$CURRENT"
echo "Current DATABASE_URL logs in as \"$CURRENT_USER\" to $DB_ENDPOINT/$DB_NAME"
if [ "$CURRENT_USER" = "$ROLE" ] && [ "$ROTATE" -eq 0 ]; then
	echo "The app already uses \"$ROLE\". Nothing to do (pass --rotate to give it a new password)." >&2
	exit 1
fi

# -------------------------------------------------- password and SCRAM verifier
VERIFIER="$(PW="$(winpath "$PW")" node -e '
	const c = require("crypto");
	const pw = c.randomBytes(32).toString("hex");
	require("fs").writeFileSync(process.env.PW, pw, { mode: 0o600 });
	const salt = c.randomBytes(16), iter = 4096;
	const salted = c.pbkdf2Sync(pw, salt, iter, 32, "sha256");
	const hmac = (k, s) => c.createHmac("sha256", k).update(s).digest();
	const stored = c.createHash("sha256").update(hmac(salted, "Client Key")).digest();
	const server = hmac(salted, "Server Key");
	const b = (x) => x.toString("base64");
	console.log(`SCRAM-SHA-256$${iter}:${b(salt)}$${b(stored)}:${b(server)}`);
')"

# -------------------------------------------------- one-off task helper
TASK_DEF="$(aws ecs describe-services --cluster "$CLUSTER" --services "$WEB" --query 'services[0].taskDefinition' --output text)"
NET="$(aws ecs describe-services --cluster "$CLUSTER" --services "$WEB" --query 'services[0].networkConfiguration' --output json)"

# Runs SQL from $SQL_B64 with the task's DATABASE_URL and prints the last result's rows.
# With CHECK_ROLE set, fails unless that role is connected, owns everything in public
# and can create objects there.
RUNNER='const pg=require("pg");const u=process.env.DATABASE_URL;const rds=u.includes("amazonaws.com");
const c=new pg.Client({connectionString:rds?u.replace(/([?&])sslmode=[^&]*&?/g,"$1").replace(/[?&]$/,""):u,ssl:rds?{rejectUnauthorized:false}:undefined});
(async()=>{await c.connect();let r=await c.query(Buffer.from(process.env.SQL_B64,"base64").toString());r=Array.isArray(r)?r[r.length-1]:r;
const row=r.rows[0]||{};console.log("RESULT "+JSON.stringify(row));const want=process.env.CHECK_ROLE;
if(want&&!(row.role===want&&row.not_owned===0&&row.can_create===true)){console.error("CHECK FAILED");process.exit(1)}await c.end()})()
.catch(e=>{console.error("FAILED "+(e.code||"")+" "+e.message);process.exit(1)})'

run_task() { # <label> <overrides-json>
	local arn id code
	arn="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASK_DEF" --launch-type FARGATE \
		--network-configuration "$NET" --overrides "$2" --query 'tasks[0].taskArn' --output text)"
	id="${arn##*/}"
	echo "  $1: task $id running ..."
	aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$arn"
	code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)"
	sleep 5 # let the last log lines land
	MSYS_NO_PATHCONV=1 aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "web/web/$id" \
		--query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' | tail -8 | sed 's/^/    /' || true
	echo "  $1: exit=$code"
	[ "$code" = "0" ]
}
sql_overrides() { # <sql> [check-role]
	jq -cn --arg js "$RUNNER" --arg sql "$(printf '%s' "$1" | base64 | tr -d '\n')" --arg check "${2:-}" \
		'{containerOverrides:[{name:"web",command:["node","-e",$js],
		  environment:([{name:"SQL_B64",value:$sql}] + (if $check=="" then [] else [{name:"CHECK_ROLE",value:$check}] end))}]}'
}

# -------------------------------------------------- 1. create the role (as the master login)
SETUP_SQL="DO \$do\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROLE') THEN
    CREATE ROLE $ROLE LOGIN PASSWORD '$VERIFIER';
  ELSE
    ALTER ROLE $ROLE WITH LOGIN PASSWORD '$VERIFIER';
  END IF;
  -- Postgres 16 gives the creator only ADMIN on a new role; ALTER ... OWNER TO needs SET.
  EXECUTE format('GRANT $ROLE TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO $ROLE', current_database());
END \$do\$;
GRANT USAGE, CREATE ON SCHEMA public TO $ROLE;
DO \$do\$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f') AND pg_get_userbyid(c.relowner) <> '$ROLE' LOOP
    EXECUTE format(CASE r.relkind WHEN 'v' THEN 'ALTER VIEW public.%I OWNER TO $ROLE'
      WHEN 'm' THEN 'ALTER MATERIALIZED VIEW public.%I OWNER TO $ROLE'
      WHEN 'f' THEN 'ALTER FOREIGN TABLE public.%I OWNER TO $ROLE'
      ELSE 'ALTER TABLE public.%I OWNER TO $ROLE' END, r.relname);
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) <> '$ROLE'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a','i')) LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO $ROLE', r.relname);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e','d') AND pg_get_userbyid(t.typowner) <> '$ROLE' LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO $ROLE', r.typname);
  END LOOP;
END \$do\$;
SELECT '$ROLE' AS role, count(*)::int AS tables_owned FROM pg_tables WHERE schemaname = 'public' AND tableowner = '$ROLE';"

echo "1/4 Creating \"$ROLE\" and handing it the app's tables (as \"$CURRENT_USER\")"
run_task setup "$(sql_overrides "$SETUP_SQL")"

# -------------------------------------------------- 2. switch the secret
echo "2/4 Writing the new DATABASE_URL into $SECRET_ID"
cp "$OLD" "$NEW"
BUILD_MODE=raw-password PW_FILE="$(winpath "$PW")" URL_FILE="$(winpath "$URL")" DB_USER="$ROLE" \
	DB_ENDPOINT="$DB_ENDPOINT" DB_NAME="$DB_NAME" REPO_ROOT="$(winpath "$REPO_ROOT")" \
	node "$(winpath "$NODE_LIB")" build | sed '/^$/d; s/^/  /'
URL_FILE="$(winpath "$URL")" MERGE_INTO="$(winpath "$NEW")" REPO_ROOT="$(winpath "$REPO_ROOT")" \
	node "$(winpath "$NODE_LIB")" merge | sed 's/^ */  /'
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$(winpath "$NEW")" --query VersionStages --output text >/dev/null

restore() {
	echo "Putting the previous DATABASE_URL back." >&2
	aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$(winpath "$OLD")" --query VersionStages --output text >/dev/null
	echo "Restored. The running services were never restarted, so nothing changed for users." >&2
	exit 1
}

# -------------------------------------------------- 3. prove the new login works
CHECK_SQL="SELECT current_user::text AS role,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S') AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user))::int AS not_owned,
  has_schema_privilege('public', 'CREATE') AS can_create,
  (SELECT count(*) FROM \"_prisma_migrations\")::int AS migrations_applied;"
echo "3/4 Checking the new login, then running prisma migrate deploy as \"$ROLE\""
run_task check "$(sql_overrides "$CHECK_SQL" "$ROLE")" || restore
run_task migrate '{"containerOverrides":[{"name":"web","command":["node_modules/.bin/prisma","migrate","deploy"]}]}' || restore

# -------------------------------------------------- 4. roll the services
echo "4/4 Restarting $WEB and $MCP so they pick up the new secret"
for s in "$WEB" "$MCP"; do
	aws ecs update-service --cluster "$CLUSTER" --service "$s" --force-new-deployment --query 'service.serviceName' --output text | sed 's/^/  /'
done
aws ecs wait services-stable --cluster "$CLUSTER" --services "$WEB" "$MCP"
echo "STABLE. The app now logs in as \"$ROLE\"; master-password rotation no longer affects it."
