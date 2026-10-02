# 01 · Requirements

## 1. Context
**แซ่บโดนเส้น (Saap Don Sen)** is a made-to-order restaurant inside a condominium. The owner wants a cloud-hosted POS that:
- takes orders at the storefront and through the shop's LINE Official Account;
- takes payment by cash, PromptPay or a government co-pay scheme, always confirmed by staff;
- stays in sync in real time across the iPad, iPhone and laptop;
- produces revenue, customer, menu-performance, cost/profit and tax figures.

It must run unattended 24/7, on free tiers wherever possible, with no on-site server. A Mini PC and a kitchen printer come later.

## 2. Goals and success criteria
| Goal | Measured by |
|---|---|
| Fast counter service | An order with modifiers can be entered in ≤ 20 s. The change calculation needs no mental maths. |
| Nothing missed from LINE | A LINE order appears on every staff device with a sound within 2 s. |
| Exact payment amount | Every PromptPay QR encodes the shop's current PromptPay ID and the exact order total. Verified in the owner's bank app(s): **1 app at P1**, more when the owner decides. |
| One truth across devices | A change on one device shows on the others in < 1 s (p95), with no stale screens after reconnecting. |
| Useful numbers | Daily, monthly and yearly revenue, top items, P&L and a tax estimate are available without spreadsheets. |
| ฿0 running cost | No recurring bill except a domain. The LINE plan is upgraded only if volume needs it. |
| Easy to change later | Clear module boundaries, a decision log, and a checkpoint per phase. |

## 3. Actors and devices
| Actor | Uses | Notes |
|---|---|---|
| Owner | iPhone, laptop, iPad | Everything, including settings, PromptPay ID, reports and tax. |
| Cashier | iPad (main counter) or iPhone | Order entry, payments, order board. |
| Kitchen | iPad/iPhone kitchen view; printer in P8 | Sees the order queue, marks orders ready. |
| Walk-in customer | Counter; iPad customer-facing QR screen | May pay cash, PromptPay or gov co-pay. |
| LINE customer | LINE app: OA chat + ordering app | Orders, pays, tracks status, chats with staff. |
| Delivery platform | Grab / LINE MAN merchant apps | Orders keyed into the POS by staff. |

The laptop is for the back office, not a cashier terminal. The AIS router provides the shop's internet. A phone with mobile data acts as backup.

**How staff reach the POS:** through **Safari on iPad and iPhone** (Add to Home Screen recommended) and **standard web browsers on computers**. Native installable apps come later (X4, phase P10).

## 4. Functional requirements

### Menu (M)
- **M1** Staff with the manager role or above manage categories, items and modifiers:
  - items: Thai/English name, price, estimated cost, photo, description;
  - modifier groups and options, e.g. noodle type, spice level, extras with a price change.
- **M2** Marking an item sold out ("หมด") takes effect at once on every device and on the LINE menu.
- **M3** Availability and price can differ by channel (storefront/LINE vs Grab/LINE MAN).
- **M4** Photos are resized and served from a CDN.

### Storefront ordering (S)
- **S1** Touch-first order entry: category grid, search, modifier sheet, notes, quantity, dine-in or takeaway. A customer (nickname, phone or LINE) can optionally be attached.
- **S2** Order numbers form one daily sequence with a channel letter, e.g. S-012, L-013, G-014, M-015. The sequence resets at the business-day cutoff.
- **S3** An order can be edited before payment, with a conflict check between devices. After payment it can only be voided or refunded, by a manager, with a reason.
- **S4** Delivery-platform orders are entered with platform, platform order code, platform prices and commission.
- **S5** Order board and kitchen view: New → Preparing → Ready → Completed, with timers, large text and a sound for new orders.
- **S6** Customer-facing display: any logged-in device (usually the counter iPad) can show the total and the PromptPay QR in large type.

### LINE ordering (L)
- **L1** The LINE OA has a rich menu: สั่งอาหาร (order), ออเดอร์ของฉัน (my orders), เมนู (menu), ติดต่อร้าน (chat).
- **L2a** Returning customers (added 2026-09-29): the app remembers the room number and past orders, and offers quick reorder of a previous order.
- **L2** The customer app inside LINE covers:
  - menu with photos and live availability, modifiers, cart and notes;
  - fulfilment: pickup, or delivery to a room inside the condo (see Q2);
  - payment method: PromptPay, cash, or gov co-pay while a scheme is active.
- **L3** After ordering, the chat receives a confirmation sent as a free reply:
  - **PromptPay:** a QR image for the exact amount, plus the PromptPay ID and amount as text;
  - **Cash:** "unpaid, pay at pickup";
  - **Gov co-pay:** "pay at the storefront with เป๋าตัง" (never a QR; see D-08).
