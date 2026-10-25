# 11 · Review and test findings (full system, 2026-10-23/24)

> **Reviewed:** `main` at `c96c033` (deployed and live), across the staff app, kitchen, back office, customer app, LINE OA, Web Push, printing, API and infrastructure.
> **How:** a seven-reviewer team plus a main-session baseline and live pass (see §2). Each finding gives a location, its status (Confirmed = a repro ran; Code-traced = path read end to end), the impact, a proposed fix and whether the owner must decide something.
> **No repo code was changed by this review.** Fixes still need tests first where they touch money, payments or tax (CLAUDE.md conventions).
> ⚠️ **Read OPS-01 before committing this file.** The GitHub repo is currently **public**. This file has no secrets or personal data, but it describes weaknesses. Decide the repo's visibility first.

## 1. Summary

| Severity | Count | Meaning here |
|---|---|---|
| Critical | 0 | — |
| High | 7 | realistic shop-day failure, domain-rule risk, or a block on all deploys |
| Medium | 23 | edge case or degraded flow with a workaround; defence in depth |
| Low | 22 | minor bug, polish, copy, docs drift |
| Info | 3 | observations |

55 findings after merging duplicates (60 raw). No auth bypass, no secret in git, no float money, and the D-27 auto-confirm gates held in every failure the money reviewer tried. The weak spots are **what customers and staff are told** (co-pay copy, the "never auto-confirms" header), **sync edge cases**, **silent failure paths** (alerts, Slip2Go, LINE quota, lost tickets), and **CI/ops hygiene**.

### Fix first (recommended order)
1. **Owner, today:** confirm the Slip2Go package was bought after the trial ended on 2026-10-19, or set `SLIP_AUTOCONFIRM=off`. Failures outside codes 401001–401007 are silent (PAY-02).
2. **Owner:** decide the repo's visibility (OPS-01) before committing anything new, including this file.
3. **CI unblock:** `pnpm audit --prod` fails today, so the next push to `main` deploys nothing (OPS-03). Bump the two dependencies and move the audit out of the gating path.
4. **Rule 4 copy:** customer text promises a ไทยช่วยไทย QR "will be sent" (LINE-01). The owner approves new wording.
5. **Money paths:** ambiguous chat slips must not auto-confirm (PAY-05); check Slip2Go's returned `dateTime` (PAY-01).
6. **Sync:** a separate sync cursor in pos-web (POS-01), plus events for silent writers (BE-02).
7. **Kitchen and alerts:** undo window on "ทำเสร็จ" (UX-02). The owner changes the Sentry rule to fire on every alert-tagged event, a free 5-minute change (OPS-02).
8. **Before printing goes live:** SEC-01 (before registering the print device) and BE-01 (lost tickets).

## 2. How the review ran

| Area (ID prefix) | Reviewer | Scope |
|---|---|---|
| SEC | qa-security-reviewer | every `/v1` route vs permissions, step-up/audit, sessions, WS, webhook, LIFF, CORS/CSP, push SSRF, PDPA logging, secrets |
| PAY | payments-finance-engineer | D-27/D-28 auto-confirm, totals, PromptPay, cash, void/refund, co-pay, P&L/tax |
| LINE | line-integration-engineer | webhook, quota sender, Flex, rich menu, rule 4, liff-web flows; liff-web E2E |
| POS | pos-frontend-engineer | pos-web on iPad/iPhone/laptop, outbox, realtime, iOS PWA, payment and kitchen screens; pos-web E2E |
| BE | backend-engineer | write rules, real-Postgres concurrency, realtime hub, jobs, migrations, time, print agent |
| UX | ux-ui-designer | task flows, Thai copy, touch targets, contrast, focus, both apps, Flex/rich menu |
| OPS | devops-engineer | CI/CD, backups, monitoring, free tiers, VM hardening (docs only, no SSH), live headers |
| MAIN | main session | baseline runs, live pass of pos-web on the dev mock (iPad 1180×820, iPhone 390×844, laptop 1440×900), cross-checks |

**Rules every reviewer followed:** review only (no repo edits, installs or migrations); no `.env` or key contents printed; no live calls except one GET each to `/healthz`, `/readyz` and the two web origins' headers. Repro tests were written only in a scratch folder. Each finding had to state what was checked to try to **disprove** it.

**Baseline (main session, HEAD `c96c033`):**
- `pnpm test`: 12/12 tasks green. Counts went up on every package since the 2026-10-15 run: shared 1206 · db 340 · api 1618 · pos-web 2294 · liff-web 117 · i18n 26 · line 69 · ui 123 · promptpay 1276 · finance 223 · escpos 22 · print-agent 35.
- `pnpm build`: 16/16.
- `pnpm lint`: exit 1, but all 23 errors are in untracked `.claude/skills/**` files. `biome check apps packages` is clean (MAIN-03).
- `pnpm audit --prod`: 2 advisories (OPS-03).

