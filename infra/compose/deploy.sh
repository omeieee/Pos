#!/usr/bin/env bash
# Deploy/rollback on the VM. Lives at /opt/sds/deploy.sh; runs as `deploy`.
# Called by .github/workflows/deploy-api.yml over Tailscale SSH, or by hand:
#   ./deploy.sh apply <api_image> <backup_image>   # pull, backup, migrate, up
#   ./deploy.sh rollback [<only_if_current>]       # API back to PREVIOUS_API_IMAGE
#     (CI passes the image it just tried, so a deploy that failed before it
#      switched anything never rolls back the good running version)
#   ./deploy.sh status
# The registry login is done by the caller before `apply` (the VM keeps no
# registry credentials).
#
# State file /opt/sds/.deploy-state (compose env file):
#   API_IMAGE, PREVIOUS_API_IMAGE, BACKUP_IMAGE, GIT_SHA
set -euo pipefail
cd "$(dirname "$0")"

STATE=.deploy-state
trap 'rm -f "$STATE.new"' EXIT
log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

state_get() { # $1 = key; prints value or empty
  [[ -f "$STATE" ]] || return 0
  sed -n "s/^$1=//p" "$STATE" | tail -n 1
}

write_state() { # $1 file, $2 api, $3 previous, $4 backup
  umask 077
  cat > "$1" <<EOF
API_IMAGE=$2
PREVIOUS_API_IMAGE=$3
BACKUP_IMAGE=$4
GIT_SHA=${2##*:}
EOF
}

dc_with() { # $1 = state file, rest = compose args
  local st="$1"; shift
  docker compose --env-file .env --env-file "$st" "$@"
}

check_env() {
  [[ -f .env ]] || die "/opt/sds/.env is missing - create it from .env.example (infra/SETUP.md)"
  local mode
  mode=$(stat -c %a .env)
  [[ "$mode" == "600" ]] || die ".env mode is $mode, expected 600 (chmod 600 /opt/sds/.env)"
}

verify_running() { # $1 = expected api image
  local cid img health
  cid="$(dc_with "$STATE" ps -q api)"
  [[ -n "$cid" ]] || die "api container not running"
  img="$(docker inspect --format '{{.Config.Image}}' "$cid")"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$cid")"
  log "api running $img ($health)"
  [[ "$img" == "$1" ]] || die "api runs $img, expected $1"
  [[ "$health" == "healthy" ]] || die "api is $health"
}

prune_images() { # keep current + previous API, current backup
  local keep img
  keep=" $(state_get API_IMAGE) $(state_get PREVIOUS_API_IMAGE) $(state_get BACKUP_IMAGE) "
  while read -r img; do
    if [[ "$keep" == *" $img "* ]]; then continue; fi
    if docker rmi "$img" >/dev/null 2>&1; then log "removed old image $img"; fi
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^ghcr\.io/[^/]+/pos-(api|backup):' || true)
  docker image prune -f >/dev/null
}

cmd_apply() {
  local new_api="${1:-}" new_backup="${2:-}"
  [[ -n "$new_api" && -n "$new_backup" ]] || die "usage: deploy.sh apply <api_image> <backup_image>"
  check_env
  local cur_api prev
  cur_api="$(state_get API_IMAGE)"
  prev="${cur_api:-$new_api}"
  if [[ "$cur_api" == "$new_api" ]]; then prev="$(state_get PREVIOUS_API_IMAGE)"; fi
  prev="${prev:-$new_api}"

  log "pull $new_api and $new_backup"
  docker pull -q "$new_api"
  docker pull -q "$new_backup"

  # Backup right before migrations (rule: backup before any deploy that may
  # migrate). Uses the backup container already running; skipped only on the
  # very first deploy when there is nothing to back up yet.
  if [[ -f "$STATE" ]] && [[ -n "$(dc_with "$STATE" ps -q --status running backup 2>/dev/null)" ]]; then
    log "pre-deploy backup"
    dc_with "$STATE" exec -T backup backup predeploy
  else
    log "pre-deploy backup SKIPPED (first deploy: backup service not running yet)"
  fi

  write_state "$STATE.new" "$new_api" "$prev" "$new_backup"
  log "migrations"
  dc_with "$STATE.new" run --rm --no-deps -T api node dist/migrate.js

  mv "$STATE.new" "$STATE"
  log "up"
  dc_with "$STATE" up -d --remove-orphans --wait --wait-timeout 180
  verify_running "$new_api"
  # The real network path (caddy -> api:3000), not just the in-container check.
  dc_with "$STATE" exec -T caddy wget -q -O /dev/null http://api:3000/healthz \
    || die "caddy cannot reach api:3000/healthz (API bound to 127.0.0.1?)"
  prune_images
  log "deployed $new_api (previous: $prev)"
}

cmd_rollback() {
  local only_if="${1:-}"
  check_env
  local cur prev backup
  cur="$(state_get API_IMAGE)"
  prev="$(state_get PREVIOUS_API_IMAGE)"
  backup="$(state_get BACKUP_IMAGE)"
  if [[ -n "$only_if" && "$cur" != "$only_if" ]]; then
    log "current API is $cur, not $only_if: the failed deploy never switched; nothing to roll back"
    return 0
  fi
  [[ -n "$prev" ]] || die "no PREVIOUS_API_IMAGE in $STATE"
  [[ "$prev" != "$cur" ]] || die "previous image equals current ($cur); nothing to roll back to"
  log "rollback API $cur -> $prev (migrations are NOT reverted; they are expand-only)"
  docker image inspect "$prev" >/dev/null 2>&1 || docker pull -q "$prev"
  write_state "$STATE" "$prev" "$prev" "$backup"
  dc_with "$STATE" up -d --no-deps --wait --wait-timeout 180 api
  verify_running "$prev"
  log "rolled back to $prev"
}

cmd_status() {
  if [[ ! -f "$STATE" ]]; then echo "(no $STATE yet: never deployed)"; return 0; fi
  cat "$STATE"
  dc_with "$STATE" ps
}

case "${1:-}" in
  apply)    shift; cmd_apply "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  status)   cmd_status ;;
  *) die "usage: deploy.sh apply <api_image> <backup_image> | rollback [<only_if_current>] | status" ;;
esac
