# Phase 4 — LINE Ordering

**Status:** 🟡 In progress (started 2026-10-04, while P3 real-device checks are open) · **Depends on:** P3, Q2, Q4, Q10 · **Agents:** line-integration-engineer, backend-engineer, ux-ui-designer, qa-security-reviewer

## Goal
Customers order and pay through the shop's LINE OA, within the free message budget.

## Scope
- **In:**
  - LINE provider, OA, Messaging API channel, MINI App (or LIFF) channel, and a test OA;
  - webhook with signature check and dedupe by `webhookEventId`;
  - rich menu;
  - `liff-web`: menu, cart, modifiers, fulfilment, payment method, checkout, status page, method change;
  - reply-first messaging with the `sendMessages` trick and Flex templates;
  - QR image;
  - slip / "โอนแล้ว" handling;
  - "ready" push under the quota policy;
  - quota tracker;
  - customer records;
  - Thai privacy notice;
  - staff alerts for LINE orders.
- **Out:** broadcasts and marketing.

## Exit criteria
- [ ] End-to-end on real iOS and Android LINE apps: order → free reply with the exact-amount QR → pay → slip → staff confirm → status updates → "ready" push
- [ ] Choosing gov co-pay in LINE sends the "pay at storefront" instructions and **never a QR**
- [ ] Changing the payment method from chat buttons and from the app both update the POS in < 1 s
- [ ] The same webhook delivered twice doesn't double-process; a bad signature is rejected
- [ ] The quota tracker shows the current month's usage; policy `off` stops pushes
- [ ] The privacy notice is shown and its acknowledgement stored

## As built
- `packages/line`: signature check, event schemas, Thai Flex builders (co-pay card has no QR input), quota-aware sender (replies free; pushes by policy `off`/`essential`/`all`), rich-menu loader. Text in `packages/i18n` `lineBot.*`.
- `apps/api/src/line/`: `POST /v1/line/webhook` (raw body, 401 missing / 403 bad signature, 503 if unconfigured, batch stored atomically, dedupe by `webhookEventId`), follow/unfollow and privacy acknowledgement handlers; `GET /v1/line/quota` (`settings.view`). Migration 0018 (`line_quota_months`, one push per order and template).
- Infra: reserved public IP `sds-pos-api` 161.118.211.42, host `161-118-211-42.sslip.io`; compose passes `LINE_CHANNEL_ID/SECRET/ACCESS_TOKEN`, `LINE_LIFF_ID` from the VM `.env` (test OA values).
- LINE test OA `omeie`: webhook set and verified, redelivery on, built-in auto-reply and greeting off. LIFF lives on the separate LINE Login channel `omeOrderingTest`.
- Design: `design/logo/`, `design/rich-menu/` (full and compact), `design/privacy-notice-th.md` (draft, not published).
- Retention and retry: pg-boss jobs (`line-events-retry` every 5 min; nightly `retention-line-events`, `-orders`, `-recipients`, `-line-customers`), `line_events` keeps ids only, privacy ack stores the notice version.
- Ordering: `/v1/app/*` (LIFF token login, own-orders only, order cap 3 open / 50 items), `apps/liff-web`, chat Flex replies, one completion push per LINE order, rich-menu CLI (`pnpm --filter @sds/api richmenu:upload`); rich menu `full` is default on the test OA; LIFF app `Order Menu` -> `sds-order.pages.dev`.
- Not built or not verified: real-device E2E, slip storage and 90-day deletion, Playwright for liff-web.

## Log
- 2026-10-04: kickoff, LINE package and webhook, reserved IP, webhook verified ([PROGRESS](../PROGRESS.md)).
- 2026-10-04: retention jobs, ordering flow, rich menu ([PROGRESS](../PROGRESS.md)).