**E2E (one project at a time, workers=1, fakes only):**
- pos-web: iPad Firefox 60 ✓; iPhone Chromium 61 ✓; iPhone WebKit 61 ✓. iPad Chromium and iPad WebKit each 59 ✓ + 1 ✗, the same tap-target test. Run alone it passed on Chromium and Firefox; WebKit crashed on Windows. A direct measurement then confirmed the defect, and that the test is timing-dependent (MAIN-05).
- liff-web: iPhone Chromium, WebKit, Firefox and Android (Pixel 7) 7/7 each.

**Re-verified by the main session:** PAY-01/PAY-05 repros 10/10, POS repros 4/4, BE repros 4/4 (each asserts the faulty behaviour). Code read for OPS-01, OPS-03, LINE-01, SEC-01 and UX-02. MAIN-01, MAIN-02 and MAIN-05 were seen live.

## 3. Coverage matrix

Legend: **E2E** = Playwright against fakes · **Live** = main-session live pass on the dev mock · **Code** = code review and unit tests · **✗** = not covered · — = not a target.

| Channel \ Device | iPad | iPhone | Laptop | Android phone | Print notebook |
|---|---|---|---|---|---|
| Staff order entry + payment | E2E (Chromium, WebKit, Firefox) · Live | E2E (Chromium, WebKit) · Live | Live · Code | — | — |
| Kitchen board | E2E · Live | E2E | Code | — | — |
| Back office (reports, P&L, settings) | E2E (settings) · Code | E2E (partial) · Code | Live (orders) · Code | — | — |
| Customer app (LIFF) | — | E2E (Chromium, WebKit, Firefox) · Code | — | E2E (Pixel 7 Chromium) · Code | — |
| LINE OA chat / Flex / rich menu | — | Code (unit tests) | — | Code | — |
| Web Push alerts | E2E (fake push) · Code | E2E (fake push) · Code | Code | — | — |
| Kitchen printing | Code | Code | — | — | Code (unit tests) |
| API / infra | Code · live headers | | | | |

**Not covered anywhere — needs a real device or environment:**
- real iOS Safari and Home Screen mode (Playwright WebKit is not iOS Safari)
- LINE's in-app browser and real LINE delivery
- real Web Push (VAPID keys not set)
- the real XP-80T and notebook sleep
- real Postgres locking (tests use PGlite, which serialises)
- the production VM, `.env` and consoles (no SSH by rule)
- the live Slip2Go account
- VoiceOver, and reading the kitchen screen from 1–2 m

## 4. Findings

Format: **ID · title**, then where it is, status, impact, proposed fix and owner decision. Merged duplicates list every source ID.

### 4.1 High

**LINE-01 (= UX-01) · ไทยช่วยไทย copy tells the customer a QR "will be sent", and the method is offered when the scheme is closed**
- **Where:**
  - `packages/i18n/src/th/line.ts:37-38,86`
  - `packages/i18n/src/th/liff.ts:62,74,123`
  - en equivalents
  - pinned by `packages/line/src/flex.test.ts:99`
  - always offered by `apps/api/src/customer-app/service.ts:154-160` (`methodsOffered`)
- **Status:** Confirmed (tests lock the text in). Code never sends a QR, so rule 4 holds in code.
- **Impact:** a customer waits for a QR that never comes, or staff under pressure send the ถุงเงิน QR in chat, which breaks rule 4 and the scheme terms. The method is still offered outside 06:00–23:00 and the scheme dates, against D-08 and docs/04 §3.2.
- **Fix:**
  - restore face-to-face wording, e.g. "ชำระด้วยไทยช่วยไทย: สแกนจ่ายด้วยเป๋าตังกับพนักงานตอนรับอาหารที่ทางเข้าอาคาร ร้านไม่ส่ง QR ทาง LINE"
  - make the flex test assert `not.toContain('ส่ง QR ให้')`
  - hide `gov_copay` in `methodsOffered` when the scheme is closed
  - add a co-pay path to liff-web E2E
- **Owner:** yes. What did "ส่ง" mean in the 2026-10-11 wording (still open in `10-open-questions.md:212`)? Should co-pay be hidden outside the scheme window?

