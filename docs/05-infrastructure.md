# 05 · Infrastructure and Operations

Decisions: [D-03](decisions.md#d-03--database--open-q1), [D-10](decisions.md#d-10--hosting--open-q1-q8), [D-18](decisions.md#d-18--backups-and-monitoring--proposed). ✅ = checked against the source in Sept 2026. ⚠️ = from general knowledge; re-check before relying on it. Free tiers change, so review this file every quarter.

## 1. Recommendation
**Run the whole backend on the owner's Oracle VM with Docker Compose, and put Cloudflare in front of it:**
- DNS, TLS and a Tunnel, so no inbound ports are open;
- Pages for the two web apps;
- R2 for backups and images.

**Upgrade the Oracle account to Pay-As-You-Go**, with a budget alert of about US$1. Always Free resources stay free, and idle instances are no longer reclaimed.

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
| Oracle Cloud Always Free | VM, block storage, object storage | A1: 1,500 OCPU-h and 9,000 GB-h a month (≈ **2 OCPU / 12 GB**) for Always Free tenancies. Up to 2× E2.1.Micro (1/8 OCPU, 1 GB). 200 GB block storage + 5 volume backups. 20 GB object storage. 10 TB outbound a month. **Idle reclamation:** over 7 days, CPU p95 < 20% **and** network < 20% **and** (A1) memory < 20%. PAYG keeps idle instances from being reclaimed | ✅ [Oracle docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| Cloudflare | DNS, TLS, Tunnel, Pages, R2, (Access) | Tunnel free; Pages free static hosting; R2 about 10 GB storage a month with free egress; Zero Trust Access free for a small team | ⚠️ check the current limits |
| Supabase (Path B only) | Postgres | 500 MB DB, 1 GB storage, 5 GB egress, 2 projects, **pauses after 1 week without DB activity**, **no backups** | ✅ [pricing](https://supabase.com/pricing) |
| LINE Official Account | Chat, webhooks, messages | 300 counted messages a month; replies free | ✅ see [04 §1.2](04-integrations.md#12-message-budget-the-main-line-constraint) |
| GitHub | Private repo, Actions, GHCR | Actions minutes and package storage are limited on private repos | ⚠️ check |
| Sentry | Error tracking | Free developer plan | ⚠️ check |
| healthchecks.io / UptimeRobot / Better Stack | Cron and uptime checks | Free tiers exist | ⚠️ check terms for commercial use |
| ntfy.sh (P8, testing) | Push to phones | About 250 messages a day, 2 MB attachments. Self-hosted: no limits | ✅ [issue #1167](https://github.com/binwiederhier/ntfy/issues/1167) |

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
- **Never commit, print or paste the private key** (docs, chat, CI logs). Tools refer to it by path only. CI deploys (P2) use a **separate deploy key**, not this one.

- [ ] Record public IP, login user, shape, OCPU/RAM, region, availability domain and OCID in `infra/oracle/README.md`. These are not secrets; the key is.
- [ ] Upgrade the account to PAYG and add a budget alert (recommended; the owner currently stays on **Free Tier**). Confirm the shapes stay Always Free.
- [ ] Path B on 1 GB: 2 GB swap file; Node heap capped; images built in CI (amd64) and pulled from GHCR.
- [ ] Ubuntu LTS image, SSH keys only, root login and password auth disabled.
- [ ] Admin access: SSH restricted to the owner's IP in the OCI security list, **or** Tailscale (no public SSH at all).
- [ ] `unattended-upgrades` for security patches. Reboot window 03:00–05:00 on Mondays.
- [ ] Docker Engine + Compose plugin. Log rotation (`max-size`, `max-file`) on every service.
- [ ] Remember that Oracle's Ubuntu image has its own iptables rules on top of the security list. **Interim setup (Caddy):** open TCP 80 and 443 in **both** the OCI security list and the VM's iptables, and nothing else except SSH from the owner. Caddy handles HTTPS; the API listens only on the internal Docker network.
- [ ] Hostname stability: the public IP is **ephemeral** (checked 2026-09-29). Before LINE goes live (P4), decide whether to switch to a **reserved** public IP (the IP changes once, then survives rebuilds; check that it's free on Free Tier) or accept updating the URLs after any rebuild.
- [ ] Rate limiting and request-size limits in Caddy and the API; fail2ban or Caddy logs checked for scanning noise.
- [ ] Postgres not published to the host; the app DB user has least privilege.
- [ ] `.env` is `chmod 600` and owned by the deploy user. Secrets are also in a password manager.
- [ ] `restart: unless-stopped` and health checks on every service.
- [ ] Record the instance OCID, region and shape in `infra/oracle/README.md`, with no secrets.

## 7. Backups and disaster recovery
- **Database:**
  - `pg_dump -Fc` every hour during opening hours, plus a nightly full dump;
  - each dump is encrypted with `age`, uploaded to **R2**, and copied to **OCI Object Storage**;
  - retention: hourly for 48 h, daily for 30 days, monthly for 12 months;
  - every run pings healthchecks.io, so a missed backup raises an alert.
- **Files:** menu photos and slips are stored in R2 (lifecycle rule deletes slips after 90 days). Nothing important lives only on the VM's disk.
- **Restore drill (monthly):** restore the latest dump into a throwaway container, run row-count and sanity queries, and record the result in `docs/PROGRESS.md`.
- **Rebuilding elsewhere (RTO ≤ 2 h):** `infra/oracle/bootstrap.sh` and the Compose files build a fresh host. Restore the dump, point the Tunnel at the new host, and change nothing else. Backup hosts: the Mini PC (through the same Tunnel) or a low-cost VPS.
- **Keep the age private key off the VM** (password manager plus a printed copy). Without it the backups can't be read.

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
- **On merge to `main`:**
  - web apps build and deploy through **Cloudflare Pages** Git integration, with preview URLs for PRs;
  - the API is deployed by a GitHub Actions job over SSH/Tailscale to the VM:
    1. `git pull`;
    2. `docker compose build` (Path A) or `pull` (Path B);
    3. run migrations;
    4. `up -d`;
    5. smoke-test `/healthz`;
    6. report the result.
- **Migrations:** forward-only, and never edit one that has already been applied. Keep them backward-compatible across one deploy (expand → migrate → contract).
- **Rollback:** redeploy the previous git tag, with a database restore only if a migration was destructive (avoid those).

## 10. Running it 24/7 without babysitting
| When | What (most of it automated) |
|---|---|
| Continuously | Auto-restart, health checks, uptime/backup/error alerts, quota tracker |
| Weekly (5 min) | Look over the alerts and Sentry digest, and check that the OS patched itself |
| Monthly (30 min) | Restore drill · dependency updates (Renovate/Dependabot PRs) · LINE quota trend · disk trend |
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
