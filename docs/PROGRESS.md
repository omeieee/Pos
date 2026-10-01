# Progress Log

**Current phase:** P3 — Storefront POS ([checkpoint](checkpoints/PHASE-03-storefront-pos.md)), status **in progress: backend (auth, devices, staff, orders, settings, menu) and the staff-app sign-in foundation are built; the payment routes, realtime, order-entry screens and offline outbox remain. No owner account exists yet.**
**Previous:** P2 — Cloud skeleton ✅ Done 2026-10-01 ([checkpoint](checkpoints/PHASE-02-cloud-skeleton.md)); its criterion 6 (rebuild test, Pay-As-You-Go console check) is carried to P5. P1 — Foundation ✅ Done 2026-09-29.

> **Handoff for the next session (read first):**
> - **Live now (verified 2026-10-02 03:50 Bangkok):** API `https://138-2-67-89.sslip.io` runs commit 6c30c89 (everything below under "P3 state" except the payment routes, realtime and the order screens; migrations 0000–0009 applied, 10 in total; 0 owners, 0 staff, 0 orders, no menu or settings rows). `/healthz` ok, `/readyz` 200, every protected `/v1` route (including `/v1/settings/*` and `/v1/devices`) answers 401 without a session, the public `GET /v1/menu?channel=storefront` returns an empty menu. Containers api, backup, caddy healthy (api 61 MB of 512 MB, 0 errors); a pre-deploy backup ran with the deploy; rollback target is the previous image, but see the rollback floor. The staff app on `sds-pos.pages.dev` is the sign-in foundation (it cannot be used until the owner account exists); `sds-order.pages.dev` is still the P2 shell. Hourly backups run; the healthchecks.io check `sds-backup` was proven by a real DOWN/UP on 2026-10-01.
> - **P3 state (2026-10-02, early morning):** DEPLOYED (4250cff): auth, devices, staff routes, orders, QA fixes A–I, staff-app sign-in foundation. BUILT AND MERGED ON LOCAL `main` (HEAD c52fcd9), push status below: staff-app review fixes (lock countdown, dialog focus, duplicate taps, Enter key, autofill), the pure cash and ไทยช่วยไทย logic in `packages/shared`, CORS maxAge, migration 0009 (13 foreign-key indexes), the settings API (shop, opening hours, numbering, payments, PromptPay ID with owner + step-up + audit + critical alert + masked value, co-pay scheme) and the menu API (public `GET /v1/menu?channel=`, CRUD, sold-out toggle; a placeholder "(ตัวอย่าง)" menu exists only in the seed, so production's menu is empty until entered). Counts on c52fcd9: lint 224 files clean, build 11/11, tests api 414, shared 734, db 96, pos-web 150, promptpay 1276, ui 36, i18n 20, liff-web 1. NOT STARTED: payment routes (task 5 API: cash, signed PromptPay QR PNG, co-pay flow, claim/confirm/change-method/void/refund, with the cancel-vs-payments rule), realtime (6: `/v1/ws` with the device token in the first message, `/v1/sync` with column allow-lists), order entry, order board, kitchen view, payment, menu and settings screens (7), offline outbox (8), Grab/LINE MAN manual entry (9), Playwright E2E + real-device Safari (10). **Rollback floor:** once an owner exists, do not roll back below aba5301 (recovery codes are plain SHA-256 from there on).
> - **Push status: NOTHING UNPUSHED.** `origin/main` = 6c30c89 = deployed. The qa-security-reviewer verdict on the last batch (settings, menu, indexes, UI fixes) was OK to push with no Blocker or High; its Medium items are carried forward below.
> - **QA carry-forward (Medium; fix before the feature each one touches):** (1) menu POSTs are not idempotent (CLAUDE.md rule 6): add an optional `clientRequestId` or record an exception, before the menu editor; (2) a deactivated category hides its items but `POST /v1/orders` still sells them: add the category `active` check in the pricing lookup in `packages/db/src/orders.ts`; (3) a required modifier group with every option sold out leaves the item visible but impossible to order (`GROUP_TOO_FEW`): drop such items in `publicMenu`; (4) the `settings.updated` event carries the full PromptPay ID: the realtime fan-out must send it only to sessions with `settings.view`; (5) the QR must refetch the PromptPay ID each time it is shown (or invalidate on `settings.updated`). Low: national-ID mod-11 checksum, require `storefront` when enabling co-pay, a no-op group PATCH bumps the version (`archivedAt: undefined`), `numbering` editable by a manager without step-up, archived rows still readable via `GET /items/:id` and `createOption`, order-numbering letter/padding settings do not exist.
> - **NEXT STEPS for a new session, in order:** (1) settle the push status above. (2) Owner prerequisites before the first owner account (see "Owner actions pending"), then the owner runs RUNBOOK "Create the first owner account" in a real terminal; until then no one can sign in. (3) Decide the four D-05 items (router with params, server-state cache, IndexedDB layer, app-shell service worker; see the D-05 status note in `docs/decisions.md`) before order entry. (4) Build, in this order: payment routes (backend-engineer + payments-finance-engineer; the pure logic exists), realtime (6), then the order-entry, board, kitchen and payment screens (7) against `GET /v1/menu` and the order routes, then the offline outbox (8), manual Grab/LINE MAN entry (9), E2E and a real-device Safari pass (10), then the phase-end qa-security-reviewer and `/checkpoint`. (5) P3 exit criteria are in the P3 checkpoint; the owner times the 20-second order test on the real iPad.
> - **How the work was run (reuse it):** fresh agents with a written brief per slice (backend-engineer, pos-frontend-engineer, payments-finance-engineer), each in its own git worktree (`isolation: "worktree"`, directories kept separate), tests first, local commits only. The main session then: `git -C .claude/worktrees/agent-<id> rebase main` and `git merge --ff-only worktree-agent-<id>`; `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm build --force`; `pnpm test --force` (one heavy command at a time: the laptop is short of memory, close Roblox/Chrome); qa-security-reviewer on `git diff <deployed sha>..HEAD`; push only after OK (main auto-deploys: new env vars go into the VM `.env` first, migrations are the next free number, additive only, `0000`–`0009` already applied); poll `https://138-2-67-89.sslip.io/healthz` for the new sha; verify on the VM and in Supabase. Old agent worktrees under `.claude/worktrees/` are already merged: start new agents from `main`. Scratchpad scripts vanish with the session; the Gmail MCP (`gmail`, read-only) reads the alert inbox in a new session (sign-in expires every 7 days).
> - **Standing authorization (owner, 2026-10-01):** proceed automatically using the documented defaults (`docs/10-open-questions.md`); push to `main` automatically after a qa-security-reviewer pass (`main` auto-deploys, so new env vars go into the VM `.env` first, migrations are `0006+` only); browser automation of Chrome is allowed. Still off-limits: anything that costs money, signing in anywhere with a code read from the owner's inbox, and the CLAUDE.md hard rules.
> - **Owner actions pending (all five before `owner:create`):** (1) store an offline copy of `AUTH_SECRET_KEY` next to the age key (`ssh deploy@sds-pos 'grep ^AUTH_SECRET_KEY /opt/sds/.env'`); (2) create the Sentry project and give Claude the DSN to put into the VM `.env` (`SENTRY_DSN` is **empty** today, so security alerts only reach the server log); (3) in Sentry, add an alert rule that fires on every event tagged `alert`; (4) set the Oracle budget alert (about US$1); (5) rotate the Gmail OAuth client secret (it appeared in chat) and update `~/.gmail-mcp/gcp-oauth.keys.json`. Also: say whether the shop is registered in ถุงเงิน for the 1 Oct – 30 Nov round (the scheme is seeded disabled, with the owner's figures); the real shop PromptPay ID when available. Then create the owner: RUNBOOK "Create the first owner account" (it needs a real terminal).
> - **Pending owner decisions:** keep Tailscale `accept` (owner wants no prompts; SETUP.md now suggests `check` for the `ubuntu`/`deploy` rule and the live policy is unchanged); GitHub plan for environment protection (paid on private repos; the four secrets stay repo-level for now); Actions-minutes cost of the extra plan/web jobs on every green push; `verify-full` against the Supabase CA (needs a `docs/decisions.md` entry); optional least-privilege OCI backup key (SETUP H2).
> - **VM state (verified 2026-10-01 17:56):** Ubuntu 24.04 (system clock UTC), 2 GB swap, Docker 29.8.1, `deploy` user (no sudo; user cron works), Tailscale `sds-pos` (SSH on, tag:server, auto-update on), public port 22 closed, `/opt/sds/.env` complete (mode 600) and now including `AUTH_SECRET_KEY` (generated on the VM, never printed). Harmless leftovers in `/home/deploy`: `alert-test-restart.sh` and its `.log`. Reach it with `ssh pos-ts` / `ssh deploy@sds-pos`. The owner approved write/exec on `pos-oracle` / `sds-pos` and piping the age key from the USB drive (`F:` on the laptop, `/f/sds-backup.agekey` in Git Bash) into the restore drill. scrypt on the VM (measured in the api container): password hash 0.4–0.7 s, PIN hash 0.1 s, four password hashes in parallel 2.5 s with a 205 MB peak in the benchmark process.
> - **Not verified:** GitHub secrets/variables and the `production` environment behaviour on a private free repo (if a deploy errors on it, remove the `environment: production` line in both deploy workflows); Tailscale key expiry on `sds-pos` (owner reported disabled); Oracle Pay-As-You-Go (owner-reported; budget alert unconfirmed; docs/05 §3.1); Cloudflare Pages usage; order numbering and the auth locks under real Postgres concurrency (the tests run on PGlite, which serialises); `owner:create` in a real terminal and in Docker.
> - **Laptop notes:** Gmail MCP (`@klodr/gmail-mcp@1.4.2`, read-only scope) registered at user scope as `gmail` on 2026-10-01, tested by reading one subject; OAuth key and token files live in `~/.gmail-mcp/` (outside the repo, never commit). The Google app is in Testing mode, so the sign-in expires every 7 days: re-run `npx -y @klodr/gmail-mcp@1.4.2 auth --scopes=gmail.readonly`. `age` 1.3.1 installed via winget (call winget by full path in this shell); the `pos-ts` SSH shortcut exists in `~/.ssh/config`. shellcheck and actionlint are not installed (scratchpad copies vanish with the session).
> - **Design:** [Claude Design canvas](https://claude.ai/artifact/3bpHFKf3KGsAH5EMN1CE3H); polish at P3 kickoff.
> - **Local tools:** Node 24 + pnpm 12.6.0; no Docker; PGlite 0.4.x (PostgreSQL 17).
> - **Still open, not blocking:** Q3 beyond the filed ภ.ง.ด.94 (individual or company, VAT, accountant keep their defaults), Q11, Q12, reserved IP (before P4), ไทยช่วยไทย on room delivery, room-delivery fee.

Newest entries first. Add entries with `/checkpoint`. Each entry covers what changed, how it was verified, what was decided, and what comes next. State facts only, and never record tests as passed unless they were run.

---

## 2026-10-02 · P3 · Settings, menu API, indexes and staff-app fixes deployed (6c30c89)
- **Summary:** three review rounds this session ended with every batch pushed and deployed. Batch 2 (aba5301, 4250cff): QA fixes A–I, device and staff routes, rate-limit fix N1, staff-app sign-in foundation. Batch 3 (6c30c89): CORS maxAge, migration 0009 (13 foreign-key indexes), settings API (PromptPay ID, co-pay scheme, hours, numbering), menu API, six staff-app fixes.
- **Verification (run this session):** on merged main before each push: lint clean (224 files at the last push), `pnpm build` 11/11, `pnpm test` 8/8 (api 414, shared 734, db 96, pos-web 150, promptpay 1276, ui 36, i18n 20, liff-web 1); qa-security-reviewer verdicts OK to push each time (N1 High fixed before batch 2; none at batch 3). After the push: live `/healthz` 6c30c89, `/readyz` 200, protected routes 401, public menu empty 200, Supabase 10 migrations / 0 owners / 0 orders, API 61 MB, pre-deploy backup object, 0 API errors. Not run: E2E, real-device Safari, `owner:create` in a terminal, real-Postgres concurrency.
- **Decisions:** D-17 amendments and the D-05 tooling note written as Proposed (no decision accepted by the owner yet).
- **Open issues:** the five owner prerequisites before `owner:create`; the QA carry-forward above; the four D-05 items before order entry.
- **Next:** see NEXT STEPS in the handoff.
- **Commit:** 6c30c89 (pushed); this entry and the handoff edits are uncommitted until the next push.

## 2026-10-01 · P2/P3 · P2 closed; auth and orders deployed (inert)
- **Summary:** the missed-backup alert was proven by a real miss (DOWN 16:35:04, UP 17:00:12 Bangkok), so P2 is closed with criterion 6 carried to P5 (owner-authorized). The first P3 backend slice (device registration, staff PIN, owner password + TOTP, step-up, RBAC guard, sessions; idempotent orders with server-side pricing and daily numbering) was reviewed by qa-security-reviewer (OK to push after named fixes), pushed and deployed.
- **Changed:** `apps/api`, `packages/db` (migration 0005), `packages/shared` (auth, orders, pricing); compose passes `AUTH_SECRET_KEY`; docs 04, 05 (Pay-As-You-Go rules), 07, 10, P2/P3/P5 checkpoints, SETUP, RUNBOOK.
- **Verification (run this session):** merged main: `pnpm lint` 134 files clean, `pnpm build` 11/11, `pnpm test` 8/8 (shared 527, db 67, api 233, promptpay 1276, ui 36, i18n 20, web 1+1); new compose validated with `docker compose config -q` against the VM `.env`; push 17:53; live `/healthz` version fadca14 at 17:55; `/readyz` 200; `/v1/auth/me`, `/v1/orders`, `/v1/auth/staff` 401, garbage `POST /v1/auth/owner` 400; pre-deploy backup object created 17:55; Supabase: 6 migrations, RLS on `sessions` and `owner_credentials`, 0 rows, 11 MB. Not run: E2E, real-device Safari, `owner:create` in a terminal, real-Postgres concurrency.
- **Decisions:** none recorded in `decisions.md`. To write as Proposed amendments to D-17: step-up factor follows the role (owner: password + TOTP or recovery code; others: PIN), signing in does not count as step-up, PINs are peppered with a key derived from `AUTH_SECRET_KEY`, TOTP window plus/minus one step. The 5-try lock and the session timings are in the agent report (PIN session 12 h / idle 2 h, owner 8 h / idle 30 min, step-up 5 min).
- **Open issues:** the QA must-fix list (see the handoff) before `owner:create`; owner alerts reach only the log until Sentry forwarding (D) and ntfy (P8); `AUTH_SECRET_KEY` has no offline copy yet; Oracle budget alert and Gmail secret rotation are the owner's.
- **Next:** finish the stopped backend agent's follow-ups with a QA re-review; then payments (task 5), realtime (6) and the staff UI (7) with the pos-frontend and payments agents in separate directories.
- **Commit:** fadca14 (pushed to origin/main); this entry and the P2/P5 checkpoint edits are uncommitted.


## 2026-10-01 · P2 · Alert test run 2: Down detected, Down email missing
- **Summary:** repeated the missed-backup test at a better time (empty database, so safe in the afternoon): stopped `backup` 13:57:52 Bangkok, restart armed on the VM for 14:55 and watched the Gmail alert inbox through the new Gmail MCP (subjects and dates only; one Up email body read, URLs removed).
- **Verification (run this session):** the restart log shows `backup hourly` OK at 14:55:09 and the cron line removed; at 14:59 `backup` healthy, crontab empty, `/readyz` 200. Inbox: one new healthchecks.io mail, `UP | My First Check`, 14:55:15 Bangkok. Its body: schedule `5 0,5,10-23 * * *` Asia/Bangkok, downtime 5 min 10 s, status up at 14:55:13, last ping from the VM IP, ping body = our backup line. Searches `in:anywhere from:healthchecks.io after:<stop>` and `subject:DOWN` found no Down mail. Not seen: the check's page (grace, Log, Integrations).
- **Findings:** (1) the VM pings the default-named check "My First Check", not `sds-backup`; (2) grace is about 45 min, not 30; (3) healthchecks.io detected the miss and recovery, but the Down email did not reach the inbox, so "a missed run raises an alert" is still not demonstrated; (4) run 1 (restart at 05:50 = slot + 45 min) was too early to see a Down.
- **Decisions:** none. **Commit:** uncommitted.
- **Next:** owner reports the check's Log, Integrations and grace (see handoff); fix; criterion 3 is ticked only when a Down email is received.

## 2026-10-01 · P2 · Alert inbox searched: no Down/Up email, alert not proven
- **Summary:** with the owner's yes, Claude searched the Gmail alert inbox through the new read-only Gmail MCP for the healthchecks.io emails of the alert test (subjects and dates only, no bodies).
- **Verification (run this session):** `in:anywhere from:healthchecks.io newer_than:4d` returned 3 messages: Monthly Report (1 Oct 03:50 UTC), Log in (29 Sep), Confirmation code (29 Sep); `in:anywhere sds-backup newer_than:4d` returned none. No Down (expected ~22:35 UTC on 30 Sep) or Up (~22:50 UTC) email. On the VM, 0 healthchecks ping-failure warnings in 24 h and the ping host is `hc-ping.com`, so the pings reach healthchecks.io. Not seen: the check's own page (schedule, grace, log, integrations).
- **Interpretation (unconfirmed):** the check likely differs from SETUP 1.7 (for example a default 1 day + 1 hour period, so it never went Down), or the email integration is not attached or verified, or alerts go to another address. A real missed backup might therefore not alert within 30 minutes.
- **Decisions:** none. **Commit:** uncommitted.
- **Next:** owner compares the check with SETUP 1.7 and sends what it shows; fix; repeat the stop/restart test; only then tick the alert criterion.

## 2026-10-01 · P2 · Alert-test restart verified; Gmail MCP set up on the laptop
- **Summary:** the armed restart worked, so backups are running again. Separately, at the owner's request, a read-only Gmail MCP server was set up on the laptop, which could also read the alert emails (not done yet; needs the owner's yes).
- **Changed:** no repo code. Laptop: `~/.gmail-mcp/` (OAuth key file, token file), user-scope MCP server `gmail`. Docs: PROGRESS handoff.
- **Verification (run this session):** at 13:42 Bangkok, `alert-test-restart.log` shows restart 05:50, `backup nightly` OK (daily + monthly), cron line removed; `dc ps` backup healthy 8 h; hourly runs OK 10:05–13:05; `/readyz` 200. Gmail: sign-in completed with scope `gmail.readonly`; `claude mcp get gmail` Connected; over stdio the server lists 11 read-only tools; `search_emails in:inbox` returned the latest subject. The package named in the request does not exist on npm (404), so `@klodr/gmail-mcp@1.4.2` was used after checking its metadata, provenance and bundle (no install scripts; only Google hosts besides localhost and the npm registry).
- **Decisions:** none in decisions.md.
- **Open issues:** alert criterion (healthchecks Down ~05:35 / Up ~05:50 emails) still unconfirmed; PAYG console check; P2 closing decision. The Gmail OAuth client secret was pasted in chat, so it should be rotated in Google Cloud Console (then update `~/.gmail-mcp/gcp-oauth.keys.json`).
- **Next:** with the owner's yes, search the alert inbox narrowly for the two healthchecks.io emails (subjects and times only); then the P3 kickoff question list.
- **Commit:** uncommitted

## 2026-10-01 · P2 · DB TLS verified; missed-backup alert test started
- **Summary:** the owner sent Oracle's "order processed, subscription updated" email and asked Claude to proceed itself. The VM status check that the classifier had denied earlier was allowed on retry. Claude verified the TLS change, recreated `api`/`backup` and started the alert test with a restart armed on the VM.
- **Changed:** VM only (repo unchanged): `api` and `backup` recreated 00:21 Bangkok; `backup` stopped 00:22; `/home/deploy/alert-test-restart.sh` (mode 700) plus one cron line for `deploy`, which restarts `backup` at 05:50 Bangkok, runs `backup nightly` and removes itself.
- **Verification (run this session):** found `.env` had `sslmode=require` but the 17-hour-old containers did not (in-container count 0); the 00:05 scheduled hourly backup ended `OK in 2s` on the old env; a one-shot `backup hourly` on the new env ended `OK in 4s` (object uploaded); after `up -d --wait api backup` both containers healthy, in-container count 1/1, `/readyz` 200, `/healthz` version 2e76581. Script `bash -n` OK; crontab shows the one line; `backup` shows `Exited (137)` (SIGKILL after the stop timeout, as expected for a bash PID 1). Not verified: Supabase "Enforce SSL" itself (owner-reported; a dashboard setting Claude cannot see), the healthchecks.io state, any email, that the 05:50 cron will fire.
- **Decisions:** none.
- **Open issues:** alert criterion stays unticked until the owner confirms the Down (~05:35) and Up (~05:50) emails; backups are off until 05:50 (empty DB, so no data at risk); the 05:05 nightly (incl. October monthly) is replaced by the manual `backup nightly` at 05:50; PAYG not confirmed in the console; P2 closing decision open.
- **Next:** read `/home/deploy/alert-test-restart.log`, get the owner's email report, tick criteria 3 and (after the owner checks Billing) the PAYG half of 6, then the closing decision.
- **Commit:** uncommitted

## 2026-10-01 · P2 · Owner answers recorded; alert test handed to the owner
- **Summary:** the owner's answers to the P2 to-do list are recorded. Claude tried a read-only SSH status check of the VM; the auto-mode classifier denied it ("Production Reads"), so no VM work was done and the alert test and SSL check go to the owner.
- **Owner-reported (not seen by Claude):** the Actions tab confirms auto-deploy on merge for 2e76581; `?sslmode=require` added to the live `DATABASE_URL` and Supabase "Enforce SSL" turned on; Oracle Pay-As-You-Go upgrade requested, awaiting confirmation; the second-VM rebuild test is deferred; "proceed with the alert test" (the reply also offered "defer" as an alternative; read as proceed).
- **Changed:** docs only (PROGRESS handoff, P2 checkpoint: criteria 2 and 5 ticked, SSL note, log).
- **Verification:** repo files read, nothing run on the VM. `DATABASE_URL` reaches both `api` and `backup` (`docker-compose.yml`); `predeploy` backups send no healthchecks ping (`backup.sh`); `deploy.sh:141` runs `up -d` on all services, so a deploy restarts a stopped `backup`; RUNBOOK "Oracle instance lost" documents the rebuild (step estimates sum to ~70 min; never run end to end). Laptop clock 2026-10-01 00:05 Bangkok.
- **Decisions:** none in decisions.md; the owner deferred the rebuild test (process choice).
- **Open issues:** alert test not run; SSL change unverified, including whether `api`/`backup` were recreated after the `.env` edit (SETUP 1.9 order: edit → `dc up -d api backup` → checks → Enforce SSL; the code forces TLS, so stale containers should still connect); "idle-reclamation rebuild tested" cannot be met without a second VM; PAYG unconfirmed; web-apps run not separately confirmed as `workflow_run`.
- **Next:** owner runs the alert test and the SSL checks, then decides how to close P2.
- **Commit:** uncommitted

## 2026-09-30 · P2 · QA fixes deployed; rollback tried once
- **Summary:** the pushed QA fixes (2e76581) reached production through the new CI-gated pipeline; the RUNBOOK rollback (option A, on the VM) was then run once and reverted.
- **Changed:** production only (API image 2e76581; backup image src-49765dfc; Caddy config reloaded). No repo change.
- **Verification (run this session):** `/healthz` version 2e76581; `/readyz` 200 (~94 ms) with TLS now forced (inferred: the client refuses a non-TLS server; not inspected on the wire); response headers `Cache-Control: no-store` and the API CSP live; `/opt/sds/.caddyfile.sha256` written; api/backup/caddy healthy; a `predeploy/` dump exists in the bucket (mandatory pre-deploy backup ran); both `*.pages.dev` return 200 with CSP/nosniff/referrer headers and no `__API_HOST__` left. Rollback: `deploy.sh rollback` → `/healthz` 33bfb96, `/readyz` 200; then state restored from a saved copy and the API recreated on 2e76581 (healthz 2e76581, readyz 200, `.deploy-state` identical to before).
- **Decisions:** none.
- **Open issues:** not confirmed that the deploy was started by the `workflow_run` trigger (repo is private; owner has not confirmed the Actions run) so "merge deploys automatically" stays unticked; rollback option B (workflow, older sha) not tried; missed-backup alert deferred; rebuild on a second Micro VM and free-tier/idle-reclaim check not done; live `DATABASE_URL` has no `sslmode` and Supabase "Enforce SSL" is off (owner); Tailscale `check` vs `accept` decision pending.
- **Restore drill on tmpfs (2026-09-30 07:10, key piped from USB over stdin):** DRILL PASSED on `predeploy/sds-20260929T235536Z-predeploy.dump.age` (so the pre-deploy backup is restorable), migrations 5=5, tables all empty in both (no business data yet, so the empty-table check is untested); VM memory during the drill: peak used 581 MB, min available 372 MB, peak swap 76 MB, API stayed healthy. Repeat once real data exists.
- **Next:** owner confirms the Actions runs; alert test; decide the second VM; then close P2.
- **Commit:** uncommitted (docs only)

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
