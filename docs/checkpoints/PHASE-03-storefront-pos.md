# Phase 3 — Storefront POS

**Status:** ⚪ Not started · **Depends on:** P1, P2 · **Agents:** pos-frontend-engineer, backend-engineer, payments-finance-engineer, ux-ui-designer, qa-security-reviewer

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

## As built
_Fill in with `/checkpoint`._

## Log
_Empty._
