#!/usr/bin/env bash
# Shared helpers for backup, scheduler and restore-drill. Sourced, not run.
# Configures rclone for OCI Object Storage (S3-compatible, path-style) from env.

: "${OCI_S3_NAMESPACE:?OCI_S3_NAMESPACE is not set}"
: "${OCI_S3_BUCKET:?OCI_S3_BUCKET is not set}"
: "${OCI_S3_ACCESS_KEY_ID:?OCI_S3_ACCESS_KEY_ID is not set}"
: "${OCI_S3_SECRET_ACCESS_KEY:?OCI_S3_SECRET_ACCESS_KEY is not set}"
OCI_S3_REGION="${OCI_S3_REGION:-ap-singapore-1}"

export RCLONE_CONFIG_OCI_TYPE=s3
export RCLONE_CONFIG_OCI_PROVIDER=Other
export RCLONE_CONFIG_OCI_ENDPOINT="https://${OCI_S3_NAMESPACE}.compat.objectstorage.${OCI_S3_REGION}.oraclecloud.com"
export RCLONE_CONFIG_OCI_REGION="${OCI_S3_REGION}"
export RCLONE_CONFIG_OCI_ACCESS_KEY_ID="${OCI_S3_ACCESS_KEY_ID}"
export RCLONE_CONFIG_OCI_SECRET_ACCESS_KEY="${OCI_S3_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_OCI_FORCE_PATH_STYLE=true
export RCLONE_CONFIG_OCI_NO_CHECK_BUCKET=true

REMOTE="oci:${OCI_S3_BUCKET}"
export REMOTE

# Object names: sds-<UTC yyyymmddThhmmssZ>-<kind>.dump.age
OBJECT_RE='sds-[0-9]{8}T[0-9]{6}Z-[a-z]+\.dump\.age$'
export OBJECT_RE

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_TAG:-backup}" "$*"; }

# healthchecks.io ping; never fails the caller. $1 = "" | start | fail
hc_ping() {
  [[ -n "${HC_PING_URL:-}" ]] || return 0
  local url="${HC_PING_URL%/}"
  [[ -n "${1:-}" ]] && url="${url}/$1"
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "$url" || log "WARN: healthchecks ping failed ($url)"
}
