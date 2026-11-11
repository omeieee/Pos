# Phase 8 — Kitchen Printing and Phone Alerts

**Status:** 🟡 In progress (started 2026-10-22; built and deployed, inactive until keys and printer) · **Depends on:** P5; XP-80T bought, a Windows 11 notebook as print host (D-37, no Mini PC) · **Agents:** backend-engineer, devops-engineer, ux-ui-designer

## Goal
Every order, whatever its source (LINE, storefront, Grab, LINE MAN), prints in the kitchen and rings staff phones.

## Scope
- **In:**
  - phone alerts: **Web Push built** instead of self-hosted ntfy (D-37, owner to confirm); no thumbnail; click-through to the order;
  - `apps/print-agent` on a Windows 11 notebook, polling the API (D-37, replaces the Mini PC and WSS);
  - `packages/escpos` raster rendering of Thai tickets;
  - `print_jobs` queue with retries and reprint;
  - printer on a fixed IP;
  - UPS optional (jobs wait on the server).
- **Out:** customer receipts (optional stretch), local hub (P9).

## Exit criteria
- [ ] Orders from all four sources print within 3 s with correct Thai text, source badge and order number
- [ ] Printer off or out of paper → job retries and staff are alerted; a reprint gives exactly one copy
- [ ] Notebook restart or power loss → agent recovers with no duplicate prints (code and tests done; not tried on Windows)
- [ ] Phone alert arrives on the kitchen phone(s) with no customer personal data in it (Web Push replaces ntfy; code and tests done, not tried on a real phone; the VAPID pair was generated 2026-11-11 but has not been copied to the VM `.env` yet, so the live alerts screen still reports no push config)

## As built
Slices 1-3 built 2026-10-22, **uncommitted, not deployed, no real printer yet** (rows in `ARCHITECTURE.md`):
- **Queue (slice 1):** `print_jobs` (migration 0040); `GET|PATCH /v1/settings/printing` (`settings.view` / `settings.edit`, default off); `POST /v1/print/claim`, `POST /v1/print/jobs/:id/ack` (guard: non-revoked `print_agent` device token), `GET /v1/print/jobs`, `POST /v1/orders/:id/reprint` (`order.create`); event `order.sent_to_kitchen` (on entering `preparing`); schemas and ticket builder in `packages/shared/src/print.ts`.
- **Drawing and agent (slice 2):** `packages/escpos` (fontkit + bundled Sarabun, own scanline filler, `renderTicket`; `576` dots confirmed on the real XP-80T 2026-10-27); `apps/print-agent` (claim, render, Windows USB `PRINTER_HOST=usb` via `usbprint.sys` or LAN TCP 9100, ack; printed-ids file; `--test-print`; `--setup` interactive owner sign-in + `print_agent` device registration + `.env` writer; windowless Windows launcher `windows/SaapDonSenPrintAgent.cs` -> `dist/SaapDonSenPrintAgent.exe` with Desktop/Startup shortcuts and `SaapDonSenPrintAgent` Scheduled Task; README for Windows).
- **Phone alerts (slice 4):** `push_subscriptions` (migration 0041); `GET /v1/push/config`, `GET|PUT|DELETE /v1/push/subscription`; `apps/api/src/push/` sends on `alert.new_order`; VAPID env `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`; pos-web `#/alerts` screen, `platform/push.ts`, `public/push-sw.js`.
- **Pay-first (D-38 to D-42, built 2026-10-25):** committed; merged with `main` (A1, D-44) on `claude/compassionate-franklin-gaz2oh` at `e606513`, not on `main`, not deployed. Migrations 0043-0044; unpaid-timeout job, chat-slip allocation, late-slip keeper, payment pop-up, Telegram (`ARCHITECTURE.md` rows).
- **Screens (slice 3):** Settings "Printing" section (switch plus recent jobs), Reprint button on order screens, `print_agent` device label.

