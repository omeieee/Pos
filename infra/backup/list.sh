#!/usr/bin/env bash
# List backup objects in the bucket (size, time, path). Usage: backup-list [prefix]
set -euo pipefail
LOG_TAG=list
# shellcheck source=lib.sh
. /usr/local/lib/sds-backup/lib.sh
rclone lsl "$REMOTE/${1:-}"
