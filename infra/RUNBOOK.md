# Runbook — SDS POS production

Playbooks for when something breaks. Setup lives in [SETUP.md](SETUP.md); the design is in [docs/05-infrastructure.md](../docs/05-infrastructure.md).

## Where things are
| Thing | Where |
|---|---|
| VM | Oracle `omeie_pos`, ap-singapore-1, E2.1.Micro. Public `138.2.67.89`, tailnet name `sds-pos` |
| Admin SSH | `ssh pos-ts` (ubuntu) or `ssh deploy@sds-pos`, over Tailscale only |
| Stack | `/opt/sds` (`docker-compose.yml`, `Caddyfile`, `.env` (600, deploy), `.deploy-state`, `deploy.sh`, `dc`, `run-restore-drill.sh`) |
| Compose | **always** `/opt/sds/dc …` (it adds `.deploy-state`); e.g. `./dc ps`, `./dc logs --tail 100 api` |
| API URL | `https://138-2-67-89.sslip.io` (`/healthz` no DB, `/readyz` with DB) |
| Web apps | `https://sds-pos.pages.dev` (staff), `https://sds-order.pages.dev` (customers) |
| Database | Supabase project `yejvrooxqdpynruwnegg` (session pooler, port 5432) |
| Backups | OCI bucket `sds-backups`: `hourly/` 48 h, `daily/` 31 d, `monthly/` 370 d, `predeploy/` 14 d |
| Backup key | age private key: printed copy + USB drive at home. **Never stored at rest on the VM or the laptop.** During a restore drill it is streamed from the USB drive into a throwaway container's memory and discarded |
| Alerts | UptimeRobot (`/readyz`), healthchecks.io (`sds-backup`), Sentry → omeza25482548@gmail.com |
| Break-glass | re-add OCI ingress TCP 22 from your IP/32 → `ssh pos-oracle`; or OCI Console connection (SETUP 2.6) |

**Before any production-changing command:** say what you are about to do, and keep a note of the time. For the whole-shop view, see "Shop internet down" at the end.

---

## API down (UptimeRobot alert)
1. **Scope:**
   ```bash
   curl -sS -m 10 https://138-2-67-89.sslip.io/healthz
   curl -sS -m 10 https://138-2-67-89.sslip.io/readyz
   ```
   - `/healthz` fails → the API or Caddy is down (go to 2).
   - `/healthz` works but `/readyz` fails → the database (see "Database full or paused").
   - Nothing answers, not even TLS → the VM or network (go to 4).
2. **Containers:** `ssh deploy@sds-pos '/opt/sds/dc ps'`.
   - Look for `unhealthy` or `restarting`:
     ```bash
     ssh deploy@sds-pos '/opt/sds/dc logs --tail 200 api'
     ssh deploy@sds-pos '/opt/sds/dc logs --tail 100 caddy'
     ```
   - Check memory with `ssh pos-ts 'free -m; dmesg -T | grep -i -E "killed process|oom" | tail'`. An OOM kill means the 1 GB is exhausted; the API heap cap is 384 MB (`--max-old-space-size=384` in `apps/api/Dockerfile`; the container limit is 512 MB).
3. **Restart one service:** `ssh deploy@sds-pos '/opt/sds/dc restart api'`.
   - If it started after a deploy, see **Rollback**.
   - Caddy certificate errors in the logs: see "Certificate problems" below.
4. **VM unreachable over Tailscale:**
   - OCI console → the instance: state Running? Check the CPU graph.
   - **Reboot** from the console if it is hung.
   - If the instance is gone or **Stopped by Oracle** (idle reclamation), see "Oracle instance lost".
