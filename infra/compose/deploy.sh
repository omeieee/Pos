#!/usr/bin/env bash
# Deploy/rollback on the VM. Lives at /opt/sds/deploy.sh; runs as `deploy`.
# Called by .github/workflows/deploy-api.yml over Tailscale SSH, or by hand:
#   ./deploy.sh apply <api_image> <backup_image>   # pull, backup, migrate, up
#     exit 10 = it failed AFTER switching the new image in and before the new
#     API was verified healthy (a rollback is wanted); any other non-zero exit
#     = it failed before anything changed, or after the API was verified
#     (never roll back then: the running version is untouched or healthy,
#     even when the same image was redeployed).
#   ./deploy.sh rollback [<only_if_current>]       # API back to PREVIOUS_API_IMAGE
#     (CI passes the image it just tried, as a second guard)
#   ./deploy.sh status
# The registry login is done by the caller before `apply` (the VM keeps no
# registry credentials).
#
# State file /opt/sds/.deploy-state (compose env file):
#   API_IMAGE, PREVIOUS_API_IMAGE, BACKUP_IMAGE, GIT_SHA
set -euo pipefail
cd "$(dirname "$0")"

STATE=.deploy-state
CADDY_HASH_FILE=.caddyfile.sha256   # hash of the Caddyfile the running caddy loaded
SWITCHED=0   # 1 from the moment cmd_apply points .deploy-state at the new image until it is verified healthy
on_exit() {
  local rc=$?
  rm -f "$STATE.new"
  if (( rc != 0 && SWITCHED == 1 )); then exit 10; fi
}
trap on_exit EXIT
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

caddy_hash() { sha256sum Caddyfile | cut -d' ' -f1; }

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
  local cur_api prev first_deploy=0 caddy_new=0
  [[ -f "$STATE" ]] || first_deploy=1
  cur_api="$(state_get API_IMAGE)"
  prev="${cur_api:-$new_api}"
  if [[ "$cur_api" == "$new_api" ]]; then prev="$(state_get PREVIOUS_API_IMAGE)"; fi
  prev="${prev:-$new_api}"

  log "pull $new_api and $new_backup"
  docker pull -q "$new_api"
  docker pull -q "$new_backup"

  # Backup right before migrations (rule: backup before any deploy that may
  # migrate). Skipped ONLY on a true first deploy (no $STATE yet: nothing has
  # ever been deployed, so there is nothing to back up). Otherwise it is
  # mandatory: use the running backup service, or start a one-shot container
  # of the current backup image when the service is down. If it fails, the
  # deploy stops here, before migrations.
  if [[ ! -f "$STATE" ]]; then
    log "pre-deploy backup SKIPPED (first deploy: no $STATE yet, nothing to back up)"
  else
    log "pre-deploy backup"
    if [[ -n "$(dc_with "$STATE" ps -q --status running backup 2>/dev/null)" ]]; then
      dc_with "$STATE" exec -T backup backup predeploy \
        || die "pre-deploy backup failed; deploy stopped before migrations"
    else
      log "backup service is not running: running a one-shot backup container"
      dc_with "$STATE" run --rm --no-deps -T backup backup predeploy \
        || die "pre-deploy backup failed (one-shot); deploy stopped before migrations"
    fi
  fi

  write_state "$STATE.new" "$new_api" "$prev" "$new_backup"

  # The Caddyfile is bind-mounted as a single file and the bundle is extracted
  # over it (a new inode), so a running caddy never sees the change and
  # `up -d` does not recreate it. Validate a changed Caddyfile in a fresh
  # container (fresh mount, this Caddy version) before anything is switched,
  # and restart caddy after `up`.
  if [[ "$(caddy_hash)" != "$(cat "$CADDY_HASH_FILE" 2>/dev/null || true)" ]]; then
    caddy_new=1
    log "Caddyfile changed: validating it"
    dc_with "$STATE.new" run --rm --no-deps -T caddy \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
      || die "Caddyfile is not valid for this Caddy version; deploy stopped before migrations"
  fi

  log "migrations"
  # Same V8 heap cap as the api image's CMD (apps/api/Dockerfile): 1 GB VM.
  dc_with "$STATE.new" run --rm --no-deps -T -e NODE_OPTIONS=--max-old-space-size=384 \
    api node dist/migrate.js

  mv "$STATE.new" "$STATE"
  SWITCHED=1
  log "up"
  dc_with "$STATE" up -d --remove-orphans --wait --wait-timeout 180
  verify_running "$new_api"
  # The real network path (caddy -> api:3000), not just the in-container check.
  dc_with "$STATE" exec -T caddy wget -q -O /dev/null http://api:3000/healthz \
    || die "caddy cannot reach api:3000/healthz (API bound to 127.0.0.1?)"
  # The new API is verified healthy: from here on a failure is not fixed by
  # rolling the API back, so it must not exit 10.
  SWITCHED=0
  if (( caddy_new )); then
    if (( ! first_deploy )); then
      log "restarting caddy to load the new Caddyfile"
      dc_with "$STATE" restart caddy \
        || die "caddy restart failed (API is healthy on $new_api)"
      dc_with "$STATE" up -d --no-deps --wait --wait-timeout 60 caddy \
        || die "caddy is not healthy after the restart (API is healthy on $new_api)"
    fi
    caddy_hash > "$CADDY_HASH_FILE"
  fi
  prune_images || log "WARN: image prune failed (harmless, retried next deploy)"
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
