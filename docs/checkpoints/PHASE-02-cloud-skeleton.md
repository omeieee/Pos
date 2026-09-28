# Phase 2 — Cloud Walking Skeleton

**Status:** 🟡 In progress (kickoff questions pending) · **Depends on:** P1, Q1, Q8 · **Agents:** devops-engineer, backend-engineer, qa-security-reviewer

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
- [ ] `https://<sslip-hostname>/healthz` is served by Caddy with a valid Let's Encrypt certificate; only 80/443 (+ restricted SSH) are reachable, checked from outside
- [ ] Merging to `main` deploys the API and web apps automatically; rollback procedure written and tried once
- [ ] Hourly encrypted backup lands in R2 (+ second copy); a missed run raises an alert
- [ ] **Restore drill passed:** the dump restores into a fresh container and sanity queries match
- [ ] Rebuild-on-new-host procedure documented (target ≤ 2 h)
- [ ] Free-tier usage checked (Oracle Free Tier, Supabase, Cloudflare Pages); idle-reclamation rebuild procedure tested

## As built
_Fill in with `/checkpoint`: hosts, hostnames, services, where secrets live (not the secrets), backup targets._

## Log
_Empty._