## Log
- 2026-11-11: after the owner's answers, the three header findings were fixed (CSP `img-src` allows LINE avatars; both web apps send HSTS and a `Permissions-Policy`; regression tests) and the VAPID pair for phone alerts was generated, while the `trustProxy` finding closed as no change needed (Caddy ignores client-supplied `X-Forwarded-For` and the API is not behind Cloudflare): see "2026-11-11 · Security · Header fixes, Caddyfile check and VAPID keys" in PROGRESS.
- 2026-11-11: first vulnerability pass (read-only): production dependencies clean, route authz and webhook checks sound, five findings (CSP blocks LINE avatars, no HSTS/Permissions-Policy on the staff app, `trustProxy` needs the VM Caddyfile, 22 dev-only advisories); a question waits in `10-open-questions.md`: see "2026-11-11 · Security · First vulnerability pass: clean controls and five findings" in PROGRESS.
- 2026-11-10: this Mac mini got its own GitHub SSH key (dedicated `~/.ssh/id_ed25519_github`, account `omeieee`), so the working copy can fetch and push again: see "2026-11-10 · Maintenance · GitHub SSH key for the Mac mini (fetch/push work again)" in PROGRESS.
- 2026-11-10: live walk of the Printing settings and alerts screens at 1180×820 and 390×844 with `chrome-devtools` (read-only); the alerts screen confirms the server has no push config, and a new CSP finding blocks LINE avatars: see "2026-11-10 · P8 · Live walk of the printing and alerts screens on iPad and iPhone" in PROGRESS.
- 2026-11-10: added the `chrome-devtools` MCP server to the DSH profile for staff-UI checks at iPad/iPhone sizes (a new plugin needs a `- insert:` patch entry); smoke-tested the live staff app at 1180×820 and 390×844: see "2026-11-10 · Maintenance · Chrome DevTools MCP added to the harness" in PROGRESS.
- 2026-11-10: project re-set up on the owner's Mac mini (external SSD): pnpm 12.6.0 and Node 24/26, clean install, full gate green (7769 tests) after fixing the ICU 79 Thai time expectation and a wall-clock test; this Mac's GitHub SSH key is still to add: see "2026-11-10 · Maintenance · Re-set up on the Mac mini and green the full gate" in PROGRESS.
- 2026-10-28: synced this machine's `main` to `origin/main` (`d613522`, including `fced643` USB print agent + launcher) and verified `@sds/print-agent` typecheck and 40 unit tests: see "2026-10-28 · Maintenance · Sync local repo with origin/main (`d613522`)" in PROGRESS.
- 2026-10-27: real Xprinter (`Printer POS-80`, `VID_1FC9&PID_2016`) verified at 576 dots and printed live order `#L-001`; direct Windows USB printing (`PRINTER_HOST=usb`), interactive `--setup` CLI, and windowless `SaapDonSenPrintAgent.exe` launcher (Desktop/Startup shortcuts + Scheduled Task) built in `apps/print-agent`: see "2026-10-27 · P8 · USB printing, interactive setup and Windows launcher for the print agent; live XP-80T verified" in PROGRESS.
- 2026-10-26: PAY-01, PAY-02, LINE-02, LINE-03, LINE-04 and BE-02 fixed, merged to `main` `8bbf6d5` and deployed 2026-10-26: see "2026-10-26 · P8 · Review fixes PAY-01, PAY-02, LINE-02, LINE-03, LINE-04, BE-02" in PROGRESS.
- 2026-10-26: BE-01 (kitchen job written in the order's transaction; `kitchen-queue.ts` removed) and SEC-01 (owner sign-in refuses the print agent token) fixed, plus POS-01 and UX-02; merged to `main` `8d07563` and deployed 2026-10-26: see "2026-10-26 · P8 · Review fixes POS-01, UX-02, SEC-01, BE-01" in PROGRESS.
- 2026-10-26: flaky print-ticket privacy test fixed (9-digit check on the ticket only; test-only, branch `claude/brave-knuth-wgwts8`): see "2026-10-26 · P8 · Fix the flaky print-ticket privacy test" in PROGRESS.
- 2026-10-25: kitchen tickets (and every other reader of order lines) now list dishes in cart order: see "2026-10-25 · Maintenance · Order items keep cart order (D-45)".
- 2026-10-25: main merged into pay-first, M4 fixed, two stale/flaky tests fixed (branch `claude/compassionate-franklin-gaz2oh`, not deployed): see "2026-10-25 · P8 · Pay-first merged with main; M4 fixed" in PROGRESS.
- 2026-10-25: pay-first / edit-merge / slip allocation / auto-cancel / payment pop-up / Telegram built (D-38 to D-42, uncommitted, migrations 0043-0044): see "2026-10-25 · P8 · Built: pay-first LINE orders". The print trigger for LINE PromptPay orders is now payment, not accept.
- 2026-10-24: pay-first / edit-merge / Telegram plan approved, D-38 to D-42 Proposed, no code: see "2026-10-24 · P8 · Plan: pay-first LINE orders". When built, print on payment replaces "print on accept" for LINE PromptPay orders (D-38).
- 2026-10-24: full-system review; P8-relevant: SEC-01 (owner sign-in accepts the print_agent token; fix before registering the device), BE-01 (kitchen ticket can be lost), OPS-02 (repeat alerts silent): see "2026-10-24 · P8 · Full-system review" and `docs/11-review-findings.md`.
- 2026-10-22: deployed at `c96c033`: see "2026-10-22 · P8 · Deployed".
- 2026-10-22: phone alerts (Web Push) built: see "2026-10-22 · P8 · Phone alerts with Web Push".
- 2026-10-22: P8 slices 1-3 built, uncommitted: see the PROGRESS entry "2026-10-22 · P8 · Print queue, ticket drawing, print agent, Printing screens".
