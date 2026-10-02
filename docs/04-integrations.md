# 04 · Integrations

Facts marked ✅ were checked against the linked source in **September 2026**. Facts marked ⚠️ come from general knowledge and should be re-checked when the phase that needs them starts.

## 1. LINE platform

### 1.1 What to set up
1. One **LINE provider**, e.g. "Saap Don Sen". Every channel below lives under it, because a customer's `userId` is only the same across channels of the same provider.
2. **LINE Official Account** "แซ่บโดนเส้น" on the free plan, with the Messaging API enabled. That creates the **Messaging API channel**.
3. **Response settings:** Chat **on** (staff answer by hand in the LINE OA Manager app), Webhook **on**, Auto-response **off** (the bot handles it), Webhook redelivery **on**.
4. The **customer ordering app:** a **LINE MINI App channel (unverified)** built with the LIFF SDK. Fallback: a LIFF app on a LINE Login channel.
   - Scopes: `openid`, `profile`, and `chat_message.write` (needed for `liff.sendMessages`).
   - Turn on the add-friend prompt so customers who order also follow the OA.
5. A **second, private "test" OA** with its own channels, for development. Real customers never receive test messages.

✅ LINE recommends creating new LIFF apps as LINE MINI Apps and plans to merge LIFF into MINI App. Unverified MINI Apps can be created without review, with some features restricted. For Thailand, verification is only possible through a certified provider; since 11 Mar 2026 MINI App channels can be created for Thai services. Service messages (free transactional notifications) are only available to verified MINI Apps. Sources: [LINE MINI App intro](https://developers.line.biz/en/docs/line-mini-app/discover/introduction/), [LIFF→MINI App news](https://developers.line.biz/en/news/2025/02/12/line-mini-app/), [service messages](https://developers.line.biz/en/docs/line-mini-app/develop/service-messages/).

### 1.2 Message budget (the main LINE constraint)
✅ **Thailand plans (since Aug 2024, still current):**

| Plan | Price | Messages that count |
|---|---|---|
| Free | ฿0 | 300 a month |
| Basic | ฿1,280 a month | 15,000 a month |
| Pro | ฿1,780 a month | 35,000 a month |

✅ **Counted:** push, multicast, broadcast and narrowcast. **Not counted:** reply messages, 1:1 chat, auto-responses, greeting messages.

Sources: [LINE pricing](https://developers.line.biz/en/docs/messaging-api/pricing/), [LINE TH package change 2024](https://lineforbusiness.com/th/news/20240619_1), [what counts (LINE TH)](https://lineforbusiness.com/th/news/20221216_1).

**Design rules**

| Situation | How it is sent | Cost |
|---|---|---|
| Customer places an order | The app calls `liff.sendMessages("ยืนยันออเดอร์ #L-012")`, the webhook gets a replyToken, and the bot **replies** with the Flex summary + QR | Free |
| Customer changes payment method, taps "โอนแล้ว", sends a slip, or asks "สถานะ" | Reply | Free |
| New follower | Reply to the `follow` event (greeting + how to order) | Free |
| Order ready | Push (policy `ready-only`) | 1 |
| Staff re-send a QR or start a message | Push, or a manual chat in OA Manager (free) | 1 or 0 |
| Promotions / broadcasts | Only if budget remains; never automatic | 1 per recipient |

Budget arithmetic: about 1 push per LINE order means **about 300 LINE orders a month (about 10 a day) on the free plan**.

The quota tracker reads LINE's quota and consumption endpoints, logs each push in `line_message_log`, warns at 80%, and switches the policy to `off` at 100%. Customers can still see status on the live status page and with the "สถานะ" button, both of which are free.

### 1.3 Webhook handling (`api/modules/line`)
1. Check `X-Line-Signature`: HMAC-SHA256 of the **raw** body with the channel secret, base64-encoded. Reject if it doesn't match.
2. Store the event in `line_events` keyed by `webhookEventId`. If it is already there, skip it, because redelivery can repeat events.
3. Handle the event quickly and use the reply token right away. Reply tokens are single-use and expire soon after the event; see the [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/). Anything slow goes to a pg-boss job that sends a push only if the policy allows.
4. Events handled:

| Event | What happens |
|---|---|
| `follow` | Upsert the customer; reply with a greeting |
| `unfollow` | Mark the customer as unfollowed |
| `message:text` | Order-confirmation pattern, or keywords (`เมนู`, `สถานะ`, `ติดต่อ`) → reply |
| `message:image` | If the customer has an unpaid PromptPay order: download the content now, store it as the slip, set the payment to `claimed`, alert staff, reply |
| `postback` | Change payment method · cancel · "โอนแล้ว" |

5. Other chat messages are left for staff, who answer in OA Manager.

### 1.4 Rich menu (art belongs in `design/`)
Size 2500×1686 (six areas) or 2500×843 (three areas) ⚠️ confirm current specs.

Suggested areas: **สั่งอาหาร** (open the app) · **ออเดอร์ของฉัน** (app status page) · **เมนูวันนี้** · **วิธีชำระเงิน** · **ติดต่อร้าน** (tells staff someone is waiting) · **เวลาเปิด-ปิด**.

### 1.5 Customer app notes (`apps/liff-web`)
- Identity: `liff.getIDToken()` → `POST /v1/auth/line`. The server verifies the token with LINE and uses the `sub` claim as the `userId`.
- Keep the bundle small (target < 200 KB JS gzipped). Menu images are served resized from R2/CDN.
- `sendMessages` only works when the app was opened from the OA chat or rich menu. Otherwise the app shows the QR itself.
- The privacy notice appears on first use, and the acknowledgement is stored in `customers.privacy_ack_at`.

## 2. PromptPay QR (`packages/promptpay`)

### 2.1 Payload (EMVCo merchant-presented QR, BOT PromptPay profile)
| Tag | Meaning | Value |
|---|---|---|
| `00` | Payload format | `01` |
| `01` | Point of initiation | `12` dynamic (amount included). `11` means static |
| `29` | Merchant account, PromptPay | sub `00` AID `A000000677010111`; sub `01` mobile, as `0066` + number without its leading 0; or sub `02` national/tax ID (13 digits); or sub `03` e-wallet ID (15 digits) |
| `53` | Currency | `764` (THB) |
| `54` | Amount | e.g. `75.00` |
| `58` | Country | `TH` |
| `63` | CRC | CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`) over the whole string **including** `6304`, as 4 uppercase hex digits |

Every field is TLV: 2-digit tag, 2-digit length, value. `00` comes first and `63` last.

**Worked example** for the initial PromptPay ID `0642230924` and ฿75.00. The phone becomes `0066642230924` (13 digits):
```
00 02 01 | 01 02 12 | 29 37 [00 16 A000000677010111][01 13 0066642230924] | 53 03 764 | 54 05 75.00 | 58 02 TH | 63 04 ????
→ 00020101021229370016A000000677010111011300666422309245303764540575.005802TH6304????
```
The P1 tests compute the CRC, then compare the decoded TLV fields and the CRC with the reference npm library `promptpay-qr`.

### 2.2 Rules
- The amount always comes from the server-computed order total, and the QR is regenerated whenever the total changes.
- The screen shows the amount and the shop name large, next to the QR.
- The PromptPay ID comes from `settings.promptpay`. Only the owner can change it, with step-up auth, audit and alert (D-17).
- SOP for staff and customers: the bank app shows the recipient's name. It must match the shop owner's account name.

### 2.3 The "same phone" problem (LINE customers)
A customer cannot scan a QR that is on their own screen. The flow therefore:
1. sends the QR as an **image message** (a free reply), so the customer can save it and use "scan from gallery" in their bank app;
2. shows the PromptPay ID and the exact amount as copyable text, for a manual transfer;
3. offers the "โอนแล้ว" button and slip upload.

### 2.4 Checking that it works (P1 exit criterion)
- Unit tests against the reference library for a range of amounts (฿0.01 up to ฿99,999.99), all ID types, and CRC edge cases.
- Real scans in the owner's bank app: **1 app at P1** (K PLUS or Krungthai NEXT); more apps when the owner decides. Each must show the right recipient name and exact amount, with the amount locked. Record the results in the Phase 1 checkpoint.

### 2.5 Manual confirmation: risks and optional helpers
- **Fake slips are common.** Staff must confirm from the bank app's incoming-transfer notification, never from the slip image alone.
- Optional (setting, off by default): add a few random satang to the amount (e.g. ฿75.03) so several orders at the same price can be told apart in the bank app.
- Optional (P9): read the mini QR printed on Thai bank slips to catch a slip that has been reused for another order. This works offline and costs nothing. It is not full verification.

## 3. Government co-pay scheme (Thai Chuay Thai Plus)
Thai name: ไทยช่วยไทย พลัส 60/40.

### 3.1 Facts (checked Sept 2026)
- **Split:** the government pays 60% and the customer 40%. The government pays at most **฿200 per person per day**.
- **Additional round:** runs **1 Oct – 30 Nov 2026**, with a government cap of **฿1,000 per person** for the whole round. Merchants confirm their participation in ถุงเงิน. **Owner-provided parameters (2026-10-01):** government 60% / customer 40%; government subsidy capped at ฿200 per person per day and ฿1,000 per person for the round; active 06:00–23:00 Asia/Bangkok; ends 2026-11-30 23:59:59. (The first round ran 1 Jun – 30 Sep 2026.)
- **Hours:** 06:00–23:00 at shops. 06:00–21:00 through food-delivery platforms.
- **Apps:** merchants use **ถุงเงิน**; customers use **เป๋าตัง**.
- **Merchant flow:** in ถุงเงิน, tap ไทยช่วยไทยพลัส, enter the **full price** (the app splits it), create the QR, and show it to the customer. The **QR has a limited lifetime and is used once per transaction.** Don't print it.
- **Customers must scan the shop QR at the storefront.** Scanning from images or other screens fails, and GPS must be on. Merchants, confirm the exact wording in the ถุงเงิน scheme terms.
- **Settlement to the shop:** the customer's 40% arrives the next day at 02:00, and the government's 60% the next day at 17:30. It goes **only to a Krungthai savings account**.
- **Who can join:** individuals who are not juristic persons (except spa, massage, hair and nail businesses), Thong Fah shops, community enterprises, and small juristic persons with revenue ≤ ฿1.8M.
- Merchants who were suspended or had money clawed back in earlier schemes are excluded, so breaking the rules has consequences.

Sources: [PRD merchant registration](https://www.prd.go.th/th/content/category/detail/id/39/iid/505963), [Thai PRD (EN)](https://thailand.prd.go.th/en/content/category/detail/id/48/iid/506070), [The Standard, additional round](https://thestandard.co/thai-chuay-thai-plus-60-40-2/), [Dailynews, merchant flow & settlement](https://www.dailynews.co.th/news/5894215/), [Dailynews, why scans fail](https://www.dailynews.co.th/news/5910202/), [official merchant page](https://www.xn--b3czb2arbbzn9a6eulf7c.th/howto/merchant/index.html).

### 3.2 How the POS supports it
- **Scheme settings** (`gov_copay_schemes`): name, government share, daily cap, active dates and hours, channels (storefront, and the entrance hand-over since 2026-10-02: see D-08), settlement note, enabled. Outside the active window the method is hidden.
- **At the counter:** the cashier picks "ไทยช่วยไทย". The POS shows the **full amount to type into ถุงเงิน** in large type, plus an *estimated* split. Example for ฿95: government ≈ ฿57, customer ≈ ฿38. The estimate ignores the customer's remaining daily cap, which only เป๋าตัง knows.

  Staff create the QR in ถุงเงิน, the customer scans it, staff see the success notice, and then confirm in the POS (optionally with the ถุงเงิน reference).
- **LINE orders:** the method appears as "ไทยช่วยไทย — ชำระที่หน้าร้าน". The free reply explains that payment is made in person at pickup with เป๋าตัง and shows the amount. The order stays `unpaid` until staff confirm at the counter. Room delivery with gov co-pay is **not offered** until Q2 confirms it is allowed.
- **Accounting:** revenue is the full amount on the sale date. The total is a receivable until the next-day settlement. The reconciliation report compares it with the Krungthai statement.

## 4. Delivery platforms (Grab, LINE MAN)
- Direct order APIs are only open to approved POS partners or paid aggregators (for example, Klikit connects to GrabFood and LINE MAN Wongnai). Sources: [Klikit GrabFood TH](https://klikit.io/en/learn/grabfood-integration-thailand), [Klikit LINE MAN](https://klikit.io/en/learn/lineman-wongnai-integration-thailand).
- **POS support:** a quick-entry screen with a platform button, the platform order code, the platform's own price list (`menu_item_channel_prices`) and commission settings per platform (% and/or fixed). Payment method `platform`. The kitchen view and ticket show the source clearly.
- **Payout reconciliation (P7):** enter the platform's payout amount and compare it with expected revenue minus commission.

## 5. Staff notifications
- **MVP:** the realtime `alert.new_order` event plays a sound and shows a banner on staff devices.
  - iOS only allows audio after the first tap, so the POS unlocks sound at login.
  - The counter iPad should use the Screen Wake Lock and have Auto-Lock set to Never.
- ✅ **LINE Notify ended on 31 Mar 2025** ([announcement](https://notify-bot.line.me/closing-announce)). Don't follow old tutorials that use it.
- **P8, ntfy:** self-host ntfy in the Compose stack, with access tokens and private topics (e.g. `kitchen`, `owner`).
  - The API posts: title "ออเดอร์ใหม่ #L-012 (LINE)", the items, priority 5, tags, `Attach` (a thumbnail URL), and `Click` (a link to the order in the POS).
  - For instant iOS delivery through a self-hosted server, set `upstream-base-url: https://ntfy.sh`.
  - ✅ The public ntfy.sh free tier allows about 250 messages a day and 2 MB attachments. Fine for testing; self-hosting has no such limits ([config docs](https://docs.ntfy.sh/config/), [limits issue](https://github.com/binwiederhier/ntfy/issues/1167)).
  - Keep customer names and phone numbers out of notifications.
  - ⚠️ Android gives more alarm control (custom or repeating sounds for high priority) than iOS. For a loud kitchen alarm, an Android phone or tablet is more reliable. Test on the real devices.

## 6. Kitchen printer — Xprinter XP-80T (P8)
- 80 mm thermal printer, USB and LAN, ESC/POS. Give it a **fixed IP** with a DHCP reservation on the AIS router.
- `apps/print-agent` on the Mini PC:
  - keeps an outbound WSS connection to the API, so no ports are opened at the shop;
  - receives print jobs;
  - renders the ticket as a **raster image**, about 576 dots wide (⚠️ confirm the printable width for this model), using a Thai font;
  - sends it with `GS v 0` / `GS ( L`, then a cut command, over TCP 9100.

  Text-mode code pages often garble Thai vowels and tone marks, which is why the ticket is an image. ✅ This is a common issue in ESC/POS libraries ([escpos-php #51](https://github.com/mike42/escpos-php/issues/51)).
- **Ticket content:**
  - the order number, very large;
  - a source badge: หน้าร้าน / LINE / Grab / LINE MAN, and dine-in / pickup / room;
  - the time;
  - items with modifiers and notes;
  - the payment status (PAID / UNPAID).
- **Reliability:**
  - `print_jobs` has a status and retries, and jobs are idempotent per order and kind;
  - the POS has a Reprint button;
  - the agent runs as a service that restarts on failure;
  - the Mini PC's BIOS is set to power on after a power cut, and a small UPS is recommended.