**PAY-05 · A slip sent in LINE chat attaches to the customer's newest open PromptPay order, and auto-confirm then marks the wrong order paid**
- **Severity:** raised from Medium. A payment is confirmed on the wrong order in production with `SLIP_AUTOCONFIRM` on.
- **Where:** `apps/api/src/line/handlers.ts:283-284,318-332` (newest first, via `packages/db/src/orders.ts:384-395`) → `attachSlip` → `autoConfirmClaimedPayment`
- **Status:** Confirmed (PGlite repro with fake LINE and Slip2Go): L-001 stays pending; L-002 is auto-confirmed with L-001's slip.
- **Impact:** with two open orders of the same amount (a re-order, or a neighbour's order), the kitchen and delivery see the order that was actually paid as unpaid. Staff untangle it by hand. The money total is right.
- **Fix:** when more than one open order waits for PromptPay, don't guess. Attach with auto-confirm off for that claim, or reply with a free quick-reply list of the open orders. Turn the repro into a regression test.
- **Owner:** yes. Should the bot ask the customer, or attach to the newest order but never auto-confirm?

**POS-01 (related: BE-02) · A REST answer moves the realtime sync cursor, so a reload can leave ไทยช่วยไทย "not configured", and older rows never arrive**
- **Where:**
  - `apps/pos-web/src/realtime/entity-store.ts:121-141` (`put()` raises `lastRev` for any applied frame)
  - `realtime/connection.ts:179-185` (catch-up from `lastRev − 200`)
  - REST callers: `pos/orders/use-load-orders.ts:25`, `pos/payments/payment-store.ts:245,275`, `pos/cart/cart-store.ts:419`
- **Status:** **Fixed 2026-10-26** on `claude/brave-knuth-wgwts8` (`c63871e`, `9d9945b`; not on `main`). Was: Confirmed for the mechanism (repro against a fake `/v1/sync` modelled on the API filter). Whether REST beats the socket on the real network is Plausible.
- **Impact:** during the live co-pay round (1 Oct – 30 Nov), any reload on the Orders board or Kitchen view can disable co-pay on that device until sign-out. Reloads happen after every deploy and when iOS discards the app.
- **Fix:** a separate sync cursor moved only by the catch-up's `nextSince` and by live frames. REST `apply` updates rows but not the cursor. Turn the 3 repros into regression tests.
- **Owner:** no.

**UX-02 · Kitchen "ทำเสร็จ" is one tap with no confirm or undo, and it pushes "food ready" to the LINE customer at once**
- **Where:**
  - `apps/pos-web/src/pos/kitchen/KitchenTicket.tsx:103` → `order-moves-store.ts:134` → `apps/api/src/orders/service.ts:368` → `apps/api/src/line/completion-push.ts:76-82`
  - no `ready → preparing` in `packages/shared/src/order-machine.ts`
- **Status:** **Fixed 2026-10-26** (client undo, 500 ms double-tap guard) on `claude/brave-knuth-wgwts8` (`e3b976c`, `5dc8d99`; not on `main`). Was: Code-traced.
- **Impact:** a mis-tap on a busy, wet-handed day sends the wrong customer downstairs, spends one of the 300 monthly pushes, and can't be moved back.
- **Fix:** a 5-second client-side undo ("เลิกทำ · 5") that sends the PATCH only when the countdown ends. Test it with fake timers. A server-side variant (allow `ready → preparing` before the push) would need a decision entry.
- **Owner:** no for the client undo.

**OPS-01 · The GitHub repo is public, but the docs, the trust model and the privacy scrub assume it is private**
- **Where:**
  - anonymous `GET api.github.com/repos/omeieee/Pos` → `"private": false`
  - `infra/RUNBOOK.md:124` and `docs/05-infrastructure.md:39,137` say "private"
  - the owner's personal test PromptPay phone is in 8 tracked files and 7 commits (seed, tests, docs)
- **Status:** Confirmed. A full history scan found **no secrets**.
- **Impact:** the owner's personal number and the full infrastructure map are world-readable, and the deploy-trust trade-off was accepted for a private repo.
- **Fix:** if unintended, set the repo back to Private. If intended:
  - replace the number with a synthetic fixture
  - set up SETUP H1 (free on public repos): a `production` environment limited to `main` holding the deploy secrets, branch protection, and approval for fork-PR workflows
  - rewrite the RUNBOOK trust model
- **Owner:** yes. Was making it public intended?

**OPS-02 · Security and ops alerts reach the owner only by Sentry "new issue" e-mail, so a repeat of the same alert kind is silent**
- **Where:**
  - `apps/api/src/alerts.ts:59-70` (one constant message per kind)
  - `apps/api/src/realtime/frames.ts:154-160` (`alert.security` ignored for devices)
  - `apps/api/src/push/notifier.ts:161-162` (push only for new orders)
- **Status:** Code-traced (the Sentry rule semantics come from `10-open-questions.md:158`).
- **Impact:** a second PromptPay-ID change (rule 3 requires an alert), a silent print notebook on a later day, Slip2Go quota or LINE quota capping each reach the owner at most once per kind.
- **Fix:**
  - **owner, free, now:** a Sentry rule "tag `alert` is set" that fires on every event; test it with two labelled events
  - **code:** forward `warn`/`critical` alerts to owner and manager devices through the D-37 Web Push notifier (kind and ids only, no personal data)
- **Owner:** yes. Change the Sentry rule, and approve alerts by Web Push.

**OPS-03 (+ MAIN-04) · Today's two npm advisories fail CI, so the next push to `main` skips lint/build/test and deploys nothing**
- **Severity:** raised from Medium; the block on the next push is certain.
- **Where:**
  - `.github/workflows/ci.yml:27` (`pnpm audit --prod` before lint)
  - deploys gate on CI success (`deploy-api.yml:53-59`, `deploy-web.yml:39-45`)
  - advisories: fastify <5.12.6 (GHSA-389g-gv7q-r4x8, low); ip-address ≤10.7.3 via `@fastify/rate-limit` (GHSA-rxp7-6hxx-x8q5, moderate)
- **Status:** **Block cleared** by 2026-10-26: `pnpm audit --prod` reports no known vulnerabilities; the audit still gates CI (hardening open). Was: Confirmed (`pnpm audit --prod` exits 1; the last green CI predates the advisories).
- **Impact:** an urgent payment or LINE hotfix silently doesn't deploy. The manual override also skips the test gate.
- **Fix:**
  - bump fastify ≥5.12.6, and pull ip-address ≥10.7.4 (bump rate-limit or a pnpm override)
  - move the audit into its own job, or use `--audit-level=high`, so lint/build/test always run and gate deploys
  - add a weekly non-blocking audit run
  - SEC-08: the ip-address issue is practically low risk; the rate-limit key is the parsed client IP, and the API is not behind Cloudflare (D-10)
- **Owner:** no.

### 4.2 Medium

**PAY-01 · Auto-confirm never checks the transfer date Slip2Go returns**
- **Where:** `apps/api/src/slips/checker.ts:325-329,351-353,594-618`; `slips/slip2go.ts:165` parses `dateTime` and nothing reads it.
- **Status:** Confirmed: a `200200` answer dated 3 days before the order, or with no date, auto-confirms.
- **Fix:** on `200200`, require `dateTime` ≥ `notBefore`; otherwise return verdict `date_mismatch`, or `valid` without auto-confirm. Add a missing-date case.
- **Owner:** yes. When the package is renewed, run one live probe (about 0.5 token) to learn whether Slip2Go compares the date or the time. Bounded by the 1,000 THB ceiling.

**PAY-02 · Slip2Go failures outside codes 401001–401007 are silent, and the daily account check never alerts**
- **Where:** `packages/shared/src/slip-verify.ts:137-165`, `apps/api/src/slips/slip2go.ts:148-155,202`, `apps/api/src/jobs/slip2go.ts:20`.
- **Status:** Confirmed. Payments correctly stay `claimed` (fail-closed), but nobody is told that auto-confirm stopped.
- **Fix:** raise the once-a-day `slip2go.unavailable` alert for any final `unchecked` with `called=true`, and alert when `accountInfo` fails.
- **Owner:** yes. Was a package bought? See Fix-first #1.

**PAY-03 · A co-pay payment started before 23:00 cannot be confirmed after 23:00 (scheme end = shop close)**
- **Where:** `apps/api/src/payments/moves.ts:149-156` re-checks availability at confirm time; `packages/shared/src/gov-copay.ts:254-255`.
- **Status:** Confirmed.
- **Impact:** a real last-delivery sale stays `unpaid`, missing from revenue and the co-pay receivable.
- **Fix:** skip the re-check for a `gov_copay` payment that already has a `schemeId`; optionally limit that to the same business date.
- **Owner:** yes. Is co-pay on in production? Should confirming after 23:00 on the same night be allowed?

**LINE-02 · A dish that goes หมด during checkout leaves the LIFF customer stuck**
- **Problem:** an unnamed error, a stale menu, no remove button, and reopening loses the cart.
- **Where:** `apps/liff-web` client and cart model (details in the LINE report).
- **Status:** Confirmed by a script.
- **Fix:**
  - surface the server's failed line with a remove action
  - refresh the menu on the error
  - persist the cart across reopen
- **Owner:** no.

**LINE-03 · At LINE's real monthly limit every push fails silently**
- **Problem:** the local unit is released and no alert fires; docs/04 claims a quota read that does not exist.
- **Where:** `packages/line` sender and policy.
- **Status:** Confirmed against the real `createLineSender`.
- **Fix:**
  - treat LINE's 429 or monthly-limit answer as capped: raise a `line.quota_capped` alert and hold further pushes
  - optionally read LINE's quota endpoint once a day
  - **owner:** avoid OA Manager broadcasts on the free plan; they share the 300
- **Owner:** no.

**LINE-04 · After staff reject a claim, a slip the customer sends in chat is thrown away, although the rejection message asks for one**
- **Where:** `apps/api/src/line/handlers.ts` slip path.
- **Status:** Code-traced.
- **Fix:** accept a chat slip for an order whose PromptPay payment was rejected (back to `claimed`), with a test.
- **Owner:** no.

**POS-02 (= UX-04) · The counter can go silent: sound is switched only in the kitchen view, and only that view stays awake and signed in**
- **Where:**
  - `apps/pos-web/src/pos/kitchen/SoundControl.tsx`, rendered only in `KitchenScreen.tsx:237,246`
  - default off (`platform/sound.ts:72-75`)
  - keep-alive only in the kitchen view
  - no badge on the iPhone tab bar
- **Status:** Code-traced. The default-off sound was seen live.
- **Impact:** a counter iPad on the Orders board makes no sound for new LINE orders and signs out after 2 idle hours.
- **Fix:**
  - show the sound state where the cashier works ("เสียงออเดอร์ใหม่: ปิดอยู่ · แตะเพื่อเปิด")
  - a non-modal banner for new LINE or platform orders, with `role="status"`
  - a badge on the iPhone tab bar
  - make the counter screen a listening screen like the kitchen
- **Owner:** yes. Which screen runs at the counter? Should it stay signed in for up to 12 h?

**POS-03 · The iPhone "ยอดรับเงินแล้ว" (paid today) is summed in the client (rule 1) and drops partly refunded or partly paid orders**
- **Where:** the pos-web month/overview card (details in the POS report).
- **Status:** Confirmed by a test.
- **Fix:** show the server's paid KPI for the business day, and send the month total from the server.
- **Owner:** no.

**BE-01 · A kitchen ticket can be lost for good, and the silent-notebook check does not notice**
- **When:** latent until printing is on.
- **Where:**
  - `apps/api/src/print/kitchen-queue.ts:24-35` (in-memory subscriber after commit)
  - `print/service.ts:74-87`
  - `server.ts:114,163,167-173` (no drain on shutdown)
  - `packages/db/src/print.ts:146-161`
- **Status:** **Fixed 2026-10-26** (job written in the order's transaction) on `claude/brave-knuth-wgwts8` (`5d3bd7c`; not on `main`). Was: Confirmed: an order in `preparing` with 0 print jobs, and the silent check reports 0 waiting.
- **Fix:** insert the kitchen job in the order's own transaction (guarded by `currentPrintingEnabled(tx)`), or add a sweep job, and call `v1.idle()` on shutdown. D-37's wording would need a one-line update.
- **Owner:** no.

**BE-02 · Writes that publish no event never reach a device that stayed connected (the 200-rev rewind doesn't cover them)**
- **Where:**
  - `apps/api/src/jobs/retention.ts:64,73,90,106`
  - `customers/service.ts:40-80` (no `customer.upserted` producer anywhere)
  - `customer-app/service.ts:138`
  - `orders/service.ts:172-188`
  - `slips/checker.ts:570`
- **Status:** Confirmed. One retention run changed 250 orders and sent 0 events.
- **Impact today:** erased names stay in device memory (not on screen), and rule 6 is broken.
- **Fix:** publish events for these writers, or with POS-01 make the client's catch-up cursor independent of live frames.
- **Owner:** no.

**SEC-01 · Owner password sign-in accepts the print agent's device token**
- **Where:** `apps/api/src/auth/routes.ts:98-104` (`/owner` calls `authenticateDevice` but not `requireStaffDevice`, unlike `/staff` and `/pin`); `owner-login.ts`.
- **Status:** **Fixed 2026-10-26** on `claude/brave-knuth-wgwts8` (`e0a3ad1`; not on `main`). Was: Confirmed.
- **Impact:** owner actions are audited as the print notebook, revoking the notebook ends the owner session, and push subscriptions can attach to it. There is no privilege gain (password and TOTP are still needed).
- **Fix:** call `requireStaffDevice(device)` when a token is sent. Test: 403 for a print_agent token, 200 for an iPad. **Do this before registering the print device.**
- **Owner:** no.

**MAIN-01 · The Orders page says the system never auto-confirms from a slip, but D-27 auto-confirm is on**
- **Where:**
  - `orders.subtitle` (`packages/i18n/src/th/orders.ts:109`, `en/orders.ts:116`), rendered unconditionally by `apps/pos-web/src/pos/orders/OrdersTable.tsx:86`
  - the same app shows "ยืนยันอัตโนมัติ (Slip2Go)" chips
- **Status:** Confirmed live (laptop 1440×900).
- **Impact:** staff think every confirmed payment was checked by a person, which weakens the "staff review auto-confirms" control of rule 2.
- **Fix:** reword, e.g. th "ตรวจยอดเข้าบัญชีก่อนยืนยันทุกครั้ง — สลิปพร้อมเพย์ที่ธนาคารยืนยันแล้วอาจถูกยืนยันอัตโนมัติ (มีป้าย ‘ยืนยันอัตโนมัติ’)" / en "Check the money in your bank app before you confirm. PromptPay slips the bank verifies may be confirmed automatically and are marked 'Auto-confirmed'."
- **Owner:** no.

**MAIN-05 (= POS-06, UX-08) · Touch targets under 44 pt on the most-used counter controls; the E2E guard depends on timing**
- **Where and sizes:**
  - `packages/ui/src/design.css:388-392` `.g-seg .g-chip { height: 40px }` (since `2be718f`). This covers the payment-method switch (`MethodTiles.tsx:50`) and the cart channel tabs หน้าร้าน/LINE/Grab, both 40 px.
  - the quantity stepper is 34×34
  - `g-btn-sm` is 36 px high, e.g. "ดูสลิปที่ลูกค้าแนบ"
  - the guard is `apps/pos-web/e2e/layout.e2e.ts:124`; `ringOrder` returns on the h1 before the payment panel renders
- **Status:** Confirmed: computed `height: 40px` on the settled iPad payment page, plus UX CSS-harness measurements.
- **Fix:**
  - `.g-seg .g-chip { min-height: 44px }`, or a `::after` hit area over the track padding
  - a 44 px hit area on `.g-step button`, and `min-height: 44px` on `.g-btn-sm`
  - make the layout test wait for the payment panel, and cover the cart tabs, steppers and slip buttons
- **Owner:** no (the designer confirms the visual).

**UX-03 · "ส่งมอบแล้ว" (hand-over) is a one-tap red primary button even when money is still due**
- **Where:** `apps/pos-web/src/pos/orders/OrderMoves.tsx:47`; the server has no payment condition on `completed`.
- **Status:** Code-traced.
- **Fix:** when unpaid, label it "ส่งมอบ (ยังไม่รับเงิน ฿{amount})" and ask once: "รับเงินก่อน" / "ส่งมอบโดยยังไม่รับเงิน".
- **Owner:** yes. May an order be handed over unpaid (pay-later for regulars)?

**UX-05 · "ล้างออเดอร์" wipes the whole cart in one tap, with no undo, from a 23×21 px link**
- **Where:** `apps/pos-web/src/pos/cart/CartPanel.tsx:433-441` → `cart-store.ts:320-323`.
- **Status:** Confirmed (size); behaviour Code-traced.
- **Fix:** a 6-second "ล้างออเดอร์แล้ว · เลิกทำ" snackbar that restores the cart, and a real 44×44 control placed away from the totals.
- **Owner:** no.

**UX-06 · Contrast tests check `tokens.ts`, but the screens draw with `design.css`'s own palette; one kitchen text style is about 4.0:1 at worst**
- **Where:** `packages/ui/src/contrast.test.ts`, `theme.test.ts` vs `packages/ui/src/design.css:3-30,94-115`; `KitchenScreen.tsx:48` `.kb-meta` uses `--ink3`.
- **Status:** Confirmed (computed 3.96:1 in the worst spot).
- **Fix:** a test that parses `design.css` text pairs at 4.5:1, and use `--ink2` for `.kb-meta`.
- **Owner:** no.

**UX-07 · Customer app: the "บันทึก QR | ส่งสลิปใหม่แทนอันเดิม" row is wider than the screen at 375 px and 360 px**
- **Where:** `apps/liff-web/src/ui/order/PromptPayPanel.tsx:262-297`; `.g-btn{white-space:nowrap}`.
- **Status:** Confirmed: 12 px over at 375 px, 27 px over at 360 px.
- **Fix:** shorten to "ส่งสลิปใหม่" / "Replace slip", use `flex-wrap` with a `min-width` on the buttons, and add a 360 px Android E2E project.
- **Owner:** no.

**UX-09 · Keyboard focus is invisible on two cart controls and nearly invisible on text fields (laptop back office)**
- **Where:** `CartPanel.tsx:258,439` (`all:unset`); `design.css:483-495` (`.g-field input{outline:0}`, ring about 2:1).
- **Status:** Confirmed (CSS harness).
- **Fix:** a reset class that keeps the global focus ring, and a 3 px outline on `.g-field:focus-within`.
- **Owner:** no.

**OPS-04 · No restore drill has run against real data or the current 43 migrations; the Supabase restore was never rehearsed**
- **Where:** `docs/checkpoints/PHASE-02-cloud-skeleton.md:22`; `infra/RUNBOOK.md:102-111`.
- **Fix:**
  - the owner runs `run-restore-drill.sh` on a recent `hourly/` object, then monthly
  - write the exact `pg_restore` command into the RUNBOOK
  - rehearse once into a throwaway second free Supabase project
- **Owner:** yes. Schedule the drill.

**OPS-05 · `infra/compose/.env.example` lacks 11 variables (Slip2Go, auto-confirm, R2)**
- **Impact:** a rebuild from the runbook silently turns these off.
- **Where:** `infra/compose/docker-compose.yml:39-51` vs `.env.example`; `apps/api/src/config.ts:146`.
- **Status:** Confirmed.
- **Fix:** add the names (empty, commented), plus a CI script that checks `config.ts`, compose and `.env.example` agree.
- **Owner:** no.

**OPS-06 · The rebuild runbook ignores the reserved IP**
- **Impact:** following it changes the hostname, and leaves a billable unassigned IP on the PAYG account.
- **Where:** `infra/RUNBOOK.md:144-170`; `infra/oracle/RESERVED-IP.md`.
- **Fix:** rewrite rebuild steps 1 and 6 per RESERVED-IP §6, and mark that plan as executed.
- **Owner:** no.

**OPS-07 · Web and API deploy in parallel during opening hours with no ordering**
- **Where:** `deploy-web.yml:16-21`, `deploy-api.yml:16-21`.
- **Status:** Confirmed for `c96c033`: the web was live 1–2 minutes before the API.
- **Fix:** the web deploy waits for Deploy API and checks `/healthz` `.version`, and automatic deploys run only in a Bangkok-night window.
- **Owner:** yes. Accept a deploy window outside 10:00–24:00?

**OPS-08 · VM credentials can delete every backup dump and every R2 file, and receipt photos (kept 5 years for tax) have no second copy**
- **Where:** `infra/backup/backup.sh:63-67`; SETUP H2 pending; D-36 R2 token with read and write.
- **Fix:**
  - do SETUP H2: lifecycle rules and a create/read-only backup key, then drop `rclone delete`
  - add OCI retention or versioning
  - make a monthly encrypted copy of `receipts/`
- **Owner:** yes.

### 4.3 Low

| ID | Finding | Location | Proposed fix | Owner |
|---|---|---|---|---|
| PAY-04 | A full refund after a partial refund (direct refund route) doesn't record the amount returned in audit or alert | `apps/api/src/payments/moves.ts:191-208` | add `returnedSatang` and `refundedEarlierSatang` like `order-hooks.ts:134-143` | no |
| PAY-06 | "One transfer can't confirm two orders" relies on the in-process queue; no DB backstop | `payments/auto-confirm.ts:73-79`, migration 0029 non-unique index | `pg_advisory_xact_lock(hashtext(slip_qr_hash))`, or a partial unique index | no |
| LINE-05 | "สถานะ" answers once per business day, which breaks the fallback when the ready push failed | api line keywords | exempt it when the state changed or no ready push was counted | yes |
| LINE-06 | Pushes go to customers who blocked the OA and count against the local 300 | `completion-push.ts:47`, `order-change-push.ts:67`, `payment-rejected-push.ts:43`; `packages/db/src/line.ts:239-254` | skip when `unfollowed_at` is set | no |
| LINE-07 | "ดาวน์โหลดใบเสร็จ" uses `<a download>`, which LINE's browser drops | `apps/liff-web/src/ui/order/OrderView.tsx:300-309,354-364` | show the receipt as a page or picture inside LINE (like the QR viewer) | no |
| LINE-08 | LIFF: no retry on boot failure, a QR error loop that can starve status polling, endless polling for some orders | liff-web order view and polling | retry button, backoff, stop on terminal states | no |
| LINE-09 | The customer-app privacy notice doesn't name the data controller or a contact | liff-web privacy gate | add controller and contact (PDPA) | no (full notice already open) |
| LINE-10 | LINE docs drift: what pushes, what chat sends, quota tracking | `infra/line/README.md`, docs/04, docs/02 | update the docs to the code | no |
| LINE-11 | liff-web bundles the whole staff i18n catalogue (164 KB gz, 638 KB parse) | `@sds/i18n` barrels | a `@sds/i18n/customer` entry | no |
| POS-04 | The dashboard still shows a made-up VAT projection | pos-web dashboard `SAMPLE_VAT` | remove it, or feed from `watch.vat` (owner only) | yes |
| POS-05 | Offline orders are renumbered at sync, against docs 02 §8 and 03; a short WS blip also sends online orders through the outbox | pos-web outbox | record the decision and update docs; route only `offline` to the outbox | yes |
| POS-07 | An offline order refused at replay hides the refused line; "discard" drops the cash taken without a re-ring prompt | pos-web outbox recovery | name the line and warn about the cash | no |
| BE-03 | Lock-order inversion (order→customer vs customer→order) can deadlock on real Postgres | `slips/checker.ts` vs retention and erasure | lock the customer first, or flag after commit; add a real-Postgres test | no |
| BE-04 | `POST /v1/staff` has no request id (a retry creates a duplicate with the same PIN); a void replay with a different body gets 200 | api staff and orders | require `Idempotency-Key`; answer 409 on a body mismatch | no |
| BE-05 | `/v1/sync` reads families in separate snapshots | `packages/db` `readChanges` | one `REPEATABLE READ READ ONLY` transaction | no |
| SEC-02 | The 3-open-orders cap was removed (9ebf066) with no decision entry; 02 §7, 07 R6 and the P4 checkpoint still rely on it | `apps/api/src/customer-app/service.ts:348-440` | record a decision, or add a softer cap | yes |
| SEC-03 | Customer IPs go into the append-only `audit_log` (5+ years); not erasable, not in the notice | `customer-app/routes.ts:31` → `payments/internal.ts:213-222` | `ip: null` for customer actors, or disclose it | yes |
| SEC-04 | CSV export is audited but raises no owner alert | `apps/api/src/reports/export.ts:86` | `securityAlert('report.exported')` | no |
| SEC-05 | Kitchen keep-alive keeps any PIN session (even owner) alive for 12 h | `apps/pos-web/src/pos/kitchen/use-kitchen-display.ts:22-26` | keep-alive only for the kitchen role | yes |
| UX-10 | The same state has different words across kitchen, staff, LIFF and Flex; the ready push says the food is at the entrance before it is | i18n catalogues | one status-word table; ready text "…พนักงานกำลังนำไปที่ทางเข้าอาคาร…" | yes |
| MAIN-02 | Co-pay panel says "entrance only" and then "counter or entrance", and mixes ตึก and อาคาร | `packages/i18n/src/th/payment.ts:40` vs `:139` | one place word ("ที่ทางเข้าอาคาร"); drop "เคาน์เตอร์" | yes (confirm no counter sales) |
| MAIN-03 | Local `pnpm lint` fails on untracked `.claude/skills/**`, `.agents/`, `.aider-desk/` | `biome.json` `files` | exclude them in Biome, or gitignore them | no |

### 4.4 Info
- **SEC-06:** the kitchen role can read per-day paid revenue via `GET /v1/orders/summary`. This is part of the known "kitchen holds totals" item and is no worse.
- **SEC-07:** `Sample_image/` (4 JPGs, one named like a test slip) is untracked and **not** git-ignored. One `git add .` would commit possible bank details (rule 10). Move it out of the repo or ignore it. The owner should say where it came from.
- **SEC-08:** reachability of the ip-address advisory (see OPS-03). Also, 02 §7 still says HTTPS terminates at Cloudflare, but the API runs behind Caddy on sslip.io (D-10). If it ever moves behind Cloudflare, configure trusted proxies.

## 5. Owner decisions needed (one list)

1. **Slip2Go:** package bought after 2026-10-19? If not, turn `SLIP_AUTOCONFIRM` off (PAY-02). Allow one live date-granularity probe when renewed (PAY-01).
2. **Repo visibility:** intended to be public? (OPS-01)
3. **Co-pay wording:** what "ส่ง" meant, and approve the face-to-face text. Hide co-pay outside the scheme window? (LINE-01)
4. **Ambiguous chat slip:** ask the customer, or never auto-confirm? (PAY-05)
5. **Co-pay after 23:00** on the same night, and is co-pay on in production? (PAY-03)
6. **Sentry rule** on every alert-tagged event, and alerts by Web Push to the owner's phone. (OPS-02)
7. **Counter screen:** which one, and should it stay signed in up to 12 h? (POS-02) Keep-alive for the kitchen role only? (SEC-05)
8. **Hand-over while unpaid:** allowed? (UX-03)
9. **Deploy window** outside 10:00–24:00 for automatic deploys? (OPS-07)
10. **Backups:** schedule a restore drill (OPS-04); do H2, and choose a second copy for receipts (OPS-08).
11. **Customer IPs** in the audit log: drop or disclose? (SEC-03) Record "no open-order cap" or choose a softer cap. (SEC-02)
12. **Copy:** approve the status-word table (UX-10) and the place word (MAIN-02). Keep "สถานะ" once a day? (LINE-05) Should managers see VAT progress? (POS-04) Renumber offline orders, or keep their number? (POS-05)
13. **`Sample_image/`:** origin, and where should it live? (SEC-07)

## 6. Checked and clean (highlights)
- **Security:**
  - every `/v1` route is guarded (177 routes dumped from the real router); identity types are separated (print agent, staff, customer)
  - the kitchen role cannot confirm payments; rule-9 actions need step-up and write audit
  - session lifetimes and the PIN lock ladder are as documented; WebSocket auth and immediate revocation work
  - LINE HMAC over the raw body with dedup; LIFF token verified with LINE
  - the Web Push allow-list refused all 44 bypass cases; the push click-through stays same-origin
  - pino and Sentry scrubbing; retention jobs scheduled; slip keys random and private
  - strict CSP on both web apps; no XSS sinks; only `.env.example` files tracked
- **Money:**
  - every D-27 auto-confirm gate except the date (PAY-01) held: receiver, ceiling, duplicates, races; Slip2Go failures stay `claimed` (fail-closed)
  - totals are computed only by the server, and the QR amount follows order edits
  - cash change, void, refund and method change; co-pay limits and the "estimate" labels
  - the 2569 tax brackets and the 0.5% rule; no float maths on money
- **Backend:**
  - state machines and publish-after-commit; `expectedVersion` required; order numbering and the payment-confirm race
  - print claim, lease and late acks; resync after restart; cron time zone
  - migrations 0000–0042 contiguous and never edited after commit; no local-time day maths on the server
- **LINE:** rule 4 holds in code (no path sends a ถุงเงิน QR); reply-first.
- **UI:**
  - th/en catalogues complete (1887 keys each)
  - status shown as colour + icon + word
  - no horizontal overflow on the staff screens checked
  - payment gating seen live: modifiers required, recipient required, confirm disabled until the cash covers the total

## 7. Run ledger (breadcrumbs)

| # | Run | Result | What it ruled in or out |
|---|---|---|---|
| L1 | `pnpm test`, alone | 12/12 green, counts up | no unit or integration regression |
| L2 | `pnpm build` | 16/16 | typecheck clean |
| L3–L4 | `pnpm lint`, then `biome check apps packages` | exit 1, then 0 | errors only in untracked files (MAIN-03) |
| L5 | `pnpm audit --prod` | 2 advisories, exit 1 | CI will fail at the audit step (OPS-03) |
| L6–L10 | Live pass on the dev mock (iPad, iPhone, dark mode, kitchen, laptop) | flows gate correctly; dark mode only on the kitchen by design; sound preference persisted in Dexie | MAIN-01, MAIN-02 found; "sound lost on reload" disproved |
| L11 | pos-web E2E matrix under load | iPad Chromium and WebKit 1 ✗ each (tap targets) | candidate MAIN-05 |
| L12 | the failing test alone | Chromium ✓, Firefox ✓, WebKit crashed | test failure is flaky, so measure directly |
| L13 | direct measurement on the settled iPad payment page | method chips computed `40px` | defect confirmed; test is timing-dependent |
| L14 | liff-web E2E matrix | 4 × 7/7 | customer flow green in fakes |
| L15 | Reran the PAY, POS and BE repros | 10/10, 4/4, 4/4 | PAY-01, PAY-05, POS-01, POS-03, BE-01, BE-02 reproduce |
| L16 | Code read: `ci.yml`, repo visibility file, i18n co-pay keys, `auth/routes.ts` | as reported | OPS-03, OPS-01, LINE-01, SEC-01 verified |

The detailed per-area reports, with full repro steps and evidence (SEC, PAY, LINE, POS, BE, UX, OPS, MAIN), were written to the session scratch folder. They are temporary; this file is the durable record.
