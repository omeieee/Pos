# Backup image for the SDS POS (runs on the VM as the `backup` service).
# Built in GitHub Actions (deploy-api.yml), never on the VM.
# postgres:17 gives the pg_dump/pg_restore 17 client (>= Supabase 17.x) and a
# server binary for the restore drill; age encrypts; rclone talks to OCI's
# S3-compatible endpoint.
FROM postgres:17-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends age rclone curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 lib.sh           /usr/local/lib/sds-backup/lib.sh
COPY --chmod=0755 backup.sh        /usr/local/bin/backup
COPY --chmod=0755 scheduler.sh     /usr/local/bin/scheduler
COPY --chmod=0755 restore-drill.sh /usr/local/bin/restore-drill
COPY --chmod=0755 healthcheck.sh   /usr/local/bin/healthcheck
COPY --chmod=0755 list.sh          /usr/local/bin/backup-list

ENV TZ=Asia/Bangkok \
    PGCONNECT_TIMEOUT=20 \
    PGSSLMODE=require \
    RCLONE_CONFIG=/tmp/rclone.conf

# Unprivileged; also required by initdb in the restore drill.
USER postgres
WORKDIR /tmp

# Replace the postgres server entrypoint: this image is a job runner.
ENTRYPOINT []
CMD ["/usr/local/bin/scheduler"]
