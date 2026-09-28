# 10 · Open Questions for the Owner

Answer under each question, or just reply in chat and Claude will record the answer here. Until then the **default** is used (and appears as an assumption in [01-requirements.md](01-requirements.md#8-working-assumptions-until-10-open-questionsmd-is-answered)).

The first five questions change the design; the rest refine it.

---

### Branding (asked 2026-09-29)
- **Answer:** no logo, colours or fonts yet. The ux-ui-designer agent proposes an initial style. The UI must stay **fully customizable**: design tokens, design work in Figma / Claude Design, and brand settings changeable later without code.

### Banking apps for PromptPay tests (asked 2026-09-29)
- **Answer:** **K PLUS (Kasikorn)** and **Krungthai NEXT**. PromptPay `0642230924` is the owner's **personal account, for testing only**. The real shop account will be provided later and set in settings (P3). The Phase 1 scan test uses **1 app** (K PLUS or Krungthai NEXT, the owner's choice); more apps when the owner decides (updated 2026-09-29). **P1 test app chosen (2026-09-29): K PLUS.**

### Q1 · Oracle VM: shape, region and account type
Which shape is the VM: **VM.Standard.A1.Flex (ARM)** or **VM.Standard.E2.1.Micro (AMD, 1 GB)**? How many OCPUs and how much RAM, in which region? Is the account **Always Free only** or **Pay-As-You-Go**?
- *Why it matters:* A1 → Path A, everything on the VM. Micro → Path B, with the database on Supabase. PAYG stops Oracle reclaiming an idle VM.
- *Default:* A1 Flex, and you upgrade to PAYG with a US$1 budget alert.
- **Answer (2026-09-29, from the owner's OCI console screenshots):** **VM.Standard.E2.1.Micro** (AMD, 1 OCPU shown, 1 GB RAM, 0.5 Gbps), region **ap-singapore-1** (AD-1, FD-1), Ubuntu 24.04, login user `ubuntu`. The account is **Free Tier, not PAYG**. Full record in [infra/oracle/README.md](../infra/oracle/README.md). → **Path B** (database on managed Postgres).

### Q2 · How are LINE orders fulfilled?
Pickup at the storefront only? Delivery to rooms in the condo (by your staff)? Dine-in orders placed through LINE?
- *Why it matters:* checkout fields (room number); whether gov co-pay is possible for that order (it must be face-to-face at the storefront); whether payment is required before cooking.
- *Default:* pickup + room delivery. Gov co-pay allowed for pickup only.
- **Answer (2026-09-29):**
  - **Both** pickup at the counter and **delivery to a condo room**. The customer enters the room number; the system remembers returning customers (room, usual orders) and offers conveniences such as quick reorder.
  - LINE payment choices: **PromptPay QR**, **ไทยช่วยไทย 60/40**, and **cash** (paid at the counter or at hand-over; staff charge it on the POS and confirm).
  - For PromptPay and ไทยช่วยไทย the customer sends proof through the shop's LINE or shows it to staff, and **staff confirm by hand**.
  - ⚠️ **Compliance point still open:** ไทยช่วยไทย must be scanned face-to-face at the storefront with GPS. Paying it for **room delivery** (at the door, or remotely) may break the scheme terms. Until the ถุงเงิน terms confirm it, the system offers ไทยช่วยไทย for **pickup only**; room-delivery customers pay by PromptPay or cash.

### Q3 · Business and tax status
Is the shop **already trading**? Do you trade as an individual (บุคคลธรรมดา) or a company? Do you have commercial registration and a food-premises certificate? Are you registered in ถุงเงิน (with a Krungthai account)? Are you VAT-registered? Do you have an accountant?
- *Why it matters:* tax rules in the finance module; whether **ภ.ง.ด.94 for Jan–Jun 2026 is due this month**; whether gov co-pay can be offered at all.
- *Default:* individual, not VAT-registered, ถุงเงิน registered, trading already.
- **Answer:**

### Q4 · What does "the customer confirms payment" mean?
(a) The customer taps "โอนแล้ว" or sends a slip, **then staff confirm** after checking the bank app. (b) Staff alone confirm, and there is no customer button. (c) Something else.
- *Why it matters:* LINE flow, statuses and SOPs. A slip alone never marks an order paid (fake slips).
- *Default:* (a).
- **Answer (2026-09-29): (a).** The customer sends the slip through the shop's LINE (or shows it at the counter), and **the owner confirms it by hand**. It is purely a staff responsibility now. Automatic confirmation (Stripe-like) is a possible future feature, not in scope.

### Q5 · Staff, devices and the customer-facing QR
How many staff and in which roles? How many iPads and iPhones? Which screen shows the PromptPay QR to walk-in customers (the counter iPad turned around, or a second device)? Do you want a separate kitchen screen?
- *Default:* 2–4 staff; 1 counter iPad (it also shows the customer QR); 1–2 iPhones; kitchen view on an iPhone until the printer arrives.
- **Answer (2026-09-29):** the **owner is the only staff member** and does everything (counter, cooking, delivery). Keep the role model for future hires, but the default setup is one owner account.

### Q6 · Menu shape
About how many items? Which modifiers (noodle type, spice level, extra toppings with prices)? Are Grab / LINE MAN prices different from shop prices? Do you have photos?
- *Default:* 30–60 items; modifiers yes; platform prices differ; photos later.
- **Answer (2026-09-29):** no real menu yet, so use **placeholder items**. The system must allow full editing: add, delete and modify items, images, names, descriptions, prices and options.

### Q7 · Hours and volume
Opening hours (do you close after midnight?), and typical and peak orders per day. Roughly what share comes through LINE, the storefront and delivery?
- *Why it matters:* business-day cutoff and LINE quota budget (300 pushes a month ≈ 10 LINE orders a day).
- *Default:* 10:00–22:00; 50–150 orders a day; LINE about 20%.
- **Answer (2026-09-29):** standard hours are **storefront 11:00–23:00** and **delivery 13:00–23:00**. Hours must be **manually adjustable** (per-day changes, closures), because actual times vary. Order volume not given; the default stays.

### Q8 · Spending limits
Is it OK to (a) buy a domain (≈ US$10 a year)? (b) add a card to Oracle for PAYG (still ฿0 inside Always Free)? (c) upgrade LINE to Basic (฿1,280 a month) if LINE orders exceed about 250 a month?
- *Default:* (a) yes, (b) yes, (c) decide when the quota tracker warns.
- **Answer (2026-09-29):** (a) no domain for now (D-10 interim: Caddy on a free hostname); (b) stay on Oracle **Free Tier**; (c) not decided yet.

### Q9 · Tech stack comfort
Are you comfortable with TypeScript, React and Node? Will anyone besides you (with Claude Code) maintain it?
- *Default:* the stack in [decisions.md](decisions.md), maintained by you with Claude Code.
- **Answer (2026-09-29):** go with the stack in decisions.md (TypeScript, Fastify, React, Supabase Postgres), adjusting where appropriate.

### Q10 · Existing accounts
Does the LINE OA "แซ่บโดนเส้น" already exist (plan, followers)? Is the GitHub repo `omeieee/Pos` private? Do you already own a domain?
- *Default:* new OA; the repo is private (it will contain the PromptPay ID in seed data, so keep it private).
- **Answer (2026-09-29):** the GitHub repo is **private**. **LINE OA: already exists** (added 2026-09-29), but it is **not yet connected to the Messaging API** (no bot/webhook) and has **no ordering UI** (no rich menu or customer app). P4 connects it; ask for its name/ID and plan at P4 kickoff. Commit/push permission for Claude: **not given yet**, so ask at the start of P1.
- **P1 kickoff answers (2026-09-29):**
  - Claude **may commit and push directly** to `origin/main` on GitHub.
  - Claude Code hooks may go in the shared `.claude/settings.json`.
  - Wireframes: deliver **both** HTML pages in `design/` and Figma.
  - **New requirement:** UX/UI mockups and customization that can be adjusted **independently for each of the 3 devices** (iPad, iPhone, laptop). Recorded as A4 per-device customization.
  - `corepack enable pnpm` approved. Installed pnpm 12.6.0 with shims in `%APPDATA%\npm`, because the default `Program Files\nodejs` needs admin.
  - **Supabase project replaced:** the new ref is `yejvrooxqdpynruwnegg`, and `.mcp.json` was updated with the same features. The old ref `msxzudufpewhdramjihv` no longer resolves. **Region confirmed: Singapore (AWS `ap-southeast-1`).** Checked by mapping the IPv6 address of `db.yejvrooxqdpynruwnegg.supabase.co` to AWS's published IP ranges. This puts it next to the VM in `ap-singapore-1`.
- **P1 start answers (2026-09-29):**
  - Owner said go for P1 and authorized the needed changes.
  - Supabase MCP authenticated. Security advisor fix applied: `revoke execute on public.rls_auto_enable()` from `public, anon, authenticated` ([infra/supabase/bootstrap.sql](../infra/supabase/bootstrap.sql)). The function and its `ensure_rls` event trigger are kept, because they turn on RLS for new `public` tables.
  - PromptPay scan test app: **K PLUS**.
  - Wireframes: **HTML only in P1.** Figma (team "ome's team", Starter plan, few MCP calls a month) comes later.

### Q11 · Receipts
Do customers need receipts? E-receipt in LINE, printed (after P8), or both? Does anyone ask for a tax invoice?
- *Default:* e-receipt on request through LINE; printed receipts in P8.
- **Answer:**

### Q12 · Cost tracking depth
Will you record ingredient purchases and fixed costs? Is an estimated cost per menu item enough to start, or do you want recipe (ingredient-level) costing?
- *Default:* item-level estimate + expense ledger; recipe costing optional in P7.
- **Answer (2026-09-29):** the owner will provide cost details later. Ask again before P7.

### Q13 · Native apps (P10)
You want installable apps for iPad, iPhone and Windows/macOS/Linux.
1. Which should come first: desktop or iPad/iPhone?
2. Are you OK with the **Apple Developer Program at US$99 a year**? It is required to install your own app on iPads/iPhones beyond short-lived test installs, and to sign Mac apps.
3. Do you have, or can you borrow, a **Mac**? iOS and Mac builds need Xcode, which only runs on macOS. Cloud Mac build services are the alternative.
4. Which computers will run the desktop app (Windows only, or also macOS/Linux)?
- *Why it matters:* it decides the order and cost of P10. Desktop costs ฿0; iOS needs the fee and a Mac.
- *Default:* desktop (Windows) first; iOS after the fee is accepted and Mac access is sorted.
- **Answer (2026-09-29):** native apps are a **future project, not in current scope**, for any platform. The owner plans to **buy a MacBook later** to use Xcode for iPad/iPhone deployment. The platform order and the Apple fee are decided when P10 starts.
