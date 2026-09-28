# Phase 4 — LINE Ordering

**Status:** ⚪ Not started · **Depends on:** P3, Q2, Q4, Q10 · **Agents:** line-integration-engineer, backend-engineer, ux-ui-designer, qa-security-reviewer

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
_Fill in with `/checkpoint`._

## Log
_Empty._
