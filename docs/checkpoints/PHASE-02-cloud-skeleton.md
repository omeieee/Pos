# Phase 2 — Cloud Walking Skeleton

**Status:** 🟡 In progress (deployed; alert test, rollback test and QA review pending) · **Depends on:** P1, Q1, Q8 · **Agents:** devops-engineer, backend-engineer, qa-security-reviewer

## Goal
Put the 24/7 platform in place before features: a minimal API and app shells are deployed, monitored, backed up and restorable.

## Scope
- **In:**
  - Oracle VM (E2.1.Micro, Path B, Free Tier) set up with the hardening checklist ([05 §6](../05-infrastructure.md#6-oracle-vm-setup-and-hardening-checklist-p2));
  - ingress: Caddy + Let's Encrypt on a free sslip.io hostname (D-10 interim); Cloudflare Pages projects for `pos-web` and `liff-web` (`*.pages.dev`);
  - Docker Compose: `api` (health endpoints only), `caddy`, `backup` (Postgres is on Supabase);
  - deploy-on-merge workflow;
  - uptime check, Sentry, healthchecks.io;
  - `infra/RUNBOOK.md`.
- **Out:** business features.

## Exit criteria
- [x] `https://<sslip-hostname>/healthz` is served by Caddy with a valid Let's Encrypt certificate; only 80/443 are reachable from the internet (SSH via Tailscale only), checked from outside — 2026-09-29: healthz/readyz OK, issuer Let's Encrypt, 22/3000/5432/2019 closed from the laptop
- [ ] Merging to `main` deploys the API and web apps automatically; rollback procedure written and tried once
- [ ] Hourly encrypted backup lands in **OCI Object Storage** (owner's choice 2026-09-29: no R2); a missed run raises an alert
- [x] **Restore drill passed:** the dump restores into a fresh container and sanity queries match — 2026-09-29 `DRILL PASSED`, migrations 5=5 (business tables empty; repeat once real data exists)
- [ ] Rebuild-on-new-host procedure documented (target ≤ 2 h)
- [ ] Free-tier usage checked (Oracle Free Tier, Supabase, Cloudflare Pages); idle-reclamation rebuild procedure tested

## As built
- **Host:** Oracle E2.1.Micro `omeie_pos`, 138.2.67.89 (ephemeral) → `138-2-67-89.sslip.io`. Admin + CI SSH via Tailscale (`tag:server` / `tag:ci`); port 22 closed (verified 2026-09-29: public :22 times out, tailnet SSH works). Bootstrap applied (2 GB swap, Docker 29.8.1, `deploy` user); `/opt/sds/.env` in place; API, caddy and backup containers healthy since first deploy (image 33bfb96).
- **Services (`/opt/sds`, compose):** `api` (ghcr.io/omeieee/pos-api:<sha>, internal only), `caddy` (80/443, Let's Encrypt), `backup` (postgres:17 + age + rclone → OCI bucket `sds-backups`, hourly/daily/monthly/predeploy prefixes, healthchecks.io).
- **DB:** Supabase via session pooler :5432 (direct host is IPv6-only); role `postgres` (BYPASSRLS) for now.
- **Secrets live in:** `/opt/sds/.env` on the VM (DATABASE_URL, OCI keys, HC_PING_URL, SENTRY_DSN) and GitHub secrets (TS_OAUTH_*, CLOUDFLARE_*). The age private key is only on USB + paper.
- **Web:** Cloudflare Pages `sds-pos`, `sds-order` via `deploy-web.yml`.
- **Owner steps:** `infra/SETUP.md`; incidents: `infra/RUNBOOK.md`.

## Log
- 2026-09-29 · Code complete; waiting on owner setup Round 1 ([PROGRESS](../PROGRESS.md))
- 2026-09-29 · Setup Rounds 1–2 done; VM ready for first deploy ([PROGRESS](../PROGRESS.md))
- 2026-09-29 · First deploy live; restore drill passed ([PROGRESS](../PROGRESS.md))
- 2026-09-30 · QA review and fixes, uncommitted ([PROGRESS](../PROGRESS.md))
