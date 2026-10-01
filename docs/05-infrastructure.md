# 05 · Infrastructure and Operations

Decisions: [D-03](decisions.md#d-03--database--open-q1), [D-10](decisions.md#d-10--hosting--open-q1-q8), [D-18](decisions.md#d-18--backups-and-monitoring--proposed). ✅ = checked against the source in Sept 2026. ⚠️ = from general knowledge; re-check before relying on it. Free tiers change, so review this file every quarter.

## 1. Recommendation
**Run the whole backend on the owner's Oracle VM with Docker Compose, and put Cloudflare in front of it:**
- DNS, TLS and a Tunnel, so no inbound ports are open;
- Pages for the two web apps;
- R2 for backups and images.

**Upgrade the Oracle account to Pay-As-You-Go**, with a budget alert of about US$1. Always Free resources stay free: Oracle "only charge[s] you for resource usage above the Always Free limits". Oracle's page does **not** say that Pay-As-You-Go stops idle reclamation (⚠️ unverified), so the rebuild procedure in the RUNBOOK still matters. The operating rules are in [§3.1](#31-operating-rules-on-pay-as-you-go).

The only purchase is a **domain** (≈ US$10 a year ⚠️). The stack is ordinary containers, so the same `docker compose up` works on the future Mini PC or on any VPS if Oracle ever fails us.

The layout depends on the VM shape (**Q1**):

| | Path A — Ampere A1 (ARM) | Path B — E2.1.Micro (AMD, 1 GB RAM) |
|---|---|---|
| On the VM | api · postgres · backup · cloudflared · (ntfy P8) | api · backup · cloudflared · (ntfy P8) |
| Database | Postgres in Docker on the VM | **Supabase free** used as plain Postgres (Neon as alternative) |
| Builds | Build images on the VM (plenty of CPU) | Build in GitHub Actions and push to GHCR (the VM is too small to build) |
| Watch-outs | ARM64 images; "out of host capacity" when creating the instance | 1 GB RAM (keep Node heap small); Supabase pauses after 7 days of no DB activity, so a daily job touches the DB; no backups on the free plan, so our own dumps still apply |

## 2. Options compared
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Oracle VM + Compose + Cloudflare** (A/B above) | ฿0; full control; portable to the Mini PC; no cold starts for LINE webhooks | Owner runs the server (updates, backups); single VM | **Recommended** |
| Supabase-first (DB + Realtime + Auth + Edge Functions) | Least server work; realtime built in | 500 MB DB; pauses after 7 idle days; no free backups; vendor-specific code; harder to move on-site | Good plan B if Oracle is unusable |
| Cloudflare-native (Workers + D1 + Durable Objects) | No server; very reliable | Workers runtime limits; Fastify doesn't run there; hard to move on-site | Not chosen (conflicts with the Fastify/Mini PC plan) |
| Render / Koyeb free web services | Easy deploys | Services sleep when idle → LINE webhook timeouts | Not suitable |

## 3. Free tiers relied on
| Service | What we use | Free allowance | Status |
|---|---|---|---|
| Oracle Cloud Always Free | VM, block storage, object storage | A1: 1,500 OCPU-h and 9,000 GB-h a month (≈ **2 OCPU / 12 GB**) for Always Free tenancies. Up to 2× E2.1.Micro (1/8 OCPU, 1 GB). 200 GB block storage (boot volumes included) + 5 volume backups. **Object storage: 20 GB combined on Always-Free-only accounts, but 10 GB Standard + 10 GB Infrequent Access + 10 GB Archive on paid (PAYG) accounts**, 50,000 API requests a month. 10 TB outbound a month. **Idle reclamation:** over 7 days, CPU p95 < 20% **and** network < 20% **and** (A1 only) memory < 20%. The page states no PAYG exemption (⚠️ unverified) | ✅ [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| Cloudflare | DNS, TLS, Tunnel, Pages, R2, (Access) | Tunnel free; Pages free static hosting; R2 about 10 GB storage a month with free egress; Zero Trust Access free for a small team | ⚠️ check the current limits |
| Supabase (Path B only) | Postgres | 500 MB DB, 1 GB storage, 5 GB egress, 2 projects, **pauses after 1 week without DB activity**, **no backups** | ✅ [pricing](https://supabase.com/pricing) |
| LINE Official Account | Chat, webhooks, messages | 300 counted messages a month; replies free | ✅ see [04 §1.2](04-integrations.md#12-message-budget-the-main-line-constraint) |
| GitHub | Private repo, Actions, GHCR | Actions minutes and package storage are limited on private repos | ⚠️ check |
| Sentry | Error tracking | Free developer plan | ⚠️ check |
| healthchecks.io / UptimeRobot / Better Stack | Cron and uptime checks | Free tiers exist | ⚠️ check terms for commercial use |
| ntfy.sh (P8, testing) | Push to phones | About 250 messages a day, 2 MB attachments. Self-hosted: no limits | ✅ [issue #1167](https://github.com/binwiederhier/ntfy/issues/1167) |

### 3.1 Operating rules on Pay-As-You-Go
The owner reports (2026-10-01) that the Oracle account is **Pay-As-You-Go**. From now on a mistake in the console costs real money. ✅ = from [Oracle's Always Free page](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) read on 2026-10-01; ⚠️ = general knowledge, confirm in the console or with Oracle.

| Rule | Why |
|---|---|
| ✅ Oracle charges only for usage **above** the Always Free limits; Always Free resources stay free after the upgrade | The VM and bucket cost ฿0 as long as we stay inside the limits |
| ✅ Stay inside: up to **2× VM.Standard.E2.1.Micro** (1/8 OCPU, 1 GB), **200 GB** block + boot volumes in total (a default boot volume is 50 GB, minimum 47 GB), **5** volume backups, **10 TB** outbound a month | Anything else (another shape, a bigger or extra volume, a 6th backup) is billed |
| ✅ Object storage on a paid account is **10 GB Standard** (plus 10 GB Infrequent and 10 GB Archive), not 20 GB; 50,000 requests a month | Our backups go to the Standard tier: keep the bucket **below 10 GB** (alarm at 8 GB). Retention today: 48 h hourly, 31 d daily, 370 d monthly, 14 d pre-deploy, about 100 objects; dumps are about 70 KB now. At roughly 100 MB per compressed dump the bucket would be near 10 GB, so check its size monthly and shorten retention in `infra/backup/backup.sh` before it gets there |
| ⚠️ Create nothing new in the console without checking the shape is Always Free: no A1 beyond 2 OCPU / 12 GB in total, no load balancer, no NAT gateway, no extra reserved IPs, no Autonomous or other databases, no paid regions | These are common sources of surprise charges |
| ⚠️ A **stopped** instance keeps its boot volume (it still counts towards the 200 GB) and its public IP; a free Micro shape is not billed for compute while stopped. **Terminating** frees the volume but destroys the machine: the RUNBOOK rebuild procedure then applies, and the ephemeral public IP changes (so does the sslip.io hostname) | Don't leave a forgotten second VM or volume behind after a rebuild test |
| ⚠️ A **reserved** public IP is free only while attached to a running instance's VNIC; an unattached one is billed | Relevant if we reserve the IP before P4 |
| ✅ Idle reclamation (7 days, CPU p95 < 20% and network < 20%) is described only for Always Free instances and the page states **no PAYG exemption** (⚠️ unverified) | Our API is mostly idle, so the VM may count as idle. Mitigations: backups are off the VM, the rebuild procedure is written (not yet tested), UptimeRobot alerts if it vanishes, and Oracle usually emails a notice first (⚠️) |
| Set a **budget** (Billing → Budgets, about US$1 a month, alert at 50% and 100% to the owner's email) and look at **Cost Analysis** monthly. Zero spend is the expected value | PAYG has no spending cap: the budget only alerts |
| The second Micro VM for the deferred rebuild test is inside the free allowance (2 allowed) **only if** its boot volume keeps the total at or below 200 GB; **terminate it and its volume right after the test** | Avoids a forgotten, billable leftover |

## 4. Environments
| Environment | Where | LINE | Data |
|---|---|---|---|
| `local` | Owner's Windows PC: Docker Desktop (Postgres) + `pnpm dev` | Test OA; webhook through a temporary `cloudflared` quick tunnel | Seed data |
| `prod` | Oracle VM | Real OA "แซ่บโดนเส้น" | Real |
| (optional) `staging` | A second Compose project on the same VM, with its own DB and the test OA | Test OA | Copy of prod with customer data anonymised |

## 5. Domain and Cloudflare
1. Buy a domain and put its DNS on Cloudflare.
2. Hostnames:
   - `api.<domain>`: Tunnel → `api:3000`, also used for the LINE webhook;
   - `pos.<domain>`: Pages, `pos-web`;
   - `order.<domain>`: Pages, `liff-web`, the MINI App/LIFF endpoint;
   - `ntfy.<domain>` (P8).
3. `cloudflared` runs as a container, and the tunnel token lives in `.env`. The VM firewall allows **no** inbound HTTP/HTTPS.
4. Optional hardening: protect back-office routes, or a separate `admin.<domain>`, with Cloudflare Access email OTP.
5. **Without buying a domain. Chosen for now: option 2 (D-10, 2026-09-29).** (the owner already has a Cloudflare account with the subdomain `omeza25482548.workers.dev`):
   - **Web apps:** free `*.pages.dev` addresses work for `pos-web` and `liff-web`, including as the LINE app endpoint.
   - **API, option 1: a Worker on `workers.dev` + Workers VPC → Tunnel → VM.** No open ports. But it is **beta** (free during beta, price afterwards unknown), and its docs list HTTP/TCP with **no mention of WebSocket upgrades**, which the realtime sync needs. It must be tested in P2 before relying on it ([docs](https://developers.cloudflare.com/workers-vpc/)).
   - **API, option 2 ✅ chosen: Caddy + Let's Encrypt on a free hostname** (e.g. an sslip.io name based on the VM's IP, or DuckDNS). Only 443/80 open on the VM. WebSockets work. It depends on a third-party DNS service and on the VM keeping its IP.
   - **A domain (≈ US$10/yr) is still the recommendation:** stable URLs for LINE, a normal named Tunnel, no beta dependency. Switching later means updating the LINE webhook and app URLs once.

## 6. Oracle VM setup and hardening checklist (P2)
**Status (2026-09-29):** the owner has created the VM: **E2.1.Micro, 1 GB RAM, ap-singapore-1, Ubuntu 24.04, user `ubuntu`, Free Tier account**. That means **Path B**. Full record: [infra/oracle/README.md](../infra/oracle/README.md). Its SSH key pair `ssh-key-2026-09-28.key` / `.key.pub` now lives in `%USERPROFILE%\.ssh\`, outside the repo (moved 2026-09-29). `.gitignore` still blocks `*.key`, `*.key.pub` and `.env*` as a safety net.
- **Recommended:** move both files to `%USERPROFILE%\.ssh\` (e.g. `pos-oracle.key`) and add an entry to `~/.ssh/config`:
  ```
  Host pos-oracle
      HostName <public IP>
      User ubuntu          # opc on Oracle Linux images
      IdentityFile ~/.ssh/pos-oracle.key
      IdentitiesOnly yes
  ```
- **Keep the key's Windows permissions owner-only.** It is currently owner read-only, which is correct. Windows OpenSSH refuses keys that other accounts can read.
- **Never commit, print or paste the private key** (docs, chat, CI logs). Tools refer to it by path only. CI deploys (P2) sign in with **Tailscale SSH** as `deploy` (`tag:ci`), so no key is stored in GitHub; this key is never used by CI.

Status as of 2026-09-29 (VM state verified by the P2 sessions; ✅ = done, the unticked items say what is missing):
- [ ] Record public IP, login user, shape, OCPU/RAM, region, availability domain and OCID in `infra/oracle/README.md`. These are not secrets; the key is. *All recorded except the full OCID: the README has only its tail.*
- [ ] Upgrade the account to PAYG and add a budget alert (recommended). Confirm the shapes stay Always Free. *Owner reports on 2026-10-01 that the account status is **Pay-As-You-Go** (Oracle's "order processed" email also arrived); not seen by Claude. Still open: the budget alert (about US$1) and a look at Billing → Cost Analysis. Idle reclamation may still apply (see §3.1).*
- [x] Path B on 1 GB: 2 GB swap file; Node heap capped (384 MB, `apps/api/Dockerfile`); images built in CI (amd64) and pulled from GHCR.
- [x] Ubuntu LTS image, SSH keys only, root login and password auth disabled (`bootstrap.sh` `sshd_config.d/01-sds.conf`, applied 2026-09-29).
- [x] Admin access: Tailscale, no public SSH at all (OCI port 22 rule deleted; public :22 times out, tailnet SSH works).
- [x] `unattended-upgrades` for security patches. Reboot window 03:00–05:00 on Mondays. (Covers Ubuntu only: the Docker/Tailscale repos and the Caddy/backup images are patched by the monthly RUNBOOK steps.)
- [x] Docker Engine + Compose plugin. Log rotation (`max-size`, `max-file`) on every service.
- [x] Remember that Oracle's Ubuntu image has its own iptables rules on top of the security list. **Interim setup (Caddy):** open TCP 80 and 443 in **both** the OCI security list and the VM's iptables, and nothing else except SSH from the owner. Caddy handles HTTPS; the API listens only on the internal Docker network. *Verified from outside: 22, 3000, 5432, 2019 closed; External check workflow weekly.*
- [ ] Hostname stability: the public IP is **ephemeral** (checked 2026-09-29). Before LINE goes live (P4), decide whether to switch to a **reserved** public IP (the IP changes once, then survives rebuilds; check that it's free on Free Tier) or accept updating the URLs after any rebuild. *Not decided yet (before P4).*
- [ ] Rate limiting and request-size limits in Caddy and the API; fail2ban or Caddy logs checked for scanning noise. *Done: request-size limit in Caddy (6 MB), rate limiting in the API (`@fastify/rate-limit`). Not done: no rate limiting in Caddy (the stock image has no module), fail2ban not installed (`INSTALL_FAIL2BAN=1` in `bootstrap.sh` if wanted; SSH is not exposed), scanning noise in the Caddy logs not yet reviewed.*
- [x] Postgres not published to the host (there is no Postgres on the VM; the DB is Supabase).
- [ ] The app DB user has least privilege. *Not done: the API connects as Supabase `postgres` (BYPASSRLS). Plan a dedicated role before real business data.*
- [x] `.env` is `chmod 600` and owned by the deploy user (`deploy.sh` refuses to run otherwise).
- [ ] Secrets are also in a password manager. *Not done: there is no password manager yet (D-18: age key on paper + USB).*
- [x] `restart: unless-stopped` and health checks on every service (`dc ps`: api, backup, caddy healthy). The one-shot `drill` tool service (`run --rm`, profile `tools`) is the deliberate exception: `restart: "no"`, no health check.
- [ ] Record the instance OCID, region and shape in `infra/oracle/README.md`, with no secrets. *Region and shape yes; only the OCID tail.*

## 7. Backups and disaster recovery
- **Database:**
  - `pg_dump -Fc` every hour during opening hours, plus a nightly full dump;
  - each dump is encrypted with `age` and uploaded to **OCI Object Storage** (owner's choice 2026-09-29: no R2; same-provider risk accepted);
  - retention: hourly for 48 h, daily for 30 days, monthly for 12 months;
  - every run pings healthchecks.io, so a missed backup raises an alert.
- **Files:** menu photos and slips are stored in R2 (lifecycle rule deletes slips after 90 days). Nothing important lives only on the VM's disk.
- **Restore drill (monthly):** restore the latest dump into a throwaway container, run row-count and sanity queries, and record the result in `docs/PROGRESS.md`.
- **Rebuilding elsewhere (RTO ≤ 2 h):** `infra/oracle/bootstrap.sh` and the Compose files build a fresh host. Restore the dump, then update the hostname (interim, D-10: the sslip.io name follows the new IP, RUNBOOK "IP changed"; once a domain and Tunnel exist: point the Tunnel at the new host), and change nothing else. Backup hosts: the Mini PC (through the same Tunnel) or a low-cost VPS.
- **Keep the age private key off the VM** (a printed copy plus a USB drive; no password manager yet, D-18). It is never stored at rest on the VM: the restore drill streams it into a throwaway container's memory. Without it the backups can't be read.

## 8. Monitoring and alerting
| Signal | Tool | Alert to |
|---|---|---|
| `https://api.<domain>/healthz` down | Uptime checker, 1–5 min interval | Owner (email / ntfy) |
| Backup missed | healthchecks.io | Owner |
| Errors (API + web apps) | Sentry free | Owner (daily digest + spikes) |
| Disk > 80%, container restarts, certificate/Tunnel down | Daily `ops-check` job in the API (pg-boss) + Docker health | Owner |
| LINE quota ≥ 80% | Quota tracker (D-09) | Owner + banner in the POS |
| "No orders by 12:00 on an open day" | Daily business sanity job | Owner (may mean something is broken) |

## 9. CI/CD
- **On a pull request:** install (pnpm cache) → Biome → typecheck → unit tests → build (Turborepo, only what changed).
- **After CI is green on `main`** (P2, as built; owner setup in [infra/SETUP.md](../infra/SETUP.md)):
  - **Trigger:** both deploy workflows run on `workflow_run` of the CI workflow, only for a successful CI run of a *push* to `main` of this repo, and they check out and deploy exactly the commit CI verified (`head_sha`, not the branch tip; a superseded commit is skipped). A red CI ships nothing. A manual run (`workflow_dispatch`, on `main`) is the owner's explicit override. `workflow_run` cannot filter by path, so Deploy API skips docs-only changes itself (RUNBOOK "Deploys"); the web deploy runs on every green push.
  - **Secrets:** the jobs that use `TS_OAUTH_*` / `CLOUDFLARE_*` declare `environment: production`; third-party actions are pinned by commit SHA and wrangler by exact version. Restricting the environment to `main` and branch protection need a paid GitHub plan for a private repo (SETUP "H1"). Trade-off: `deploy` is in the docker group, i.e. root-equivalent (RUNBOOK "Deploy trust model").
  - **Web apps** (`deploy-web.yml`):
    - GitHub Actions builds `pos-web` and `liff-web` with `VITE_API_BASE_URL=https://$API_HOST`;
    - `cloudflare/wrangler-action` uploads them (`pages deploy`) to the Pages projects `sds-pos` and `sds-order`;
    - it uses a scoped API token (Pages: Edit), not the Pages Git integration;
    - each app ships `public/_headers` (CSP with `frame-ancestors 'none'`, `nosniff`, referrer policy); the workflow fills in the API host from `API_HOST` and refuses to deploy a leftover placeholder.
  - **API** (`deploy-api.yml`). The VM never builds and never holds the repo:
    1. build `ghcr.io/omeieee/pos-api:<sha>` (and the backup image) for amd64 in Actions, and push to GHCR;
    2. join the tailnet as `tag:ci` (Tailscale OAuth client). SSH as `deploy` through **Tailscale SSH**, so there is no deploy key and no public port 22;
    3. copy the compose bundle (`infra/compose/*`) to `/opt/sds`;
    4. `docker login ghcr.io` on the VM with the job's read-only token, `pull`, then `logout` at the end (no registry credentials stay on the VM);
    5. **pre-deploy backup** (`predeploy/` prefix; skipped only on the very first deploy, and the deploy stops if it fails), then run migrations (`docker compose run --rm api node dist/migrate.js`, heap-capped like the API) before the new API starts;
    6. `docker compose up -d --wait`, and check that the running image is the new tag and healthy;
    7. smoke-test `https://$API_HOST/healthz` from the runner;
    8. on failure **after the new image was switched in** (`deploy.sh apply` exit 10, or a failed smoke test), roll back to `PREVIOUS_API_IMAGE` (kept in `/opt/sds/.deploy-state`); a failure before the switch changes nothing and is not rolled back.
  - **External check** (`external-check.yml`, weekly + manual): valid certificate on 443, http→https, and only 80/443 reachable from the internet.
- **Migrations:** forward-only, and never edit one that has already been applied. Keep them backward-compatible across one deploy (expand → migrate → contract).
- **Rollback:** `deploy.sh rollback` on the VM (previous image), or run `deploy-api.yml` with `image_tag=<older sha>`. Migrations are not reverted, and a database restore is needed only if a migration was destructive (avoid those). See [infra/RUNBOOK.md](../infra/RUNBOOK.md#rollback).

## 10. Running it 24/7 without babysitting
| When | What (most of it automated) |
|---|---|
| Continuously | Auto-restart, health checks, uptime/backup/error alerts, quota tracker |
| Weekly (5 min) | Look over the alerts and Sentry digest, and check that the OS patched itself |
| Monthly (30 min) | Restore drill · Docker/Tailscale apt upgrade, Caddy image pull, backup image rebuild (RUNBOOK "Monthly patching") · dependency updates (Renovate/Dependabot PRs) · LINE quota trend · disk trend |
| Quarterly | Re-check free-tier terms (this file) · access review (devices, staff) · rotate secrets · update tax rules if the year changed |
| Yearly | Renew the domain · add the new tax-year rules file · clean up per the PDPA retention policy |

**Incident playbooks** (to write in P2 as `infra/RUNBOOK.md`):
- API down
- database full
- LINE webhook failing
- shop internet down
- lost iPad (revoke the device)
- suspicious PromptPay ID change
- Oracle instance lost (rebuild elsewhere)

## 11. Cost summary
| Item | Cost |
|---|---|
| Oracle VM, Cloudflare, Supabase (Path B), GitHub, Sentry, monitoring | ฿0 on free tiers |
| Domain | ≈ US$10 a year ⚠️ |
| LINE OA | ฿0 up to 300 counted messages a month. Basic is ฿1,280 a month if needed |
| Later (P8) | Mini PC + XP-80T + small UPS: one-off hardware |
| Later (P10, optional) | iPad/iPhone and Mac apps: Apple Developer Program **US$99 a year**, plus access to a Mac for builds. Windows and Linux apps: ฿0 |

## 12. Native app distribution and build machines (P10)
| Platform | Needs | Distribution | Status |
|---|---|---|---|
| iPad / iPhone | **Apple Developer Program (US$99/yr)**: required for TestFlight, Ad Hoc, Unlisted and App Store. **macOS + Xcode** to build | Start with **TestFlight internal testing** (the shop's own devices; no beta review; builds must be refreshed periodically ⚠️ check expiry). Move to **Unlisted App Store** distribution once stable | ✅ [Apple](https://developer.apple.com/programs/whats-included/) |
| macOS | Developer ID signing + notarization (same Apple membership); macOS to build | Signed `.dmg` + auto-update | ✅ same |
| Windows | Nothing paid | **Microsoft Store**: registration is free for individuals (since Sept 2025) and companies (since May 2026). Or a direct installer: unsigned shows a SmartScreen warning, which is acceptable on the shop's own PCs | ✅ [Microsoft](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/), [2026 update](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/) |
| Linux | Nothing paid | AppImage and `.deb` from CI | — |

**Build machines.** The owner works on Windows. iOS and macOS builds need macOS:
- a Mac of your own or borrowed (an older Mac mini is enough); or
- cloud macOS CI. ⚠️ GitHub Actions macOS runners use up free minutes much faster on private repos, so check current pricing and other CI providers' free macOS tiers at P10.

Windows and Linux builds run on standard GitHub runners or locally.