- **L4** The customer can change the payment method while the order is unpaid, from the app or from chat buttons. The POS updates immediately.
- **L5** The customer can tap "โอนแล้ว" (I've paid) or send a slip image. The order becomes *awaiting confirmation* for staff.
- **L6** A live order-status page lives in the customer app. A push message is sent only for "ready", depending on the quota policy (D-09).
- **L7** Staff answer questions by hand in the LINE OA Manager app, which works alongside the bot and is free.
- **L8** The customer app shows a privacy notice and records consent to it (PDPA).

### Payments (P)
- **P1** Payment methods: cash, PromptPay transfer to the shop QR, gov co-pay (ไทยช่วยไทย), and platform (settled by Grab or LINE MAN). Each can be switched on or off.
- **P2** The PromptPay QR follows EMVCo in dynamic mode and carries the shop's PromptPay ID and the exact amount. It is regenerated whenever the total changes.
- **P3** The PromptPay ID (phone, national ID or e-wallet ID) can be changed by the **owner only**, after re-entering the password, with an audit entry and an alert.
  - **Initial value: `0642230924`.** It lives in settings and seed data, never in code.
- **P4** Cash change calculator:
  - quick tender buttons (exact, ฿20/50/100/500/1000) and a keypad;
  - change = tendered − total, with an optional note/coin breakdown;
  - no cash drawer.
- **P5** Staff confirm every payment by hand. The system records who confirmed it and when, with an optional reference such as the last digits of the transfer or a ถุงเงิน reference.
- **P6** The payment method can be changed until the payment is confirmed. Every change is kept in the history.
- **P7** Voiding or refunding after confirmation needs a manager or the owner, plus a reason, and is written to the audit log.
- **P8** Gov co-pay flow:
  - the POS shows the full amount to type into ถุงเงิน, plus an *estimated* government/customer split;
  - it enforces the scheme's dates and hours and allows only face-to-face payment (counter or entrance hand-over, D-08).
- **P9** The data model supports split payments (e.g. part cash, part transfer). The UI for them is a stretch goal in P3.

### Realtime (R)
- **R1** Changes to orders, payments, menu, availability and settings appear on every staff device within about 1 s, and on the affected customer's status page.
- **R2** Devices catch up automatically after a disconnect.
- **R3** During an internet outage the storefront keeps taking orders and cash/PromptPay payments. They sync when the connection returns.

### Customers (C)
- **C1** Each customer record holds:
  - from LINE: `userId`, display name, picture;
  - optional: phone, room, nickname;
  - order history, first and last visit, frequency and spend.
- **C2** Segments (new, regular, lapsed) and each customer's favourite items.
- **C3** A customer's data can be deleted or anonymised on request (PDPA). Financial records are kept.

### Back office (B)
- **B1** Today dashboard: sales, number of orders, average ticket, split by channel and payment method, and the unpaid / awaiting-confirmation list.
- **B2** Day, week, month and year reports, compared with the previous period, with charts.
- **B3** Best and worst items by quantity, revenue and profit, and a menu-engineering matrix (popularity × margin).
- **B4** Heatmap of hour × weekday.
- **B5** CSV/XLSX exports for the accountant.

### Costs and profit (F)
- **F1** Item costs: an estimate per item plus cost changes per modifier. Recipe/ingredient costing can follow.
- **F2** Expense ledger with receipt photos. Categories: ingredients, packaging, gas, utilities, rent, staff, platform fees, equipment, other.
- **F3** Profit and loss for any period: revenue − cost of goods − platform commissions − expenses = profit or loss, with margin %.
- **F4** Pricing helper: suggests a price from a target food-cost %.

### Tax (T) — estimates only, not filings
- **T1** Yearly personal income tax estimate for business income under section 40(8):
  - compares the flat 60% deduction with actual expenses;
  - uses allowances entered by the owner and the progressive brackets;
  - applies the 0.5% method when non-salary income is ≥ ฿1M;
  - shows which method gives the lower tax.
- **T2** Mid-year estimate (ภ.ง.ด.94) for January–June.
- **T3** VAT threshold watch: rolling 12-month revenue against ฿1.8M, with an alert at 80%.
- **T4** e-Payment reporting awareness: count of incoming transfers per bank against the reporting thresholds.
- **T5** Export of the cash receipts–payments report. The format must be confirmed with the accountant.
- **T6** Tax rules are stored as data per tax year. The UI shows which year's rules it used, with a disclaimer.

### Settings and admin (A)
- **A1** Settings cover:
  - shop profile, opening hours and business-day cutoff;
  - payment methods, PromptPay ID and the gov co-pay scheme;
  - LINE message policy;
  - staff, roles and devices.
- **A2** An audit log records every action that affects money or security.
- **A3** **Opening hours** (added 2026-09-29):
  - a weekly schedule for storefront (default 11:00–23:00) and delivery (default 13:00–23:00);
  - **per-day overrides**: changed hours, closed days, "pause LINE orders now".

  The customer app and LINE replies respect it and say when ordering reopens.
- **A4** **Customizable look** (added 2026-09-29): brand name, logo, colours and fonts come from design tokens and can be changed in settings without code. Design sources live in Figma / Claude Design.
  - **Per-device customization** (added 2026-09-29): **iPad, iPhone and laptop/desktop** each have their own layout and adjustable settings, independent of the other two (e.g. grid columns, text and button size, density, which panels show). Base tokens are shared, and each device class overrides them. P1 builds the token structure and mockups for all 3; P3 adds the settings screen to change them without code.

### Future (X)
- **X1** Kitchen printer (Xprinter XP-80T) through the Mini PC print agent. Each ticket shows:
  - the order number and source (in-store, LINE, Grab, LINE MAN, delivery or pickup);
  - items, modifiers and notes.

  Reprinting is supported; receipts come later.
- **X2** ntfy notifications to phones, with a thumbnail and an alarm-level priority.
- **X3** The Mini PC as a local hub for resilience. Decision pending (P9).
- **X4** Native installable apps built from the same code (P10, D-19):
  - iPad and iPhone (Capacitor);
  - Windows, macOS and Linux (Electron).

  They add reliable alarms/push, keep-awake, secure token storage and direct LAN printing.

## 5. Non-functional requirements
| ID | Requirement |
|---|---|
| N1 Availability | Cloud services run 24/7. The API targets ≥ 99.5% a month. The storefront keeps working offline. |
| N2 Latency | Realtime propagation < 1 s (p95). POS actions < 300 ms of server time. The customer menu's first load < 3 s on 4G. |
| N3 Cost | ฿0 a month on free tiers. The only fixed cost is a domain (about US$10 a year). |
| N4 Security | HTTPS only. Inbound ports on the VM limited to 80/443 for Caddy (interim, D-10) or none with a Cloudflare Tunnel once a domain exists; SSH restricted to the owner. Role-based access. Audit trail. Secrets never in git. |
| N5 Privacy | Follows PDPA: a notice, the minimum data needed, retention rules, deletion on request. |
| N6 Durability | Lose at most 1 hour of data (RPO). Back online within 2 hours (RTO). A restore drill every month. |
| N7 Usability | iPad-first touch UI with targets ≥ 44 pt and kitchen-readable contrast. Correct Thai typography. Works in LINE's in-app browser and with one hand on an iPhone. |
| N8 Maintainability | Modular monorepo with enforced boundaries, decision log, checkpoints, and tests for all money logic. |
| N9 Observability | Health checks, error tracking, backup monitoring, and alerts for LINE quota and free-tier usage. |
| N10 Localisation | Thai by default with an English toggle. ฿ formatting. Buddhist Era or Common Era dates. |
| N11 Supported clients | Staff: Safari on the current and previous major iPadOS/iOS, in a tab or added to the Home Screen; current Chrome, Edge and Firefox on Windows/macOS/Linux; Safari on macOS. Customers: the LINE in-app browser on iOS and Android. |

## 6. Requirements changed after research
These change the original brief. Details and sources are in [04-integrations.md](04-integrations.md) and [06-legal-compliance.md](06-legal-compliance.md).
- **CR1 Gov co-pay through LINE.** The ถุงเงิน QR is created per transaction for the full amount and expires. It must be scanned **at the storefront**, with GPS on and not from an image. So a LINE customer who picks ไทยช่วยไทย pays in person at pickup, and **the QR is never sent in chat**. The chat message explains how to pay instead.
- **CR2 "The customer confirms payment".** This is read as: the customer says they have paid (button or slip), then staff confirm after checking the bank app. A slip on its own never marks an order paid, because fake slips are common. To be confirmed in Q4.
- **CR3 Schemes are time-limited.** ไทยช่วยไทย พลัส (additional round) runs **1 Oct – 30 Nov 2026**, probably before go-live. The method is therefore generic, configurable and off by default.
- **CR4 "Real time everywhere"** covers staff devices and the customer's status page. It does **not** mean a LINE chat message for every status change, because of the 300-message quota.
- **CR5 Delivery platforms** are entered by hand. Grab and LINE MAN offer no direct API to small merchants.

## 7. Out of scope for now
Card or e-wallet payment gateways · automatic transfer verification · cash drawer · QR self-ordering at tables · multiple branches · loyalty points · e-Tax invoices · full ingredient inventory (optional in P7) · direct Grab/LINE MAN integration.

## 8. Working assumptions (until [10-open-questions.md](10-open-questions.md) is answered)
- **A1** (Q3 still open) The owner trades as an individual (บุคคลธรรมดา), is not VAT-registered, and is registered with ถุงเงิน.
- **A2** One shop and one menu.
- **A3** **Confirmed:** the owner is the only staff member. Devices: an iPad, an iPhone and a computer. Roles stay in the model for future hires.
- **A4** ~~Assumption~~ **Confirmed (Q1):** the Oracle VM is a VM.Standard.E2.1.Micro (1 GB RAM, ap-singapore-1, Ubuntu 24.04) on a Free Tier account, so Path B applies.
- **A5** **Confirmed:** LINE orders are picked up at the counter or delivered to condo rooms. Payment is by PromptPay, ไทยช่วยไทย or cash; ไทยช่วยไทย is offered for pickup only until the scheme terms confirm delivery (Q2).
- **A6** **Confirmed hours:** storefront 11:00–23:00, delivery 13:00–23:00, adjustable per day. Volume is still assumed at 50–150 orders a day.
- **A7** The owner maintains the system with Claude Code.
