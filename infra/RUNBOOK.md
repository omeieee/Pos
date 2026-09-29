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
| Backup key | age private key: printed copy + USB drive at home. **Never on the VM or laptop** |
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
   - Check memory with `ssh pos-ts 'free -m; dmesg -T | grep -i -E "killed process|oom" | tail'`. An OOM kill means the 1 GB is exhausted; the API heap cap is 320 MB.
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
  - check that `DATABASE_URL` in `/opt/sds/.env` is the **session pooler, port 5432**;
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
- The key travels over the tailnet into a throwaway container (`--rm`) and is never written to the VM's disk.
- **Pass:**
  - `DRILL PASSED`;
  - restored tables = production tables;
  - `drizzle migrations: restored=N prod=N`;
  - row counts equal or slightly lower than prod, since prod has moved on.
- `DRILL CHECK` means a table or migration differs. That is normal right after a migration; otherwise investigate.
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

## Rollback
The API image is `ghcr.io/omeieee/pos-api:<git sha>`. `/opt/sds/.deploy-state` holds `API_IMAGE` and `PREVIOUS_API_IMAGE`. **Migrations are never rolled back**: they are expand-only, so the previous API still works against the newer schema.

- **Automatic:** `deploy-api.yml` rolls back by itself when the public `/healthz` smoke test fails after a deploy.
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
Nothing but the Caddy certificate lives only on the VM. Data is in Supabase, backups are in OCI Object Storage, and images are in GHCR.
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
5. **(10 min)** Recreate `/opt/sds/.env` (SETUP 2.7) with **`API_HOST` = the new sslip name** (`a-b-c-d.sslip.io`). The other values come from your USB/text copy or are regenerated:
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
1. GitHub variable **`API_HOST`**. It also sets `VITE_API_BASE_URL` for the web apps, so **re-run Deploy web apps**.
2. `/opt/sds/.env` **`API_HOST`**, then `./dc up -d caddy`. Caddy gets a new certificate.
3. UptimeRobot monitor URL.
4. `~/.ssh/config` `pos-oracle` HostName (break-glass only).
5. From P4: the LINE webhook URL in the LINE Developers console. The LIFF endpoints are on `pages.dev` and don't change.

`CORS_ORIGINS` doesn't change; it lists the `pages.dev` origins.

## Suspicious PromptPay ID change
A PromptPay ID change raises an owner alert and an `audit_log` entry (CLAUDE.md rule 3). Treat any change you didn't make as an incident: **money may be going to someone else's account.**
1. **Right away:** tell staff to stop showing PromptPay QRs. Take cash, or show your own known QR sticker, until this is fixed.
2. In the POS back office, as owner, with step-up: set the PromptPay ID back to the correct value. Check a test QR in K PLUS: the payee name must be yours.
3. Find out who did it:
   - check `audit_log` for the change (who, which device, when);
   - revoke that device and staff PIN (see "Lost iPad");
   - change the owner password and TOTP if the owner account was used.
4. Check every PromptPay payment since the change against your bank statement. Any customer money that went to the wrong account is a police or bank matter; keep the audit log export.
5. Rotate the session secrets: ask Claude which variable, change it in `.env`, then `./dc up -d api`. This signs out all devices.

## Lost or stolen iPad or iPhone
1. Owner → Settings → Devices → **Revoke** the device (step-up). Its token stops working immediately.
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
| Monthly (30 min) | **Restore drill** (above) → record in PROGRESS. `ssh pos-ts 'df -h /; free -m'`. Check GHCR package sizes stay small |
| Quarterly | Rotate the OCI Customer Secret Key and the Cloudflare token. Review the Tailscale machines and policy. Re-check free-tier terms (05 §3) |
