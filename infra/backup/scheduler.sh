#!/usr/bin/env bash
# In-container scheduler (no cron daemon, no root). Times are Asia/Bangkok (TZ).
#   hourly  at hh:05 for hh = 10..23 and 00 (opening hours, 10:00-24:00)
#   nightly at 05:05 (after the Monday 03:00-05:00 reboot window)
# healthchecks.io check to match: cron "5 0,5,10-23 * * *", tz Asia/Bangkok,
# grace 30 min.
set -euo pipefail

LOG_TAG=scheduler
# shellcheck source=lib.sh
. /usr/local/lib/sds-backup/lib.sh

log "started; TZ=${TZ:-unset}; now $(date '+%F %T %Z')"
last_run=""
while true; do
  touch /tmp/heartbeat
  hm="$(date +%H:%M)"
  kind=""
  case "$hm" in
    00:05|1[0-9]:05|2[0-3]:05) kind=hourly ;;
    05:05) kind=nightly ;;
  esac
  slot="$(date +%F-%H)"
  if [[ -n "$kind" && "$slot" != "$last_run" ]]; then
    last_run="$slot"
    /usr/local/bin/backup "$kind" || log "backup $kind failed (see above); will retry next slot"
  fi
  sleep 20
done