5. Record what happened in `docs/PROGRESS.md` (via Claude's `/checkpoint`).

### Certificate problems
- Caddy keeps certificates in the `sds_caddy_data` volume. **Never delete that volume**: re-issuing counts against ACME rate limits.
- `sslip.io` is **not** on the Public Suffix List, so Let's Encrypt's per-domain limit is shared by all sslip.io users. If issuance is rate-limited, Caddy retries with backoff and may fall back to ZeroSSL.
- If issuance keeps failing, switch the hostname to DuckDNS (on the PSL):
  1. create `<name>.duckdns.org` → 138.2.67.89;
  2. do "IP changed" steps 2–5 with the new hostname.

## Database full or paused (Supabase)
- **Paused** (free projects pause after 7 days without DB activity; the hourly backups and `/readyz` checks normally prevent this):
  1. Supabase dashboard → project → **Restore / Resume**. It takes a few minutes.
  2. Then `curl …/readyz`.
- **Full** (500 MB free):
  1. Supabase → Reports / Database size.
  2. Short term: ask Claude to run the retention cleanup (old slips/logs per [03 retention](../docs/03-data-model.md)).
  3. Don't delete business records by hand.
  4. Long term: plan a move (PAYG / Path A); that is an owner decision.
- **Connection errors** (`too many clients`, pooler auth):
  - check that `DATABASE_URL` in `/opt/sds/.env` is the **session pooler, port 5432**, and ends in **`?sslmode=require`** (Supabase "Enforce SSL" is on, SETUP 1.9);
  - if the DB password was reset in Supabase, update `.env`, then `./dc up -d api backup`.
- **Supabase outage:** status.supabase.com. Nothing to do on our side; staff take orders on paper and key them in afterwards.

## Backup missed (healthchecks.io alert)
1. `ssh deploy@sds-pos '/opt/sds/dc ps backup; /opt/sds/dc logs --tail 100 backup'`
2. Typical causes:
   | Log line | Fix |
   |---|---|
   | `pg_dump: error: connection…` | DB paused or `DATABASE_URL` wrong (see the section above) |
   | `SignatureDoesNotMatch` / `InvalidAccessKeyId` | OCI Customer Secret Key revoked or mistyped. Make a new one (SETUP 1.5), update `.env`, then `./dc up -d backup` |
   | `unhealthy`, no log lines | scheduler stuck: `./dc restart backup` |
   | nothing, container missing | `./dc up -d backup` |
3. Run one by hand to confirm: `ssh deploy@sds-pos '/opt/sds/dc exec -T backup backup hourly'`. It ends with `OK in Ns`, and the healthchecks check turns green.
4. Confirm the object: `ssh deploy@sds-pos '/opt/sds/dc exec -T backup backup-list hourly/'`.

## Restore
### Monthly drill (and after any backup change)
From the laptop, with the USB drive in (drive `E:` here):
```bash
ssh deploy@sds-pos '/opt/sds/run-restore-drill.sh' < /e/sds-backup.agekey
# or a specific object:
ssh deploy@sds-pos '/opt/sds/run-restore-drill.sh daily/sds-20261001T220500Z-nightly.dump.age' < /e/sds-backup.agekey
```
- The key travels over the tailnet into a throwaway container (`--rm`) and stays in that process's memory: it is never stored at rest on the VM.
- The container is the `drill` compose service (`run-restore-drill.sh` starts it). The decrypted dump and the throwaway Postgres live on a 256 MB RAM-backed tmpfs, not on disk. Under memory pressure the kernel may still swap those pages to the VM's swap file. The script refuses to run without the tmpfs.
- If it stops with "No space left on device", the DB has outgrown the scratch space: raise `size=` for `/tmp/drill` in `docker-compose.yml` (`drill` service), and check `free -m`.
- **Pass:**
  - `DRILL PASSED`;
  - restored tables = production tables;
  - `drizzle migrations: restored=N prod=N`;
  - row counts equal or slightly lower than prod, since prod has moved on.
- `DRILL CHECK` means a table or migration differs. That is normal right after a migration; otherwise investigate.
- `DRILL FAILED` with "restored table(s) EMPTY while production has rows" means the dump or restore lost data. One innocent cause: a table that got its first rows after that dump (for example the first order of the day). Re-run against a newer object (`daily/...` or the latest `hourly/...`) before treating it as data loss.
- Record the date, object and result in `docs/PROGRESS.md`.

### Real restore into Supabase (data loss or corruption)
**Owner decision; stop the API first so nothing writes during the restore.**
1. `ssh deploy@sds-pos '/opt/sds/dc stop api'`. Staff switch to paper.
2. On the **laptop** (not the VM), with PostgreSQL 17 client tools installed:
   1. download the object from the OCI console (bucket → object → Download);
   2. `age -d -i /e/sds-backup.agekey -o restore.dump <file>.dump.age`.
3. Restore into Supabase: ask Claude for the exact `pg_restore --clean --if-exists --no-owner --no-privileges -d "<session pooler URL>" restore.dump` command for the situation. Partial or table-level restores differ.
4. Delete `restore.dump` from the laptop.
5. `./dc start api`, then check `/readyz` and the POS.
6. Key in any orders taken on paper since the dump time.

## Deploys (what runs when)
- A push to `main` runs **CI**. Only if CI is **green**, **Deploy API** and **Deploy web apps** start by themselves, for exactly the commit CI verified. Red CI ships nothing.
- **Deploy API** first checks whether deploy-relevant files changed (`apps/api`, `packages`, `infra/compose`, `infra/backup`, `package.json`, `pnpm-lock.yaml`, its own workflow) since the last commit it really deployed (the newest run whose `deploy` job succeeded). If not (a docs-only commit), it ends with "no deploy" and the API is not restarted. A deploy that failed, was cancelled or was superseded is caught up by the next green push, because the comparison starts from the last real deploy. **Deploy web apps** redeploys on every green push (same files, harmless).
- A newer commit on `main` supersedes an older one: re-running an old CI run does not deploy that old commit.
- Every deploy takes a **pre-deploy backup** first (`predeploy/`, 14 days), through the running `backup` service or a one-shot container if the service is down. If it fails, the deploy stops before migrations. Only the very first deploy (no `.deploy-state` yet) skips it.
- A changed **Caddyfile** is validated in a fresh container before migrations (a bad one stops the deploy with nothing changed), and caddy is **restarted** after the API is healthy. A bind-mounted file that was replaced is never seen by a running Caddy, so without the restart the change would silently not apply. `/opt/sds/.caddyfile.sha256` remembers what caddy loaded; if you edit the Caddyfile on the VM by hand, run `./dc restart caddy` yourself.
- **CI is red for a reason that does not touch production** (for example `pnpm audit` found a new advisory) **and a fix must ship now:** fix or pin the cause first. If it cannot wait, Actions → **Deploy API** → Run workflow on `main`. Manual runs skip the CI check, so that is your explicit override.
- **Refresh the backup image** (fresh base image and apt packages; see Routine): Actions → Deploy API → Run workflow → tick `rebuild_backup`.

## Deploy trust model
- The `deploy` user is in the `docker` group, which is **root-equivalent** on the VM. So anyone who can run a workflow that holds the Tailscale OAuth secret (GitHub write access to this repo), or who controls the `tag:ci` node, can act as root on the VM. That is the price of unattended, ฿0 deploys.
- What limits it: the Tailscale policy lets `tag:ci` reach only SSH on `tag:server`, as `deploy`; automatic deploys run only after green CI on `main`; the third-party actions are pinned by commit SHA; the repo is private with a single owner and GitHub 2FA. On a paid GitHub plan, SETUP "H1" adds environment secrets limited to `main` and branch protection.
- Not adopted: rootless Docker or a Docker-socket proxy. They add moving parts and memory on a 1 GB VM. Revisit if the repo ever gets more collaborators.

## Rollback
The API image is `ghcr.io/omeieee/pos-api:<git sha>`. `/opt/sds/.deploy-state` holds `API_IMAGE` and `PREVIOUS_API_IMAGE`. **Migrations are never rolled back**: they are expand-only, so the previous API still works against the newer schema.

- **Automatic:** `deploy-api.yml` rolls back by itself, but only once the new image was switched in: when `deploy.sh apply` exits 10 (failed after the switch, before the new API was verified healthy) or the public `/healthz` smoke test fails afterwards. A deploy that fails earlier (pull, pre-deploy backup, Caddyfile check, migration) or later (Caddy restart, image prune) is **not** rolled back, so redeploying the same sha can never downgrade a healthy API.
- **A. Previous version, right now (on the VM):**
  ```bash
  ssh deploy@sds-pos '/opt/sds/deploy.sh status'
  ssh deploy@sds-pos '/opt/sds/deploy.sh rollback'
  ```
  **Expected:** `rolled back to ghcr.io/omeieee/pos-api:<sha>`.
- **B. Any earlier version (from GitHub):**
  1. Actions → **Deploy API** → Run workflow → `image_tag` = the full 40-character sha of a commit whose image exists (see the Packages page, pos-api).
  2. The run pulls that image, takes a pre-deploy backup, runs migrations (a no-op for old code), starts it and smoke-tests it.
  3. **Rollback test (P2 exit criterion):** deploy the previous sha this way, check `/healthz`, then run the workflow again with an empty `image_tag` to return to `main`.
- **Web apps:** Cloudflare dashboard → Workers & Pages → `sds-pos` / `sds-order` → Deployments → pick an earlier one → **Rollback to this deployment**.
- **Then:** fix forward on `main`. Don't leave production pinned to an old sha for long.

## Oracle instance lost (reclaimed, terminated, or region trouble). Target ≤ 2 h
Only three things live only on the VM: the Caddy certificate, `/opt/sds/.env` (recreated in step 5 from your copy) and `/opt/sds/.deploy-state` (the current image tags; the next deploy rewrites it). Data is in Supabase, backups are in OCI Object Storage, and images are in GHCR.
1. **(10 min)** OCI console → Compute → Create instance:
   - **VM.Standard.E2.1.Micro** (Always Free), Ubuntu 24.04;
   - same VCN/subnet (the security list already allows 80/443 only);
   - SSH key: your existing `.pub`.
   - Note the new public IP.
   - If you rebuild in another region, the backup bucket stays in Singapore; that's fine.
2. **(5 min)** Open TCP 22 from your IP/32 temporarily. Put the new IP in `~/.ssh/config` → `pos-oracle`.
3. **(10 min)** `ssh pos-oracle 'sudo bash -s' < infra/oracle/bootstrap.sh` → `bootstrap: OK`.
4. **(10 min)** Tailscale:
   1. admin console → remove the old `sds-pos` machine;
   2. on the new VM: `sudo tailscale up --ssh --advertise-tags=tag:server --hostname=sds-pos`;
   3. check key expiry is disabled;
   4. `ssh pos-ts true`;
   5. remove the temporary port 22 rule.
5. **(10 min)** Recreate `/opt/sds/.env` (SETUP 2.7) with **`API_HOST` = the new sslip name** (`a-b-c-d.sslip.io`). The other values come from your USB/text copy or are regenerated, **except `AUTH_SECRET_KEY`, which must come from the offline copy and is never regenerated** (a new key locks the owner out):
   - a new OCI Customer Secret Key is fine;
   - the DB password is unchanged.
6. **(15 min)** Do "IP changed" below, then run **Actions → Deploy API** and **Deploy web apps**.
7. **(10 min)** Checks:
   - `curl https://<new>/healthz`;
   - **External check** workflow;
   - a restore drill if backups are in doubt.
8. Update `infra/oracle/README.md` (new IP, OCID, date) via Claude.

**The database itself is lost** (Supabase project deleted): create a new Supabase project in Singapore, run `infra/supabase/bootstrap.sql`, do a real restore (above) from the newest dump, and update `DATABASE_URL`.

### IP changed (the hostname follows the IP)
The IP-derived hostname lives in these places; change them all:
1. GitHub variable **`API_HOST`**. It also sets `VITE_API_BASE_URL` and the API host in the web apps' CSP `_headers`, so **re-run Deploy web apps**.
2. `/opt/sds/.env` **`API_HOST`**, then `./dc up -d caddy`. Caddy gets a new certificate.
3. UptimeRobot monitor URL.
4. `~/.ssh/config` `pos-oracle` HostName (break-glass only).
5. From P4: the LINE webhook URL in the LINE Developers console. The LIFF endpoints are on `pages.dev` and don't change.

`CORS_ORIGINS` doesn't change; it lists the `pages.dev` origins.

## Create the first owner account (once, from P3)
The owner chooses the password and scans the authenticator code; nothing secret passes through Claude. It needs a real terminal (`-t`) and runs through compose, because compose reads `.env` correctly:
```bash
ssh -t deploy@sds-pos 'cd /opt/sds && ./dc run --rm --no-deps -e NODE_OPTIONS=--max-old-space-size=384 api node dist/owner-create.js'
```
- It asks for the owner's name and password (not echoed), shows the authenticator secret and `otpauth://` link as text (add it to any authenticator app by typing the secret), and asks for a first 6-digit code **before** saving anything.
- It then prints the one-time **recovery codes** once. Write them on paper next to the age key; they are stored only as hashes.
- A second run is refused while an owner exists. There is no re-enrolment or reset tool yet (planned: `owner:reset`), so **do not create the real owner account until that tool exists**; after that, keep the recovery codes and the authenticator safe.
- Needs `AUTH_SECRET_KEY` in `/opt/sds/.env` (SETUP 2.7) and the `api` image from a deploy that includes migration 0005.

## Suspicious PromptPay ID change
A PromptPay ID change raises an owner alert and an `audit_log` entry (CLAUDE.md rule 3). Treat any change you didn't make as an incident: **money may be going to someone else's account.**
1. **Right away:** tell staff to stop showing PromptPay QRs. Take cash, or show your own known QR sticker, until this is fixed.
2. In the POS back office, as owner, with step-up: set the PromptPay ID back to the correct value. Check a test QR in K PLUS: the payee name must be yours.
3. Find out who did it:
   - check `audit_log` for the change (who, which device, when);
   - revoke that device and staff PIN (see "Lost iPad");
   - change the owner password and TOTP if the owner account was used.
4. Check every PromptPay payment since the change against your bank statement. Any customer money that went to the wrong account is a police or bank matter; keep the audit log export.
5. Sign out everything: revoke all sessions and devices (sessions are database rows; ask Claude for the exact statement). **Do not rotate `AUTH_SECRET_KEY` for this**: it signs nobody out and it locks the owner out.

## Lost or stolen iPad or iPhone
1. Owner → Settings → Devices → **Revoke** the device (step-up). (The device routes are not built yet: until they are, ask Claude to revoke it in the database.) Its token stops working immediately.
2. If a staff member's PIN may be known, reset that PIN.
3. Apple: Find My → Mark as lost / Erase.
4. Register a replacement device from the owner account.

## Shop internet down
- The cloud keeps running; only the shop is cut off. LINE customers can still order: orders queue and appear when staff devices reconnect.
- **Staff:**
  - switch an iPhone to its mobile data hotspot and connect the iPad to it;
  - the POS works over mobile data;
  - if even that fails, take orders on paper and key them in afterwards.
- (P8) The kitchen printer needs the Mini PC online; tickets print when it reconnects.
- Nothing to do on the server.

---

## Routine
| When | What |
|---|---|
| Weekly (5 min) | Review the alerts and the Sentry digest. External check run is green (it runs on its own every Monday) |
| Monthly (30 min) | **Restore drill** (above) → record in PROGRESS. `ssh pos-ts 'df -h /; free -m'`. Check GHCR package sizes stay small. Then the three patch steps below (outside opening hours) |
| Quarterly | Rotate the OCI Customer Secret Key, the Cloudflare token and the **Tailscale OAuth client** (Tailscale admin → Trust credentials: generate a new one with the same scope and tag, replace `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` in GitHub, run Deploy API to prove it, then delete the old client). Review the Tailscale machines and policy. Re-check free-tier terms (05 §3). Bump `WRANGLER_VERSION` in `deploy-web.yml` if wanted |

### Monthly patching (things `unattended-upgrades` and the deploys do not cover)
Unattended-upgrades applies only Ubuntu security updates, and deploys pull only our own images. Do these outside opening hours:
1. **Docker and Tailscale packages** (their apt repos are not covered): `ssh -t pos-ts 'sudo apt update && sudo apt upgrade'`, and read the list before you say yes.
   - Docker runs with `live-restore`, so containers keep running while the daemon restarts, but do it when the shop is closed.
   - Then `ssh deploy@sds-pos '/opt/sds/dc ps'`: api, caddy and backup healthy. A pending reboot happens by itself in the Monday 03:00–05:00 window.
2. **Caddy image** (`caddy:2-alpine` is a floating tag that deploys never pull): `ssh deploy@sds-pos '/opt/sds/dc pull caddy && /opt/sds/dc up -d caddy'`. The certificate survives in the `sds_caddy_data` volume. Then `curl -sS https://138-2-67-89.sslip.io/healthz`.
3. **Backup image** (postgres, age, rclone, curl are otherwise frozen at the last build): Actions → **Deploy API** → Run workflow on `main` → tick **rebuild_backup**. It rebuilds without cache on a fresh base image and redeploys. Then `dc ps` (backup healthy) and, once, `dc exec -T backup backup hourly` ending in `OK in Ns`.
