# Phase 3 — Storefront POS

**Status:** 🟡 Started 2026-10-01 under the owner's blanket authorization (backend tasks 1 and 4 in a worktree; P2 not yet closed) · **Depends on:** P1, P2 · **Agents:** pos-frontend-engineer, backend-engineer, payments-finance-engineer, ux-ui-designer, qa-security-reviewer

## Goal
Staff can run the counter on the iPad and iPhone: menu, orders, kitchen view and all payment methods, synced in real time and tolerant of internet outages.

## Scope
- **In:**
  - device registration + staff PIN + roles;
  - owner login (password + TOTP, step-up);
  - menu CRUD with modifiers, photos, availability and channel prices;
  - order entry and order numbers;
  - order board and kitchen view with sound alerts;
  - customer-facing QR display;
  - payments: cash with the change calculator, PromptPay QR, gov co-pay guided flow, method change, void/refund with reason;
  - PromptPay ID setting (owner + step-up + audit + alert);
  - realtime sync (WS + `/v1/sync`);
  - offline outbox;
  - manual Grab / LINE MAN entry;
  - today dashboard (basic).
- **Out:** LINE ordering (P4), advanced reports (P6).

## Exit criteria
- [ ] Order with modifiers entered in ≤ 20 s on the iPad (timed by the owner)
- [ ] A change on one device appears on a second device in < 1 s (p95, measured)
- [ ] Cash change is correct for the test matrix; the PromptPay QR scans with the right amount; gov co-pay flow is walked through with a real ถุงเงิน transaction (or a dry run if the scheme is inactive)
- [ ] Method change and void leave a complete audit trail
- [ ] Internet unplugged → cash and PromptPay orders still work → they sync without duplicates when reconnected
- [ ] Changing the PromptPay ID requires step-up and alerts the owner
- [ ] E2E tests (Playwright, iPad and iPhone viewports) cover the main flows

## Draft task order (proposal of 2026-10-01 for the owner to review; nothing started)
Starting point (read from the repo): `packages/shared` already has the order/payment state machines, money, permissions and Zod schemas; `packages/db` has schema v1 with sync triggers; `packages/promptpay` has the QR payload; `apps/api` serves health endpoints only; `apps/pos-web` is a shell with the platform seam. So P3 is mostly API modules, realtime and the staff UI.

| # | Task | Agent | Needs from the owner | Verified by |
|---|---|---|---|---|
| 1 | Auth and devices: device registration, PIN session (5 tries, then 5-min lock), owner password + TOTP, step-up, `audit_log` | backend | kickoff Q7 (authenticator, PIN) | unit tests for lockout, step-up expiry, RBAC from `shared` permissions |
| 2 | Settings and seed: shop profile, hours, business-day cutoff (default 04:00), numbering, PromptPay ID (owner + step-up + audit + alert), gov co-pay scheme | backend + payments | Q3, Q4, Q5 | changing the PromptPay ID without step-up is refused; audit row and alert exist |
| 3 | Menu CRUD with modifiers, availability, channel prices (placeholder menu first) | backend | Q8, Q9 | API tests; seed replaced by the real menu later |
| 4 | Orders: idempotent `POST`, `PATCH` with `expectedVersion`, transitions through the shared machine, daily `order_no` with channel letter | backend | none | concurrency and duplicate-`POST` tests; `rev`/`version` bump; events after commit |
| 5 | Payments (tests first): cash change calculator, PromptPay QR (signed short-lived PNG), gov co-pay guided flow, claim/confirm/change-method/void/refund with reasons and audit | payments + backend | Q3, Q4, Q5 | cash test matrix; QR scan in K PLUS; audit trail complete |
| 6 | Realtime: `WS /v1/ws` and `GET /v1/sync?since=` on the `rev` triggers, client store | backend + frontend | none | p95 below 1 s between two devices, measured |
| 7 | Staff UI (`pos-web`): login/PIN, order entry, order board and kitchen view with sound, payment screens, customer-facing QR mode, menu and settings, today dashboard | frontend + ux | Q2 (design), Q6 (devices) | order with modifiers in 20 s or less, timed by the owner |
| 8 | Offline outbox: device-scoped numbers (`X1-07`), idempotent replay | frontend + backend | none | unplug test: no duplicates after reconnect |
| 9 | Manual Grab / LINE MAN entry | frontend | Q9 | E2E |
| 10 | Playwright E2E (iPad 1180×820, iPhone 390×844), real-device Safari check, qa-security-reviewer, `/checkpoint` | qa | the owner's devices | exit criteria above |

