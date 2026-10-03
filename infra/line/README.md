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
1. Webhook URL: `https://<api host>/v1/line/webhook` (today `https://138-2-67-89.sslip.io/v1/line/webhook`). The IP is ephemeral: if it changes, update the URL (docs/10 P2 note).
2. **Use webhook: on.** **Webhook redelivery: on** (the API dedupes by `webhookEventId`).
3. Press **Verify**: the API answers 200 only with a correct secret. A 503 means `LINE_CHANNEL_SECRET` is not set on the server; 403 means the secret is wrong.
4. In LINE Official Account Manager, Response settings: **Chat on**, **Auto-response off**, greeting message off (the bot greets on follow and shows the privacy notice).

## Quota
Free plan: 300 pushes a month (replies, chat and greetings are free). `GET /v1/line/quota` (owners and managers) shows this month's count; the `line_policy` setting holds `push` (`off`, `essential`, `all`), `warnAtPercent` and `monthlyLimit`. Staff-sent manual pushes from OA Manager are not seen by the local count.

## Not done by code
Rich menu creation and art upload (art from `design/`), the MINI App / LIFF endpoint URL, and the add-friend prompt are console steps for the ordering slice.
