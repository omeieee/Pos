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
- [ ] Phone alert arrives on the kitchen phone(s) with no customer personal data in it (Web Push replaces ntfy; code and tests done, not tried on a real phone, VAPID keys not set)

## As built
Slices 1-3 built 2026-10-22, **uncommitted, not deployed, no real printer yet** (rows in `ARCHITECTURE.md`):
- **Queue (slice 1):** `print_jobs` (migration 0040); `GET|PATCH /v1/settings/printing` (`settings.view` / `settings.edit`, default off); `POST /v1/print/claim`, `POST /v1/print/jobs/:id/ack` (guard: non-revoked `print_agent` device token), `GET /v1/print/jobs`, `POST /v1/orders/:id/reprint` (`order.create`); event `order.sent_to_kitchen` (on entering `preparing`); schemas and ticket builder in `packages/shared/src/print.ts`.
- **Drawing and agent (slice 2):** `packages/escpos` (fontkit + bundled Sarabun, own scanline filler, `renderTicket`); `apps/print-agent` (claim, render, TCP 9100, ack; printed-ids file; `--test-print`; README for Windows).
- **Phone alerts (slice 4):** `push_subscriptions` (migration 0041); `GET /v1/push/config`, `GET|PUT|DELETE /v1/push/subscription`; `apps/api/src/push/` sends on `alert.new_order`; VAPID env `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`; pos-web `#/alerts` screen, `platform/push.ts`, `public/push-sw.js`.
- **Pay-first (D-38 to D-42, built 2026-10-25):** committed and merged into `main`; deployed (live `/healthz` `e5a3de7`, 2026-10-25). Migrations 0043-0044; unpaid-timeout job, chat-slip allocation, late-slip keeper, payment pop-up, Telegram (`ARCHITECTURE.md` rows).
- **Screens (slice 3):** Settings "Printing" section (switch plus recent jobs), Reprint button on order screens, `print_agent` device label.

## Log
- 2026-10-26: review fix POS-01 (REST answers no longer move the pos-web sync cursor), `388dd8b` on the session branch: see "2026-10-26 · P8 · Review fix POS-01".
- 2026-10-25: kitchen tickets (and every other reader of order lines) now list dishes in cart order: see "2026-10-25 · Maintenance · Order items keep cart order (D-45)".
- 2026-10-25: main merged into pay-first, M4 fixed, two stale/flaky tests fixed (branch `claude/compassionate-franklin-gaz2oh`, not deployed): see "2026-10-25 · P8 · Pay-first merged with main; M4 fixed" in PROGRESS.
- 2026-10-25: pay-first / edit-merge / slip allocation / auto-cancel / payment pop-up / Telegram built (D-38 to D-42, uncommitted, migrations 0043-0044): see "2026-10-25 · P8 · Built: pay-first LINE orders". The print trigger for LINE PromptPay orders is now payment, not accept.
- 2026-10-24: pay-first / edit-merge / Telegram plan approved, D-38 to D-42 Proposed, no code: see "2026-10-24 · P8 · Plan: pay-first LINE orders". When built, print on payment replaces "print on accept" for LINE PromptPay orders (D-38).
- 2026-10-24: full-system review; P8-relevant: SEC-01 (owner sign-in accepts the print_agent token; fix before registering the device), BE-01 (kitchen ticket can be lost), OPS-02 (repeat alerts silent): see "2026-10-24 · P8 · Full-system review" and `docs/11-review-findings.md`.
- 2026-10-22: deployed at `c96c033`: see "2026-10-22 · P8 · Deployed".
- 2026-10-22: phone alerts (Web Push) built: see "2026-10-22 · P8 · Phone alerts with Web Push".
- 2026-10-22: P8 slices 1-3 built, uncommitted: see the PROGRESS entry "2026-10-22 · P8 · Print queue, ticket drawing, print agent, Printing screens".
