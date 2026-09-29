#!/usr/bin/env bash
# Restore drill. Runs inside a throwaway container of the backup image
# (postgres:17 based), started on the VM by /opt/sds/run-restore-drill.sh:
#   1. reads the age PRIVATE key from stdin (never written to disk, never logged)
#   2. downloads the newest dump (or the object given as $1)
#   3. decrypts it, starts a private Postgres 17 inside this container,
#      restores, runs sanity queries, and compares with production
#   4. the container is removed by `--rm` when this exits
# Exit 0 = DRILL PASSED.
set -euo pipefail
export LC_ALL=C   # sort and join must agree on collation

LOG_TAG=drill
# shellcheck source=lib.sh
. /usr/local/lib/sds-backup/lib.sh

work=/tmp/drill
sock="$work/sock"
pgdata="$work/data"
cleanup() {
  if [[ -f "$pgdata/postmaster.pid" ]]; then
    pg_ctl -D "$pgdata" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
rm -rf "$work"
mkdir -p "$sock" && chmod 700 "$work"

# --- 1. age private key from stdin -----------------------------------------
key=""
if [[ -t 0 ]]; then
  printf 'Paste the AGE-SECRET-KEY-1... line and press Enter (input is hidden): ' >&2
  IFS= read -rs key
  printf '\n' >&2
else
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in AGE-SECRET-KEY-1*) key="$line"; break ;; esac
  done
fi
key="${key//[[:space:]]/}"
if [[ "$key" != AGE-SECRET-KEY-1* ]]; then
  log "no AGE-SECRET-KEY-1 line on stdin"; exit 2
fi

# --- 2. pick the dump --------------------------------------------------------
object="${1:-}"
if [[ -z "$object" ]]; then
  # Newest by the UTC timestamp in the file name, across all prefixes.
  object="$(rclone lsf -R --files-only "$REMOTE" \
    | { grep -E "(^|/)${OBJECT_RE}" || true; } \
    | awk -F/ '{ print $NF "\t" $0 }' | sort | tail -n 1 | cut -f 2)"
fi
[[ -n "$object" ]] || { log "no backups found in $REMOTE"; exit 1; }
log "object: $object"
rclone copyto "$REMOTE/$object" "$work/dump.age"

# Process substitution feeds the key through a pipe (/dev/fd), not a file.
age --decrypt --identity <(printf '%s\n' "$key") --output "$work/dump" "$work/dump.age"
key=""
rm -f "$work/dump.age"
log "decrypted OK ($(stat -c %s "$work/dump") bytes)"

# --- 3. throwaway Postgres 17 inside this container ------------------------
initdb -D "$pgdata" -U postgres --auth=trust --encoding=UTF8 --no-locale >/dev/null
pg_ctl -D "$pgdata" -w -l "$work/pg.log" \
  -o "-c listen_addresses='' -c unix_socket_directories=$sock -c shared_buffers=16MB -c max_connections=10 -c fsync=off" \
  start >/dev/null
local_psql() { psql -h "$sock" -U postgres -d drill -X -v ON_ERROR_STOP=1 "$@"; }
psql -h "$sock" -U postgres -d postgres -X -q -c 'create database drill'
# Supabase roles that policies/grants may name; --no-owner/--no-privileges
# drops most references, policies can still mention them.
# If the archive creates schema public itself, drop the empty default one so
# --exit-on-error does not trip on "schema public already exists".
if pg_restore -l "$work/dump" | grep -qE ' SCHEMA - public '; then
  local_psql -q -c 'drop schema public cascade'
fi
local_psql -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
SQL
pg_restore --no-owner --no-privileges --exit-on-error -h "$sock" -U postgres -d drill "$work/dump"
rm -f "$work/dump"
log "pg_restore finished without errors"

# --- 4. sanity queries -------------------------------------------------------
counts_sql="select table_schema || '.' || table_name as tbl,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
from information_schema.tables
where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE'
order by 1"
mig_sql="select count(*) from drizzle.__drizzle_migrations"

restored_counts="$(local_psql -At -F ' ' -c "$counts_sql")"
restored_mig="$(local_psql -At -c "$mig_sql" 2>/dev/null || echo missing)"
prod_counts="$(psql "$DATABASE_URL" -X -At -F ' ' -c "$counts_sql" 2>/dev/null || echo unavailable)"
prod_mig="$(psql "$DATABASE_URL" -X -At -c "$mig_sql" 2>/dev/null || echo unavailable)"

echo
echo "== Restored vs production (production is live, so later rows are normal) =="
join -a1 -a2 -e '-' -o '0,1.2,2.2' <(echo "$restored_counts" | sort) <(echo "$prod_counts" | sort) \
  | awk 'BEGIN { printf "%-40s %12s %12s\n", "table", "restored", "prod" }
         { printf "%-40s %12s %12s\n", $1, $2, $3 }'
echo
echo "drizzle migrations: restored=$restored_mig prod=$prod_mig"

status=PASSED
if [[ "$restored_mig" == "missing" ]]; then
  log "drizzle.__drizzle_migrations missing in the restore"; status=FAILED
elif [[ "$prod_mig" != "unavailable" && "$restored_mig" != "$prod_mig" ]]; then
  log "migration count differs (a migration after this dump is fine; otherwise investigate)"
  status=CHECK
fi
restored_tables="$(echo "$restored_counts" | awk '{ print $1 }' | sort)"
prod_tables="$(echo "$prod_counts" | awk '{ print $1 }' | sort)"
if [[ "$prod_counts" != "unavailable" && "$restored_tables" != "$prod_tables" ]]; then
  log "table list differs from production"
  if [[ "$status" == PASSED ]]; then status=CHECK; fi
fi

echo
echo "DRILL $status · object=$object · $(date '+%F %T %Z')"
[[ "$status" != FAILED ]]
