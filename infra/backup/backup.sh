#!/usr/bin/env bash
# One backup run: pg_dump (public + drizzle) | age (public recipient) -> OCI.
#   backup hourly     -> hourly/
#   backup nightly    -> daily/  (+ monthly/ on the 1st, Asia/Bangkok)
#   backup predeploy  -> predeploy/  (called by deploy.sh before migrations)
# Prunes each prefix by age after a successful upload. Pings healthchecks.io
# (start / success / fail) for the scheduled kinds only.
set -euo pipefail

# shellcheck source=lib.sh
. /usr/local/lib/sds-backup/lib.sh
: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT is not set (age1... public key)}"

kind="${1:-}"
case "$kind" in
  hourly)    prefixes=(hourly) ;;
  nightly)
    prefixes=(daily)
    if [[ "$(date +%d)" == "01" ]]; then prefixes+=(monthly); fi
    ;;
  predeploy) prefixes=(predeploy) ;;
  *) echo "usage: backup hourly|nightly|predeploy" >&2; exit 2 ;;
esac
LOG_TAG="backup:$kind"

ping() { [[ "$kind" == "predeploy" ]] || hc_ping "$@"; }

workdir="$(mktemp -d)"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT
on_err() {
  local rc=$?
  log "FAILED (exit $rc)"
  ping fail "backup $kind failed with exit $rc on $(hostname)"
  exit "$rc"
}
trap on_err ERR

ping start
started=$(date +%s)
name="sds-$(date -u +%Y%m%dT%H%M%SZ)-${kind}.dump.age"
file="$workdir/$name"

log "dumping to $name"
# The plaintext dump only ever exists in the pipe; only ciphertext touches disk.
pg_dump --dbname="$DATABASE_URL" -Fc --schema=public --schema=drizzle \
  --no-owner --no-privileges \
  | age --encrypt --recipient "$AGE_RECIPIENT" --output "$file"

size=$(stat -c %s "$file")
if (( size < 200 )); then
  log "dump is suspiciously small ($size bytes)"
  false
fi

for p in "${prefixes[@]}"; do
  rclone copyto --retries 3 "$file" "$REMOTE/$p/$name"
  log "uploaded $p/$name ($size bytes)"
done

# Retention, by prefix (no OCI lifecycle policy needed). Only after success,
# so a broken backup run never deletes older good dumps.
rclone delete --min-age 48h  "$REMOTE/hourly/"    || log "WARN: prune hourly failed"
rclone delete --min-age 31d  "$REMOTE/daily/"     || log "WARN: prune daily failed"
rclone delete --min-age 370d "$REMOTE/monthly/"   || log "WARN: prune monthly failed"
rclone delete --min-age 14d  "$REMOTE/predeploy/" || log "WARN: prune predeploy failed"

elapsed=$(( $(date +%s) - started ))
log "OK in ${elapsed}s"
ping "" "backup $kind ok: ${prefixes[*]}/$name ${size}B ${elapsed}s"
