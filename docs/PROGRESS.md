# Progress Log

**Current phase:** P2 — Cloud skeleton ([checkpoint](checkpoints/PHASE-02-cloud-skeleton.md)), status **in progress: first deploy live; QA fixes committed, redeploy (first automatic deploy) pending**.
**Previous:** P1 — Foundation ✅ Done 2026-09-29 ([checkpoint](checkpoints/PHASE-01-foundation.md)).

> **Handoff for the next session (read first):**
> - **P2 is deployed:** API live at `https://138-2-67-89.sslip.io` (Caddy + Let's Encrypt, `/healthz` and `/readyz` OK, image 33bfb96), web apps `sds-pos.pages.dev` and `sds-order.pages.dev` return 200, UptimeRobot monitor set (owner report). Backup hourly to OCI works; **restore drill passed 2026-09-29**.
> - **Still to do in P2 (SETUP 3.5/3.7):** ghcr prune access (3.2) and External check (3.3) are green (owner report 2026-09-29). Prove the missed-backup alert (owner deferred it to another day) (stop `backup` outside opening hours before a slot, wait slot + 30 min grace, confirm the email, restart it); try the rollback once (RUNBOOK option B) and redeploy main; decide the second Micro VM for the rebuild test; then QA review (qa-security-reviewer) and close P2.
> - **VM state (verified 2026-09-29):** Ubuntu 24.04, 2 GB swap, Docker 29.8.1, `deploy` user, Tailscale `sds-pos` (SSH on, tag:server, auto-update on), public port 22 closed, `/opt/sds/.env` complete (mode 600). Containers api, backup, caddy all healthy. Reach it with `ssh pos-ts` / `ssh deploy@sds-pos`. Owner approved write/exec on `pos-oracle` / `sds-pos` and piping the age key from `F:` into the restore drill.
> - **Not verified:** GitHub secrets/variables (no `gh` on the laptop; owner reported them done), Tailscale key expiry on `sds-pos` (owner reported disabled), OCI Pay-As-You-Go upgrade (recommended in docs/05 §1).
> - **Open decision:** the rebuild-on-new-host test needs a second free Micro VM; ask the owner at Round 3.
> - **Design:** [Claude Design canvas](https://claude.ai/artifact/3bpHFKf3KGsAH5EMN1CE3H); polish at P3 kickoff.
> - **Local tools:** Node 24 + pnpm 12.6.0; no Docker; PGlite 0.4.x (PostgreSQL 17).
> - **Still open, not blocking:** Q3 (tax status; ภ.ง.ด.94 due 30 Sep 2026), Q11, Q12, reserved IP (before P4), ไทยช่วยไทย on room delivery, room-delivery fee.

Newest entries first. Add entries with `/checkpoint`. Each entry covers what changed, how it was verified, what was decided, and what comes next. State facts only, and never record tests as passed unless they were run.

---

## 2026-09-30 · P2 · QA review and fixes (committed, deploy pending)
- **Summary:** qa-security-reviewer reviewed P2: exit criteria not met, 1 High + 4 Medium. Fixed by backend-engineer (db/api) and devops-engineer (infra/CI/docs).
- **Changed:** TLS forced for remote DB connections (`postgresOptions`), prod config rejects `sslmode=disable`; Drizzle params scrubbed from logs/Sentry (`apps/api/src/redact.ts`), `sendDefaultPii:false`; CORS methods incl. PATCH; `seed` moved to `@sds/db/seed` (test PromptPay ID gone from the API bundle); deploy workflows now run after green CI on `main` (`workflow_run`), use the CI-verified sha, `environment: production`, actions pinned by SHA, wrangler pinned; pre-deploy backup skipped only on the true first deploy; Caddyfile change detection + security headers; Pages `_headers`; drill runs on tmpfs and fails on empty restored tables; backup heartbeat 30 min, healthchecks URL no longer logged; docs 05 §6, RUNBOOK, SETUP (H1/H2 owner hardening) updated.
- **Verification (run this session, combined tree):** `pnpm lint` 95 files clean, `pnpm build --force` 11/11, `pnpm test --force` 8/8 (api 34, db 43, shared 466, promptpay 1276, ui 36, i18n 20, web 1+1). Agent-run: shellcheck + actionlint clean, stub-docker harness 40 checks, deploy `plan` script 18 cases, Caddy headers and CSP in Chrome. **Not run:** the workflows on GitHub, anything on the VM, TLS handshake to Supabase, `run drill` on a real Docker daemon.
- **Decisions:** none recorded. Pending: `verify-full` against Supabase CA (needs a decision entry); Tailscale `check` for `ubuntu`/`deploy`; GitHub plan for environment protection.
- **Open issues:** live `DATABASE_URL` still lacks `sslmode` (code forces TLS anyway); Supabase "Enforce SSL" off; the merge-to-main auto deploy and rollback are still untried; LIFF CSP needs a real-LINE-device check in P4; F5 (least-privilege OCI key) optional.
- **Next:** owner decisions → first automatic deploy (check `/readyz` = first TLS handshake, Caddy restart blip) → rollback test → close P2.
- **Commit:** 25f0e62 (db/api), 4681e59 (web headers), 341a685 (infra/CI), 5dfa646 + this entry (docs)

## 2026-09-29 · P2 · First deploy live; restore drill passed
- **Summary:** the owner ran Deploy API and Deploy web apps (green) and set the UptimeRobot monitor. Claude verified the result from outside and on the VM, then ran the restore drill with the age key piped from the USB drive over stdin (key never printed or stored).
- **Changed:** nothing in the repo; VM now runs api, caddy and backup.
- **Verification (run this session):** `/healthz` → ok (version 33bfb96), `/readyz` → ok; cert issuer Let's Encrypt (YE1), expires 2026-12-28; from the laptop ports 22, 3000, 5432, 2019 closed; `dc ps`: api, backup, caddy all healthy; `backup-list` shows `hourly/sds-20260929T160506Z-hourly.dump.age`; both `*.pages.dev` sites return 200; restore drill: decrypted OK, pg_restore without errors, migrations restored=5 prod=5, DRILL PASSED. Weak point: the DB has no business rows yet, so the row-count comparison is all zeros.
- **Decisions:** none.
- **Open issues:** missed-backup alert not yet proven; rollback not tried; the External check and ghcr prune runs are green per the owner but not seen by Claude; missed-backup alert test deferred by the owner; the merge-to-main auto-deploy was not exercised (runs were manual); rebuild test needs a second Micro VM; UptimeRobot/Tailscale commercial terms; repeat the drill once real data exists.
- **Next:** rollback test (3.7), alert test on a later day (3.5), QA review, close P2.
- **Commit:** uncommitted

## 2026-09-29 · P2 · Setup Rounds 1–2 done; VM ready for first deploy
- **Summary:** the owner finished Round 1 (accounts, Tailscale policy + OAuth client, OCI ports/bucket/secret key, age key on USB, healthchecks.io, Cloudflare token, Supabase pooler URL, GitHub secrets/variables) and Round 2 (bootstrap, tailnet join, key expiry off, port 22 closed). Claude created `/opt/sds/.env` from the template and filled the non-secret values; the owner filled the five secrets.
- **Changed:** VM `/opt/sds/.env` (+ `.env.example`), Tailscale auto-update on; laptop `~/.ssh/config` (`pos-ts` shortcut); `age` 1.3.1 installed via winget. No repo code changed.
- **Verification (run this session):** SSH over the tailnet as `ubuntu` and `deploy` OK; swap 2G, Docker 29.8.1, iptables 80/443 open; `ssh pos-oracle` to public :22 times out; `.env` mode 600, UTF-8 without CRLF, 12 variable names present, no template placeholders left (names only, no values read). `F:` is a removable drive holding `sds-backup.agekey` (189 bytes, contents not read), no copy in the repo. Not run: anything in Round 3, GitHub secret check.
- **Decisions:** none. OCI namespace `axlbox7jjb21` is recorded in the VM `.env` (not secret).
- **Open issues:** UptimeRobot and Tailscale Personal terms for commercial use unchecked; OCI Pay-As-You-Go upgrade (idle reclaim) not confirmed; second Micro VM for the rebuild test.
- **Next:** Round 3 first deploy (SETUP 3.1–3.7).
- **Commit:** uncommitted

## 2026-09-29 · P2 · Code complete; waiting on owner setup (Round 1)
- **Summary:** API skeleton, db client split, web shells, VM bootstrap, compose stack, OCI backups, deploy workflows, SETUP.md and RUNBOOK.md written by backend-engineer and devops-engineer agents, reviewed and committed.
- **Changed:** `apps/api`, `apps/pos-web`, `apps/liff-web`, `packages/db` (postgres-js client, `@sds/db/pglite`, migration 0004), `infra/{oracle,compose,backup}`, `.github/workflows/{deploy-api,deploy-web,external-check}.yml`, `infra/SETUP.md` (+ step 2.0 SSH shortcut), `infra/RUNBOOK.md`, docs 05 §6/§7/§9, D-18.
- **Verification:** `pnpm install --frozen-lockfile`, `pnpm lint` (91 files), `pnpm build --force` 11/11, `pnpm test --force` 8/8 (api 11, db 24, shared 466, promptpay 1276, ui 36, i18n 20, web 1+1), `pnpm audit --prod` clean. Agent: shellcheck + actionlint clean, deploy/backup scripts tested with stubs. Supabase host confirmed IPv6-only → session pooler. Not run: Docker builds, anything on the VM, deploy workflows.
- **Decisions:** D-18 note (OCI-only backups). Deploy via Tailscale SSH, no deploy key in GitHub.
- **Open issues:** owner Round 1–3; rebuild test needs a second Micro VM (owner decision); sslip.io shares Let's Encrypt limits (DuckDNS fallback in RUNBOOK).
- **Next:** owner finishes SETUP.md Round 1 → Claude checks → Round 2.
- **Commit:** 277642b, a006f80, this entry

## 2026-09-29 · P1 · Closed
- **Summary:** the owner accepted the Claude Design redesign ([canvas](https://claude.ai/artifact/3bpHFKf3KGsAH5EMN1CE3H), 9 boards) as the P1 wireframes; visual polish is deferred to the P3 kickoff. All P1 exit criteria are met.
- **Changed:** P1 checkpoint (Done), P2 checkpoint (in progress), `design/brand.md` (superseded note), Q14 answer, this log.
- **Verification:** owner approval in chat; earlier checks as recorded below.
- **Decisions:** none.
- **Next:** P2 kickoff: ask the owner for all missing P2 inputs.
- **Commit:** this entry

## 2026-09-29 · P1 · Owner checks: CI green, K PLUS scan passes
- **Summary:** the owner confirmed the CI run is green. K PLUS first could not read the QR (inline SVG on the page); after switching to black-on-white PNG, both our QR and the reference library's scanned (฿1.00, amount locked). The owner asked for a complete redesign of the wireframes in Claude Design instead of approving the HTML set.
- **Changed:** `packages/promptpay/scripts/scan-test.ts` (PNG output, 010891f); P1 checkpoint exit criteria.
- **Verification:** PNG QRs decoded back to the exact payloads with jsQR before sending; owner scan in K PLUS.
- **Decisions:** none.
- **Open issues:** wireframe redesign in Claude Design, then owner approval (last P1 exit criterion).
- **Next:** finish the 9 redesigned boards → owner approval → close P1 → P2 kickoff questions.
- **Commit:** this entry

## 2026-09-29 · P1 · Foundation built (awaiting owner checks)
- **Summary:** monorepo and domain core built; Supabase advisor fixed (revoke on `rls_auto_enable`, trigger kept). Owner answers: K PLUS for the scan test; wireframes HTML-only (Figma deferred).
- **Changed:** root tooling (pnpm, Turborepo, Biome boundary rules, TS 7 strict); `packages/shared`, `promptpay`, `db`, `i18n`, `ui`; `design/` (brand + 9 wireframes, by ux-ui-designer agent); `.github/workflows/ci.yml`; `.claude/settings.json` + hooks; `infra/supabase/bootstrap.sql`; docs 03, 10, decisions, P1 checkpoint.
- **Verification:** `pnpm install --frozen-lockfile`, `pnpm lint` (62 files, clean), `pnpm build` (5/5), `pnpm test` (5/5: shared 466, promptpay 1271, db 15, i18n 20, ui 36). Supabase: advisor lints = [], RLS probe table got RLS on, anon/authenticated execute = false. Hooks tested by hand (migration/.env block → exit 2; type error → exit 2) and live (Write to `.env.hookprobe` blocked by the hook). CI run: **not verified** (no access).
- **Decisions:** D-11 note (satang = branded safe-integer `number`); D-03 note (PGlite pinned 0.4.x = PG17).
- **Open issues:** CI green unconfirmed; K PLUS scan; wireframe approval; brand.md §9 questions; React base components deferred to P3 (no app yet).
- **QA review (qa-security-reviewer):** no rule violations; M1–M4, F1 and F11 fixed afterwards (`pnpm lint` clean, `pnpm build` 5/5, `pnpm test` 5/5 with promptpay 1276 and db 20, `pnpm audit --prod` clean). Other findings carried forward in the P1 checkpoint.
- **Next:** owner checks → close P1 → P2 kickoff questions.
- **Commit:** 420cb8c, 1f318f0, ccf5d4d, 118b533, c1ffb66, 72b97e1, 2e48741; this entry uncommitted

## 2026-09-29 · P0 · P1 prerequisites confirmed
- **Summary:** connections checked and the P1 kickoff answers recorded.
  - Supabase: the old ref didn't exist, so it was replaced by `yejvrooxqdpynruwnegg`, region **Singapore** (`ap-southeast-1`). The MCP sign-in is still refused on reconnect.
  - pnpm 12.6.0 installed. Claude may commit and push to `main`. Hooks are allowed in the shared `.claude/settings.json`.
  - PromptPay scan test: **1 bank app** for now.
  - Wireframes are delivered in **both** `design/` HTML and Figma.
  - **New A4 sub-requirement:** per-device (iPad / iPhone / laptop) mockups and independently adjustable customization.
- **Changed:** `.mcp.json`; 01 (N-row, A4), 04 §2.4, 09 P1 row, P1 checkpoint scope + exit criteria, 10 (answers).
- **Verification:** `git ls-remote origin` OK (repo empty); VM :22 open, :80/:443 closed; project REST → 401 (up, key required); DB IPv6 matched AWS ranges → ap-southeast-1; `pnpm -v` → 12.6.0; Supabase MCP → "needs authentication".
- **Decisions:** none (requirements only).
- **Open issues:** Supabase MCP re-auth (needed by P2); which bank app to test with (owner's choice).
- **Next:** push, then P1 kickoff: monorepo scaffold.
- **Commit:** a0c2fc2, d42097b, plus the docs commit that adds this entry

## 2026-09-29 · P0 · Owner answers recorded; ready for P1
- **Summary:** the owner answered the P1-blocking questions:
  - **Payment:** the customer sends the slip via LINE (or shows it) and the owner confirms by hand.
  - **LINE fulfilment:** pickup + condo-room delivery, with returning customers remembered. LINE payment methods: PromptPay, ไทยช่วยไทย (pickup only until the terms confirm delivery), cash.
  - **Stack:** accepted. **Repo:** private.
  - **Menu:** placeholders, fully editable.
  - **Branding:** designer proposes; must stay customizable.
  - **Staff and hours:** the owner is the only staff member; storefront 11:00–23:00, delivery 13:00–23:00, adjustable per day.
  - **Test banks:** K PLUS + Krungthai NEXT (PromptPay 0642230924 is a personal test account; the real shop account comes later).
- **Changed:**
  - `10-open-questions.md` (answers + branding + banks);
  - `01-requirements.md`: new A3 opening hours, A4 customizable look, L2a returning customers; assumptions A1/A3/A5/A6;
  - `decisions.md`: D-01/02/03/05 Accepted, D-03 adds PGlite for local dev, D-08 pickup-only note;
  - P1 exit criterion and roadmap row now use 2 bank apps.
- **Verification:** docs only; no code written.
- **Next:** in a new session, the owner says go → P1 kickoff (confirm commit permission first).
- **Commit:** uncommitted

## 2026-09-29 · P0 · VM network details recorded
- **Summary:** from the owner's screenshots:
  - public IP 138.2.67.89 is **ephemeral** (`publicip20260928193828`);
  - private IP 10.0.0.43, subnet `subnet-20260929-0215`, no network security groups (the subnet security list controls ingress).
- **Changed:** `infra/oracle/README.md`; 05 §6 checklist (reserved-IP decision before P4).
- **Commit:** uncommitted

## 2026-09-29 · P0 · Ingress decided: Caddy on a free hostname (no domain for now)
- **Decision:** D-10 Accepted (interim).
  - The API is served by Caddy + Let's Encrypt on a free sslip.io hostname, with only ports 80/443 open on the VM.
  - Web apps on Cloudflare Pages (`*.pages.dev`).
  - A named Tunnel + domain remains the target later.
- **Changed:** decisions D-10, requirements N4, architecture note, 05 §5–6, devops agent, P2 checkpoint, roadmap P2 row.
- **Open issues:** check whether the VM's public IP is ephemeral or reserved, because the hostname contains it.
- **Commit:** uncommitted

## 2026-09-29 · P0 · Cloudflare account noted; no-domain options
- **Summary:** the owner has a Cloudflare account with the workers.dev subdomain `omeza25482548` (existing Worker `claude-writer`, unrelated to the POS). The no-domain hosting options are written up in 05 §5 (pages.dev for the web apps; Workers VPC (beta) or Caddy on a free hostname for the API).
- **Open issues:** owner to choose between buying a domain (recommended) and a no-domain option. Workers VPC WebSocket support is unverified.
- **Commit:** uncommitted

## 2026-09-29 · P0 · Supabase MCP server added
- **Summary:** the owner created a Supabase project (ref `msxzudufpewhdramjihv`) for Path B, and the Supabase MCP server was added at project scope (`.mcp.json`) with features docs, account, database, debugging, development, functions and branching. It is **not read-only**.
- **Verification:** `claude mcp add` reported success and `.mcp.json` contains the entry. Authentication (OAuth) happens on first use and has not been done yet.
- **Open issues:** confirm the Supabase project's region (Singapore recommended, next to the VM). Database-changing MCP actions need owner approval, especially once real data exists.
- **Commit:** uncommitted

## 2026-09-29 · P0 · SSH key moved out of the repo
- **Summary:** moved `ssh-key-2026-09-28.key` and `.key.pub` from the repo root to `%USERPROFILE%\.ssh\`.
- **Verification:**
  - the private key was copied, its SHA-256 hash matched the original, the copy was set to owner read-only, and then the original was deleted (it was read-only, so a direct move was refused);
  - `ssh-keygen -l` reads it (RSA 2048);
  - the repo no longer contains either file.
- **Changed:** key path updated in `CLAUDE.md`, `infra/oracle/README.md`, 05 §6 and the devops agent.
- **Next:** owner answers Q2–Q12 → start P1.
- **Commit:** uncommitted

## 2026-09-29 · P0 · VM details recorded; native apps deferred
- **Summary:** the owner shared the OCI console details. The VM is **VM.Standard.E2.1.Micro** (1 GB RAM), **ap-singapore-1**, Ubuntu 24.04, user `ubuntu`, IP 138.2.67.89, on a **Free Tier** account (not PAYG). Native apps are deferred until the owner buys a MacBook.
- **Changed:**
  - new `infra/oracle/README.md` (VM record, no secrets);
  - Q1 and Q13 answered;
  - D-03 and D-10 → Path B (Supabase free in Singapore for Postgres; the VM runs the stateless api/backup/cloudflared);
  - D-19 marked deferred;
  - A4 confirmed; 05 §6 status and checklist; R1 updated for Free Tier.
- **Verification:** docs only; facts taken from the owner's screenshots. No SSH connection was made.
- **Decisions:** D-03 and D-10 moved from Open to Proposed (Path B). D-19 deferred.
- **Open issues:** Free Tier idle-reclamation risk (PAYG still recommended, owner's call); Q2–Q12 still open.
- **Next:** owner answers Q2–Q12 → start P1.
- **Commit:** uncommitted

## 2026-09-29 · P0 · VM exists, browser targets, native-apps plan
- **Summary:** the owner reported that the Oracle VM is set up, with its SSH key pair in the repo folder. Staff will use Safari on iPad/iPhone and standard browsers on computers. Native installable apps (iPad, iPhone, Windows, macOS, Linux) are wanted later.
- **Changed:**
  - added `.gitignore` for keys and `.env*`;
  - added D-19 (web-first → Capacitor for iOS / Electron for desktop), with status notes on D-03, D-10 and D-15;
  - added requirement X4 and NFR N11;
  - architecture §12 (Safari specifics, seams built now, native shells);
  - infrastructure: key handling in §6 and native distribution in §12;
  - L13–L14, R14–R15; skills rows; roadmap P10;
  - new `checkpoints/PHASE-10-native-apps.md`; Q1 updated, Q13 added;
  - `CLAUDE.md` rule 11 (private keys) and client targets;
  - agents: devops key rule, pos-frontend Safari/platform rules, qa-security-reviewer made truly read-only (removed `memory`).
- **Verification:**
  - `git check-ignore` shows both key files ignored; `git status` lists only `.claude/`, `.gitignore`, `CLAUDE.md` and `docs/`. The key contents were not opened or printed.
  - Link and anchor check: 32 markdown files, no problems.
  - Frontmatter check (PyYAML): 7 agents + 1 skill parse, 0 problems.
- **Decisions:** D-19 added as Proposed (depends on Q13). D-03 and D-10 stay Open until the VM's shape is known.
- **Open issues:** VM public IP and login user needed for read-only inspection (Q1). Recommend moving the key to `~/.ssh/` (owner's call).
- **Next:** owner answers Q1–Q13 → close Path A/B → start P1.
- **Commit:** uncommitted

## 2026-09-29 · P0 · Planning pack created
- **Summary:** researched constraints (LINE, PromptPay, ไทยช่วยไทย พลัส, Oracle and other free tiers, Thai tax, PDPA) and wrote the planning docs. No application code yet.
- **Files added:**
  - `CLAUDE.md`
  - `docs/01`–`10`, `docs/decisions.md`, `docs/PROGRESS.md`
  - `docs/checkpoints/PHASE-00`–`09`
  - `.claude/agents/` (7 agents), `.claude/skills/checkpoint/`
- **Key findings:**
  - The ไทยช่วยไทย QR is made per transaction and scanned at the storefront → LINE customers pay at the storefront (CR1).
  - The scheme's additional round runs 1 Oct – 30 Nov 2026, so the method is generic and configurable.
  - LINE's free plan counts 300 push messages a month; replies are free → reply-first design.
  - LINE Notify has ended.
  - Grab / LINE MAN have no API for small merchants.
  - Oracle A1 Always Free is now 2 OCPU / 12 GB and idle VMs can be reclaimed → upgrade to PAYG.
- **Verification:** docs only. Sources are linked in 04, 05 and 06.
- **Decisions:** D-01…D-18 recorded. D-07 is Accepted; D-03 and D-10 are Open (Q1); the rest are Proposed.
- **Next:** the owner answers Q1–Q12 → update decisions → start P1.
