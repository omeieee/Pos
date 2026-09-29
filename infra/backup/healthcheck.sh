#!/usr/bin/env bash
# Docker healthcheck for the backup service: the scheduler loop is alive.
# The loop is single-threaded: while one backup runs (retries, slow network) it
# does not touch the heartbeat. 30 min (= the healthchecks.io grace time) keeps a
# slow but healthy run from turning the container unhealthy, which would fail
# `up --wait` during a deploy; a truly hung run still shows up here and, as a
# missed ping, at healthchecks.io.
set -euo pipefail
beat=$(stat -c %Y /tmp/heartbeat)
(( $(date +%s) - beat < 1800 ))
