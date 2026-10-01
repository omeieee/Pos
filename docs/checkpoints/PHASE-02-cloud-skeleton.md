# Phase 2 — Cloud Walking Skeleton

**Status:** 🟡 In progress (deployed, auto-deploy and rollback done; alert test run by the owner, free-tier/PAYG check and the decision on the deferred rebuild test pending) · **Depends on:** P1, Q1, Q8 · **Agents:** devops-engineer, backend-engineer, qa-security-reviewer

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
- [x] Merging to `main` deploys the API and web apps automatically; rollback procedure written and tried once — rollback option A tried 2026-09-30 (worked, reverted); owner confirmed in the Actions tab on 2026-10-01 that the 2e76581 deploy ran automatically (owner-reported, not seen by Claude; the web-apps run was not confirmed separately); rollback option B untried
- [ ] Hourly encrypted backup lands in **OCI Object Storage** (owner's choice 2026-09-29: no R2); a missed run raises an alert — alert test run twice on 2026-10-01 (`backup` stopped on purpose, restart armed on the VM). Run 2 (13:57–14:55): healthchecks.io marked the check Down at about 14:50 and sent an Up email at 14:55, but **no Down email reached the alert inbox**, so the alert is NOT proven. Findings: the VM pings "My First Check" (not `sds-backup`), grace is about 45 min (SETUP says 30); the owner checks the check's Log, Integrations and grace
- [x] **Restore drill passed:** the dump restores into a fresh container and sanity queries match — 2026-09-29 `DRILL PASSED`, migrations 5=5 (business tables empty; repeat once real data exists)
- [x] Rebuild-on-new-host procedure documented (target ≤ 2 h) — RUNBOOK "Oracle instance lost" (step estimates sum to ~70 min; never run end to end)
- [ ] Free-tier usage checked (Oracle Free Tier, Supabase, Cloudflare Pages); idle-reclamation rebuild procedure tested — usage read by Claude on 2026-10-01 (read-only): VM disk 6.4 of 45 GB, RAM 954 MB (490 MB available, swap 171 of 2048 MB used), Docker images 1.07 GB; Supabase database 11 MB of the 500 MB free cap, 21 tables, 5 migrations, 0 orders; Supabase security advisor INFO only (RLS on with no policies, by design), performance advisor INFO only (13 foreign keys without an index, unused indexes while there is no traffic; add covering indexes in a 0005+ migration during P3); Cloudflare Pages not checked (two static projects); owner deferred the second-VM rebuild test 2026-10-01; owner reports the account is Pay-As-You-Go (2026-10-01; no budget alert yet; rules in docs/05 §3.1; Oracle's page states no PAYG exemption from idle reclamation, so the rebuild test stays relevant); to close P2 without it, carry it to a named later phase (owner decision)

## As built
- **Host:** Oracle E2.1.Micro `omeie_pos`, 138.2.67.89 (ephemeral) → `138-2-67-89.sslip.io`. Admin + CI SSH via Tailscale (`tag:server` / `tag:ci`); port 22 closed (verified 2026-09-29: public :22 times out, tailnet SSH works). Bootstrap applied (2 GB swap, Docker 29.8.1, `deploy` user); `/opt/sds/.env` in place; API, caddy and backup containers healthy since first deploy (image 33bfb96).
- **Services (`/opt/sds`, compose):** `api` (ghcr.io/omeieee/pos-api:<sha>, internal only), `caddy` (80/443, Let's Encrypt), `backup` (postgres:17 + age + rclone → OCI bucket `sds-backups`, hourly/daily/monthly/predeploy prefixes, healthchecks.io).
- **DB:** Supabase via session pooler :5432 (direct host is IPv6-only); role `postgres` (BYPASSRLS) for now. `DATABASE_URL` ends in `?sslmode=require` (`.env` and, since the 2026-10-01 00:21 recreate, inside `api` and `backup`; verified by count, value not printed); hourly and one-shot backups ran `OK` against it. Supabase "Enforce SSL" is on per the owner (dashboard setting, not seen by Claude); the code forces TLS regardless.
- **Secrets live in:** `/opt/sds/.env` on the VM (DATABASE_URL, OCI keys, HC_PING_URL, SENTRY_DSN) and GitHub secrets (TS_OAUTH_*, CLOUDFLARE_*). The age private key is only on USB + paper.
- **Web:** Cloudflare Pages `sds-pos`, `sds-order` via `deploy-web.yml`.
- **Owner steps:** `infra/SETUP.md`; incidents: `infra/RUNBOOK.md`.

## Log
- 2026-09-29 · Code complete; waiting on owner setup Round 1 ([PROGRESS](../PROGRESS.md))
- 2026-09-29 · Setup Rounds 1–2 done; VM ready for first deploy ([PROGRESS](../PROGRESS.md))
- 2026-09-29 · First deploy live; restore drill passed ([PROGRESS](../PROGRESS.md))
- 2026-09-30 · QA review and fixes committed (25f0e62..5dfa646) ([PROGRESS](../PROGRESS.md))
- 2026-09-30 · QA fixes deployed; rollback tried once ([PROGRESS](../PROGRESS.md))
- 2026-10-01 · Owner answers recorded; alert test handed to the owner ([PROGRESS](../PROGRESS.md))
- 2026-10-01 · DB TLS verified; missed-backup alert test started ([PROGRESS](../PROGRESS.md))
- 2026-10-01 · Alert-test restart verified; backups running again ([PROGRESS](../PROGRESS.md))
- 2026-10-01 · Alert inbox searched: no Down/Up email, alert not proven ([PROGRESS](../PROGRESS.md))
- 2026-10-01 · Alert test run 2: Down detected, Down email missing ([PROGRESS](../PROGRESS.md))
