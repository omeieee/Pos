#!/usr/bin/env bash
# Docker healthcheck for the backup service: the scheduler loop is alive.
set -euo pipefail
beat=$(stat -c %Y /tmp/heartbeat)
(( $(date +%s) - beat < 300 ))
