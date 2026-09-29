#!/usr/bin/env bash
# Restore drill, run ON the VM by the owner (as ubuntu, via sudo -u deploy):
#   sudo -u deploy /opt/sds/run-restore-drill.sh            # paste the key when asked
#   sudo -u deploy /opt/sds/run-restore-drill.sh daily/sds-...dump.age
#   (or pipe it from the laptop, never storing it on the VM)
#   ssh pos-ts 'sudo -u deploy /opt/sds/run-restore-drill.sh' < /path/on/usb/sds-backup.agekey
# The age private key goes through stdin into a throwaway container (--rm) and
# is never stored at rest on the VM: it lives only in that process's memory.
# The `drill` compose service keeps the decrypted dump and the throwaway
# PGDATA on a tmpfs (RAM), not on disk. See infra/RUNBOOK.md "Restore".
set -euo pipefail
cd "$(dirname "$0")"
flags=()
[[ -t 0 ]] || flags+=(-T)
exec docker compose --env-file .env --env-file .deploy-state --profile tools \
  run --rm --no-deps "${flags[@]}" drill restore-drill "$@"
