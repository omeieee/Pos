# Phase 8 — Kitchen Printing and Phone Alerts

**Status:** 🟡 In progress (started 2026-10-22; built, not deployed) · **Depends on:** P5; XP-80T bought, a Windows 11 notebook as print host (D-37, no Mini PC) · **Agents:** backend-engineer, devops-engineer, ux-ui-designer

## Goal
Every order, whatever its source (LINE, storefront, Grab, LINE MAN), prints in the kitchen and rings staff phones.

## Scope
- **In:**
  - phone alerts: self-hosted ntfy as first planned, now **Web Push proposed** (D-37, to approve); thumbnail, priority and click-through;
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
- [ ] ntfy alert with thumbnail and alarm priority arrives on the kitchen phone(s), with no customer personal data in it

## As built
Slices 1-3 built 2026-10-22, **uncommitted, not deployed, no real printer yet** (rows in `ARCHITECTURE.md`):
- **Queue (slice 1):** `print_jobs` (migration 0040); `GET|PATCH /v1/settings/printing` (`settings.view` / `settings.edit`, default off); `POST /v1/print/claim`, `POST /v1/print/jobs/:id/ack` (guard: non-revoked `print_agent` device token), `GET /v1/print/jobs`, `POST /v1/orders/:id/reprint` (`order.create`); event `order.sent_to_kitchen` (on entering `preparing`); schemas and ticket builder in `packages/shared/src/print.ts`.
- **Drawing and agent (slice 2):** `packages/escpos` (fontkit + bundled Sarabun, own scanline filler, `renderTicket`); `apps/print-agent` (claim, render, TCP 9100, ack; printed-ids file; `--test-print`; README for Windows).
- **Screens (slice 3):** Settings "Printing" section (switch plus recent jobs), Reprint button on order screens, `print_agent` device label.

## Log
- 2026-10-22: P8 slices 1-3 built, uncommitted: see the PROGRESS entry "2026-10-22 · P8 · Print queue, ticket drawing, print agent, Printing screens".