Tasks 1 (except the TOTP app choice) and 4 need no owner answers. Tasks 1–6 are backend and can run in parallel with the UI shell (7) in separate directories once the questions in [10-open-questions.md](../10-open-questions.md) are answered. The standing rule still applies: no P3 code until the blocking kickoff questions are answered and P2 is closed, unless the owner waives it for named tasks.

## As built (slice 1, deployed 2026-10-01 as fadca14; inert: no owner, no orders yet)
- **Auth (`apps/api/src/auth/`, `packages/db/src/auth.ts`, `packages/shared/src/auth.ts`):** `POST /v1/auth/device`, `/pin`, `/owner`, `/step-up`, plus `GET /v1/auth/staff`, `/me` and `POST /v1/auth/logout`. Opaque 256-bit tokens stored as SHA-256; sessions are database rows (migration 0005, additive: `sessions` table and four `owner_credentials` columns). scrypt for passwords (N=2^15, p=3, about 0.4–0.7 s on the VM) and PINs (N=2^14, about 0.1 s, peppered). RFC 6238 TOTP on `node:crypto`, secret AES-256-GCM encrypted under `AUTH_SECRET_KEY`, replay-protected; single-use recovery codes. Timings: PIN session 12 h (idle 2 h), owner session 8 h (idle 30 min), step-up 5 min, PIN lock 5 tries then 5 min, owner lock 5 tries then 15 min. Audit rows for device registration, step-up, lockouts and failed owner logins. First owner via `owner:create` (RUNBOOK).
- **Orders (`apps/api/src/orders/`, `packages/db/src/orders.ts`, `packages/shared/src/{orders,pricing}.ts`):** `POST /v1/orders` (idempotent by `clientRequestId`), `GET /v1/orders`, `GET`/`PATCH /v1/orders/{id}` (PATCH changes only note and room, needs `expectedVersion`), `POST /v1/orders/{id}/transition` and `/cancel` through the shared state machine. Server-side integer-satang pricing with availability, channel prices and modifier min/max; daily `order_no` per channel letter, reset at the business-day cutoff.
- **Payment logic (pure, `packages/shared`, merged locally 2026-10-01, not yet deployed):** `calculateCashChange`, `suggestCashTenders` (exact total, then the next ฿20/50/100/500/1000 multiple), `estimateGovCopaySplit` (government share rounded half up per 03 §1, cut by the daily and round caps, customer share is the remainder so the two always sum to the total; always an estimate, because only เป๋าตัง knows the customer's remaining caps) and `isCopayAvailable(scheme, now, channel, fulfillment)` (false outside dates or hours, when disabled, for any channel except the storefront, and for room delivery). The scheme shape mirrors the `gov_copay_schemes` row (inclusive dates plus start and end minutes), so a mid-day start or end would need a migration. Decisions taken by the main session: counter payments pass `channel = 'storefront'` (the payment is made face to face, so a LINE pickup order paid at the counter qualifies; P4 must map this); 06:00:00 counts as open and 23:00:00 as closed; the ฿1,000,000 limit on cash totals and tenders is a typo guard, not owner policy; 1-satang totals give the customer 0 government share. The API must take the total from the order, the cash body is `{ tendered }` only, and the estimate is stored in `est_gov_share_satang` and `est_customer_share_satang`.
- **Tests:** api 233, db 67, shared 686 (527 before the payment logic; PGlite; real-Postgres concurrency unproven).
- **Env:** `AUTH_SECRET_KEY` (32 random bytes, base64) in `/opt/sds/.env`; the API refuses to start without it.
- **Open (QA must-fix before the real owner exists):** see the PROGRESS handoff, items A–I. Not started: settings API and seed (task 2), menu CRUD (3), payments (5), realtime (6), staff UI (7), offline outbox (8), Grab/LINE MAN entry (9), E2E (10).

## Log
- 2026-10-01 · Started under the owner's blanket authorization; slice 1 (auth and orders) QA-reviewed, pushed and deployed ([PROGRESS](../PROGRESS.md))
