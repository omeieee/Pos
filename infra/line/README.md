# LINE console setup (owner steps)

Development and the first deploys use the **TEST OA** only. Real customers never receive test messages. Never paste a secret into chat, git or logs: put values in the VM `/opt/sds/.env` (production) or the gitignored `.env.test` (local).

## Variables (names are exact; all optional, the webhook answers 503 until the secret is set)
| Variable | Where in the LINE console |
|---|---|
| `LINE_CHANNEL_ID` | Messaging API channel, Basic settings |
| `LINE_CHANNEL_SECRET` | Messaging API channel, Basic settings (signs the webhook) |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel, Messaging API tab, long-lived token |
| `LINE_LIFF_ID` | LIFF / MINI App channel (used by the customer app and the rich menu link, later slice) |

## Webhook (Messaging API channel, Messaging API tab)
1. Webhook URL: `https://<api host>/v1/line/webhook` (today `https://161-118-211-42.sslip.io/v1/line/webhook`). The IP is reserved (since 2026-10-03), so the URL survives a rebuild.
2. **Use webhook: on.** **Webhook redelivery: on** (the API dedupes by `webhookEventId`).
3. Press **Verify**: the API answers 200 only with a correct secret. A 503 means `LINE_CHANNEL_SECRET` is not set on the server; 403 means the secret is wrong.
4. In LINE Official Account Manager, Response settings: **Chat on**, **Auto-response off**, greeting message off (the bot greets on follow and shows the privacy notice).

## Quota
Free plan: 300 pushes a month (replies, chat and greetings are free). `GET /v1/line/quota` (owners and managers) shows this month's count; the `line_policy` setting holds `push` (`off`, `essential`, `all`), `warnAtPercent` and `monthlyLimit`. Staff-sent manual pushes from OA Manager are not seen by the local count.

## Customer app (LIFF), owner steps
The app is `apps/liff-web` on Cloudflare Pages (`sds-order.pages.dev`). It lives on the LINE Login channel `omeOrderingTest` (same provider as the OA).
1. LIFF app **Endpoint URL**: `https://sds-order.pages.dev` (no path; the app reads `/menu`, `/orders`, `/orders/<id>` from the address, so `https://liff.line.me/<LIFF ID>/orders/<id>` opens that order).
2. **Scopes**: `openid`, `profile`, `chat_message.write` (the last one lets the app say "ยืนยันออเดอร์ #L-012" in the chat so the shop's confirmation is a free reply). Size: Full or Tall. Turn on the **add-friend option** (Normal or Aggressive) on the LINE Login channel and link it to the OA, so people who order also follow.
3. `LINE_LIFF_ID` (`<digits>-<letters>`) goes in the API's `.env`. The API uses its numeric prefix as the channel id to check tokens; `LINE_CHANNEL_ID` (the Messaging channel) is not used for that.
4. GitHub repo variable **`LIFF_ID`** (same value as `LINE_LIFF_ID`; Settings, Secrets and variables, Actions, Variables). `deploy-web.yml` builds it into `apps/liff-web` as `VITE_LIFF_ID` and fails the deploy while it is unset or malformed. `VITE_API_BASE_URL` comes from `API_HOST` as before. `CORS_ORIGINS` already lists `https://sds-order.pages.dev`.
5. Customer API: `POST /v1/app/session` (LIFF ID or access token in, short-lived session out), then `/v1/app/checkout`, `/orders`, `/orders/:id`, `/orders/:id/payment|claim|qr`, `/privacy-ack`. The menu is the public `GET /v1/menu?channel=line`.

## Rich menu (run once; the token never leaves the environment)
From the repo root, with the TEST OA's values in the environment (never typed on the command line, never printed):
```
LINE_CHANNEL_ACCESS_TOKEN=... LINE_LIFF_ID=... pnpm --filter @sds/api richmenu:upload full      # or: compact
```
It reads `design/rich-menu/rich-menu-<variant>.json` and `.png`, fills `{{LIFF_BASE_URL}}` with `https://liff.line.me/<LINE_LIFF_ID>`, then creates the menu, uploads the picture (`api-data.line.me`) and sets it as the default for everyone. A failure prints the step and HTTP status only. Running it again makes a new default menu; delete old ones in the console. Switch to the real OA only by switching the token and re-running.

## What the bot does (all replies are free unless said)
- `เมนู`, `สถานะ`, `เวลาเปิด`, `ติดต่อ`, `วิธีชำระเงิน` and the rich-menu buttons reply with cards. A button never trusts the order id it carries: the order must belong to the person who tapped it.
- After an order the app sends "ยืนยันออเดอร์ #<no>" through `liff.sendMessages` and the bot replies with the confirmation and how to pay. PromptPay: the ID and exact amount as text plus a button that opens the order page (the QR is made fresh there; no QR picture is ever put in a chat card). Cash and ไทยช่วยไทย: words only, and the ถุงเงิน QR is never sent.
- **Quota:** one push per LINE order, when staff mark it completed ("ready + e-receipt"), through the quota-aware sender. Nothing else pushes. At the monthly limit the push is dropped and the owner is warned once (`line.quota_capped`); the receipt then comes free as a reply to `สถานะ`. Policy `off` sends no push at all.

## Not done by code
The add-friend prompt, the LIFF endpoint, and setting `LINE_LIFF_ID` / `VITE_LIFF_ID` are console and deploy steps. Slip pictures are not downloaded or stored yet (staff see them in OA Manager; the customer taps "โอนแล้ว").
