# Plan: Slip2Go slip verification (replaces the local slip reading)

Status: **owner answered 2026-10-12: auto-confirm (reversible by void), privacy accepted, PromptPay ID set later in Settings, ssh allowed. D-27 is accepted in docs/decisions.md and CLAUDE.md rule 2 is amended (read both). Slice 0 is done (section 11). Slice 9 is now part of the build.**
Written for the implementing model. Read it top to bottom before touching code.

## 1. Goal and scope

When a customer attaches a transfer slip (customer app or LINE chat), the API asks **Slip2Go**
(a paid Thai service that checks the slip against the bank's records). Slip2Go then answers whether:
- the transfer exists;
- it went to the shop;
- it was for this payment's amount;
- it was made after the order.

Staff see the answer on the payment panel. When Slip2Go says "valid", staff confirm with one tap.
For every other answer, staff must also tick the existing "I checked the shop bank app" box.

**Out of scope:**
- auto-confirming payments (only if the owner chooses it; see Slice 9);
- any change for the customer: no new text in the customer app, no LINE push;
- the Slip2Go Queue API and webhooks;
- Slip2Go's PromptPay QR generation (our own `packages/promptpay` stays).

**"Put the old logic on hold"** means:
- Tesseract OCR is switched off by env (`SLIP_OCR=off`), and its code, tests and columns stay;
- the local duplicate check (image hash, QR hash, OCR ref hash) **stays on**, because it is free and it covers what Slip2Go is not asked to do (section 4.3);
- the local QR decoder **stays on**, because it supplies the QR text for the cheapest and most private call (section 4.1).

## 2. Hard rules that apply (CLAUDE.md)

- **Rule 2:** staff confirm every payment by hand. A Slip2Go "valid" is still a hint. The server never moves a payment to `confirmed` (unless Slice 9 is approved and rule 2 is amended first).
- **Rule 1:** money is integer satang. Convert to and from Slip2Go's baht values through strings, never through float arithmetic.
- **Rule 3:** the PromptPay ID comes from settings (`currentPromptpayId`). Never hardcode it, not even in tests; tests use the seed's test ID.
- **Rule 10:** never put in git, logs, Sentry or test fixtures:
  - the secret key;
  - slip pictures;
  - QR text;
  - names or account numbers from Slip2Go responses.

  Fixtures are synthetic.
- **Rule 6:** a verdict write is one transaction that bumps `rev` and `version` (the same as `checker.ts` today). The payment status is never touched.
- The verdict is never sent to the customer and is never in sync, realtime frames or the payment DTO. It goes out only through `GET /v1/orders/:id/payments`, the same as `slipChecks` today.

## 3. Slip2Go API facts (from slip2go.com/guide, read 2026-10-12)

| Item | Value |
|---|---|
| Auth | Header `Authorization: <Secret Key>`. **Unknown:** whether a `Bearer ` prefix is needed (Slice 0). |
| Base URL | **Unknown:** `https://connect.slip2go.com` or `https://api.slip2go.com`. Both answer `ok` at `/` (Slice 0). |
| IP whitelist | Up to 10 IPs. The default `*` allows any IP. Set it in app.slip2go.com > shop > Authentication. |
| Verify by QR text | `POST /api/verify-slip/qr-code/info`, JSON `{ "payload": { "qrCode": "...", "checkCondition": {...} } }` |
| Verify by image | `POST /api/verify-slip/qr-image/info`, multipart: `file` (png/jpg) and `payload` (JSON). The docs show the condition keys at the `payload` root here, with no `checkCondition` wrapper (Slice 0). |
| Verify by base64 / URL | `/api/verify-slip/qr-base64/info`, `/api/verify-slip/qr-image-link/info`: **not used** |
| Account info | `GET /api/account/info`: code `200001`, **not charged**. Fields: `package`, `packageExpiredDate`, `tokenRemaining`, `creditRemaining`, `tokenPerSlip`, `estimatedQuotaSlip`, … |
| Slip history | `GET /api/verify-slip/{referenceId}`: `200001`, not charged |
| `checkCondition.checkAmount` | `{ type: "eq"\|"gte"\|"lte", amount: "<String>" }`. **Unknown:** whether the unit is baht and how decimals are written (Slice 0). |
| `checkCondition.checkReceiver` | Array. A match on any one entry passes. Each entry is `{ accountType, accountNumber?, accountNameTH?, accountNameEN? }`. Types: `01xxx` = bank (e.g. `01004` KBank, `01014` SCB), `02001` PromptPay phone, `02003` national/tax ID, `02004` e-wallet. |
| `checkCondition.checkDate` | `{ type, date: ISO-UTC }` |
| `checkCondition.checkDuplicate` | Boolean: **not used** (section 4.3) |
| Response | `{ code: String, message, data? }`. `data`: `referenceId`, `transRef`, `dateTime`, `amount` (Number), `sender.bank.id`, `receiver.account.{name, bank.account (masked), proxy}`, names … |

Result codes. **All of them come back as HTTP 200, so branch on `code`, never on the HTTP status.**

| Code | Meaning | Token charged | Our verdict |
|---|---|---|---|
| 200200 | Slip is valid (all conditions passed) | yes | `valid` |
| 200000 | Slip found (it does not say the conditions were checked) | yes | **`unchecked`** (fail closed). Change this only if Slice 0 proves that conditions are applied when this code is returned. |
| 200401 | Receiver does not match | yes | `receiver_mismatch` |
| 200402 | Amount does not match | yes | `amount_mismatch` |
| 200403 | Date does not match | yes | `date_mismatch` |
| 200404 | Slip not in the bank's system | yes | `not_found` |
| 200500 | Fraud slip | yes | `fraud` |
| 200501 | Duplicate (only when `checkDuplicate` is sent) | no | `unchecked` (should not happen) |
| 200502 | Bank error, try again | no | retry, then `unchecked` |
| 400xxx | Bad request / file / QR missing | no | `unchecked` (log the code) |
| 401001–401007 | Wrong key, shop not found, account suspended, **package expired (401004)**, **no tokens (401005/401006)**, IP not allowed (401007) | no | `unchecked` + owner alert |
| 429000 / 500500 / 500503 | Rate limit, server error, maintenance | no | retry, then `unchecked` |

**Trial:** 7 days, 50 tokens, about 100 slips through the API. **Paid:** BASIC-1 is ฿88 for 30 days and about 352 slips (0.25 token each).

**Privacy (slip2go.com/privacy):**
- the shop is the data controller and Slip2Go is the processor;
- data may be processed by cloud providers "in Thailand or abroad";
- there is no fixed retention period.

## 4. Design

### 4.1 Flow (inside the existing slip checker, D-26)

```
customer uploads slip ──▶ attachSlip(): store file, claim payment, slip_verify='pending' (same tx)
                                  │ after commit
                                  ▼
                       SlipChecker queue (one at a time, never blocks the upload)
                                  │
            local QR decode (worker; now also returns the raw QR text, in memory only)
                 │ raw QR found                         │ no QR (blurry, cut off)
                 ▼                                      ▼
   POST qr-code/info {qrCode, conditions}     JPEG/PNG? POST qr-image/info {file, conditions}
   (no picture leaves the VM)                 WebP or too big ─▶ verdict 'unchecked'
                 └──────────────┬───────────────────────┘
                                ▼
   map code ─▶ verdict;  data.amount re-checked locally (string ─▶ satang);
   sha256(sender.bank.id : transRef) ─▶ slip_qr_hash (if the local decode gave none)
                                ▼
   one tx: write slip_verify, slip_verify_code, slip_verify_ref, bump rev/version, emit payment.upserted
```

- The sweep job (`slip-check-sweep`, every minute) picks up `pending` rows after a restart or a full queue, the same as today. It also retries transient failures, at most 3 attempts in total, then gives up with `unchecked`.
- The QR-text call is preferred because it sends the least personal data (no picture) and the same token cost. The image upload is the fallback.

### 4.2 Conditions sent (built by a pure, tested function)

- **`checkAmount`:** `{ type: "eq", amount: <this payment's amountSatang as a baht string> }`.
  - Use the payment's own amount: a top-up charges only the difference.
  - The string format comes from Slice 0 (likely `"85.50"` or `"85"`).
  - The local re-check also compares `data.amount` with the payment amount. If Slip2Go says valid but the amounts differ, the verdict is `amount_mismatch`.
- **`checkReceiver`:** built from settings at check time.
  - The PromptPay ID, by shape: 10-digit phone → `02001`; 13-digit ID → `02003`; 15-digit e-wallet → `02004`.
  - Plus, when `bank_account` is set **with** a bank code: `{ accountType: "01"+bankCode, accountNumber }`.
  - Nothing set at all: skip the call and give `unchecked` (sending no receiver would let a transfer to anyone pass).
- **`checkDate`:** `{ type: "gte", date: (order.createdAt − 10 min) as ISO-UTC }`.
  - Use the **order's** creation time, not the payment's: after a rejected claim the server creates a fresh pending payment, and the transfer may predate it.
- **`checkDuplicate`:** not sent.

### 4.3 Duplicates stay local

Slip2Go's duplicate check is per Slip2Go shop and covers all time. It would flag:
- a customer re-sending the same slip to the same payment;
- a retry after a lost response;
- every slip tried during the trial.

So the existing local rule (D-26) keeps deciding duplicates. Slip2Go's `sender.bank.id` + `transRef` feeds `slip_qr_hash` with the existing normaliser (`packages/shared/src/slip-qr.ts`). A duplicate is then caught even when the local QR decode failed.

**Re-upload of the identical file to the same payment** (same `slip_image_hash`): keep the earlier verdict and make no new call, so no token is spent.

### 4.4 Data (migration `0031_slip_verify`, additive only)

All new columns are on `payments`:

| Column | Type | Meaning |
|---|---|---|
| `slip_verify` | text, CHECK in (`pending`, `valid`, `amount_mismatch`, `receiver_mismatch`, `date_mismatch`, `not_found`, `fraud`, `unchecked`), null | Null means no slip, or the verifier is off |
| `slip_verify_code` | text, null | Slip2Go's 6-digit code, e.g. `200402`, for support and debugging. Holds no personal data. |
| `slip_verify_ref` | text, null | Slip2Go `referenceId`, for a later look-up in their history |
| `slip_verify_attempts` | smallint, not null, default 0 | Transient retries |
| `slip_verified_at` | timestamptz, null | When the verdict landed |

- **Never stored:** names, account numbers, the QR text, `transRef` (only its hash, in `slip_qr_hash`), amount strings or the raw response.
- Add every new column to the `payments` exclusion list in `packages/db/src/sync.ts`.
- Clear them in the 90-day slip purge (`packages/db/src/retention.ts` ~400) and in customer erasure (`packages/db/src/customers.ts` ~198).
- A new slip on the payment resets them (where `claimPayment` resets `slip_check` today), except in the same-file case of 4.3.

### 4.5 Staff screen (`apps/pos-web`)

`slipChecks[]` in `GET /v1/orders/:id/payments` gains one optional field, `verify: { verdict, at? }` (Zod in `packages/shared/src/payments.ts`). The banners:

| Verdict | Banner (th via i18n; wording to be finished by ux-ui-designer) | Confirm |
|---|---|---|
| `valid` and no local duplicate | green: "ตรวจกับธนาคารแล้ว: ยอดและบัญชีผู้รับตรง (Slip2Go)" | **one tap** |
| `amount_mismatch` | amber: "ยอดในสลิปไม่ตรงกับยอดที่ต้องชำระ" | tick |
| `receiver_mismatch` | red: "สลิปนี้โอนเข้าบัญชีอื่น ไม่ใช่บัญชีร้าน" | tick |
| `date_mismatch` | amber: "สลิปนี้โอนก่อนสั่งออเดอร์" | tick |
| `not_found` | red: "ไม่พบรายการนี้ในระบบธนาคาร อาจเป็นสลิปปลอม" | tick |
| `fraud` | red, strong: "Slip2Go ระบุว่าเป็นสลิปปลอม" | tick |
| `pending` | grey with a spinner: "กำลังตรวจกับธนาคาร…" | tick (staff may still confirm from the bank app) |
| `unchecked` | grey: "ตรวจอัตโนมัติไม่ได้ ตรวจในแอปธนาคาร" | tick |

Notes:
- **`slip-gate.ts`:** when a `verify` verdict exists, the tick is needed unless `verdict === 'valid' && !duplicate`. Without one, keep today's OCR rule, so the screen still works if Slip2Go is switched off.
- A local duplicate banner always shows and always needs the tick.
- The fake-slip warning text is reworded but stays.
- `attestedBankCheck` audit behaviour is unchanged.

### 4.6 Config (`apps/api/src/config.ts`, `.env.example`)

| Var | Default | Notes |
|---|---|---|
| `SLIP_VERIFIER` | `off` | `slip2go` or `off` |
| `SLIP2GO_BASE_URL` | the URL Slice 0 finds | Validated as an https URL |
| `SLIP2GO_SECRET_KEY` | none | Required when `SLIP_VERIFIER=slip2go`. Never logged, never in an error message, never sent to a client. |
| `SLIP2GO_TIMEOUT_MS` | 15000 | AbortController |
| `SLIP2GO_DAILY_CAP` | 100 | Calls per business date. Above it the verdict is `unchecked`, plus one owner alert. It stops a customer re-uploading to burn tokens. |

- The checker must now start when **either** `SLIP_OCR` or `SLIP_VERIFIER` is on. `server.ts` creates it only when OCR is on today.
- `SLIP_QR` must default to on when the verifier is on.
- In production `.env`, set `SLIP_OCR=off`, `SLIP_QR=on`, `SLIP_VERIFIER=slip2go`.

### 4.7 Quota and expiry

- **Daily job `slip2go-account-check`** (08:00 Bangkok): calls `GET /api/account/info`, which is not charged.
  - It sends a `warn` owner alert when `estimatedQuotaSlip < 30` or `packageExpiredDate` is within 3 days.
  - The alert carries numbers and dates only.
- **A 401004/401005/401006/401007 during a check:** one `warn` alert per business date and verdict `unchecked`. The shop keeps working on the tick.
- **Buying a package costs money:** only the owner does it.

## 5. Proposed decision entry (add to `docs/decisions.md` in Slice 1, owner to accept)

> **D-27 · Slip verification by Slip2Go (bank check) — Proposed (owner, 2026-10-12)**
> - **Decision:** every PromptPay slip is checked by Slip2Go against the bank's records. The local QR text is sent first; the picture is sent only when no QR can be read locally. The answer is a hint for staff (rule 2 unchanged): `valid` allows the one-tap confirm, and anything else needs the bank-app tick. Tesseract OCR (D-26) is switched off (`SLIP_OCR=off`) and its code is kept. The local duplicate check stays and now also uses Slip2Go's transaction reference.
> - **Supersedes in D-26:** "Why not a cloud service" and "a paid slip-verification service is not chosen". The owner accepted sending slip data to a processor (Slip2Go Co., Ltd.) for fraud prevention, with an updated privacy notice.
> - **Kept:** the verdict, Slip2Go's code and its reference id only. No names, accounts, QR text or raw response. The same purge, erasure and sync exclusion as the other slip columns.
> - **Cost:** the trial (50 tokens) runs until <date>; after that <plan> or `SLIP_VERIFIER=off`. A daily account check alerts the owner before tokens or the package run out.
> - **Revisit if:** false `not_found` on genuine slips, the cost grows past <x>/month, or the owner wants auto-confirm (needs a rule 2 amendment).

## 6. Slices

Work test-first in every slice: money, payments and receiver mapping are rule-1 territory. Each slice ends with:
- `npx biome check apps packages design`;
- `pnpm build`;
- the package's tests;
- one Conventional Commit.

Run one heavy command at a time, because the laptop is short of memory. Agents work in separate worktrees (`isolation: "worktree"`), and only the main session edits `PROGRESS.md`.

### Slice 0: probe the live API (main session plus the owner, about 4–5 tokens of the 50)

**Goal:** settle the unknowns in section 3 before any code depends on them.

**Steps:**
1. The owner puts the key in a gitignored file, e.g. `apps/api/.env.slip2go` (it matches `.env.*`), as `SLIP2GO_SECRET_KEY=...`. The owner never pastes it into the chat.
2. A scratchpad script (never in the repo) reads that file, never prints the key, and calls `GET /api/account/info` on both candidate hosts, with and without `Bearer `. It records which host and header give `200001` (not charged).
3. The script decodes each slip's QR **directly with the repo's `jsqr`** (`apps/api/src/slips/qr-decode.ts` drops the raw text, so it cannot be used as is). Never print the decoded text.

   It then sends 2–3 **real, recent** slips that paid the shop's PromptPay (chosen by the owner) to `qr-code/info`. That is about 7–10 calls in all, and `200401`/`200402` are charged too. Use one with a satang amount if possible, with:
   - `checkAmount` correct;
   - then `checkAmount` deliberately wrong on the same slip;
   - then a wrong receiver.

   Print only `code`, `message`, `typeof data.amount`, `data.amount`, `data.sender.bank.id` and the **shape** of `transRef` (length, character classes). Never print names or accounts.
4. Send one slip through `qr-image/info` to learn which form of `payload` (root or `checkCondition`) it accepts.
5. From the VM, read-only: `curl -s https://ifconfig.me` gives the egress IP for the whitelist.

**Output:** a short "Probe results" section appended to this file, covering:
- base URL and header format;
- amount unit and format;
- the image `payload` shape;
- which code wins when two conditions fail;
- whether `200000` or `200200` means valid with conditions;
- `sender.bank.id` format compared with the local QR's bank code;
- the egress IP.

The output must also record:
- whether sending the **same slip a second time** returns `200501` even without `checkDuplicate`. If it does, section 4.3 breaks: retries and re-uploads would come back as duplicates. Stop and re-plan.
- which code `qr-code/info` and `qr-image/info` return for a correct slip **with** conditions: `200200` or `200000`.

**Acceptance:**
- Every "Unknown" in section 3 is answered or marked "could not determine".
- For **each endpoint and payload shape the code will use**, a deliberately wrong receiver returns `200401`. If an endpoint or shape does not, its success can never mean `valid`: map it to `unchecked`, or do not use that endpoint.

### Slice 1: pure logic (payments-finance-engineer, `packages/shared`)

**Files:** a new `packages/shared/src/slip-verify.ts` and its `.test.ts`, exported from `index.ts`.

**Contents:**
- `SLIP_VERIFY_VERDICTS` (the enum in 4.4).
- Check `packages/shared/src/money.ts` for an existing satang-to-baht formatter first, and reuse it if it fits.
- `satangToSlip2goAmount(satang): string`: bigint division and modulo only (`85_50n → "85.50"`). No floats at all.
- `slip2goAmountToSatang(n: number|string): bigint | null`: match `String(n)` against `^\d+(\.\d{1,2})?$`, then split on `.` and pad the fraction. Never use `* 100` or `toFixed`. Null on anything that does not match: NaN, negative, more than 2 decimals, exponent notation.
- The exact string format sent (`"85.50"`, `"85.5"` or `"85"`) comes from Slice 0 and lives in this one function.
- `slip2goReceivers(promptpayId: string | null, account: { bankCode: string; accountNumber: string } | null)` returns an array, empty when nothing is configured.
- `slip2goVerdict(code: string, localAmountOk: boolean | null)` returns `{ verdict, retry: boolean, alert: boolean }` per the table in section 3. Unknown codes give `unchecked`.
- A Zod schema for the response that **picks only** `code`, `message`, `data.referenceId`, `data.transRef`, `data.amount`, `data.dateTime` and `data.sender.bank.id`. Everything else is dropped.

**Tests:**
- every code in the table;
- amounts 1, 50, 85.50, 1234.05 and 0.01 THB both ways;
- `"85.5"` and `85.5` from the API;
- a float trap: `0.1+0.2` (`0.30000000000000004`) must give `null`;
- `200200` gives `valid`, and `200000` gives `unchecked`;
- each PromptPay ID shape;
- a missing bank code;
- unknown codes.

**Also in this slice:** add the D-27 draft to `docs/decisions.md` as **Proposed**.

### Slice 2: database (backend-engineer, `packages/db`)

- Add the columns from 4.4 to `schema.ts` (with a CHECK through `oneOf`), then `pnpm --filter @sds/db db:generate`. The migration is `0031`; never edit 0000–0030.
- Extend `PaymentUpdate` in `payments.ts` with the new fields.
- `listPendingSlipChecks` must also return rows with `slip_verify = 'pending'`. Rename it, or add a sibling.
- Add the columns to the sync exclusion list, the retention purge and customer erasure.

**Tests:** migration up on PGlite; the CHECK rejects a bad value; sync never returns the columns; the purge and erasure null them.

Slices 1 and 2 can run in parallel.

### Slice 3: the API client and the checker (backend-engineer, `apps/api`)

1. **`apps/api/src/slips/slip2go.ts`:** define

   ```ts
   interface SlipVerifier {
     verifyQr(qr: string, cond): Promise<VerifyResult>;
     verifyImage(bytes, mime, cond): Promise<VerifyResult>;
     accountInfo(): Promise<AccountInfo>;
   }
   ```

   - Implement it as `createSlip2goVerifier(config, fetchImpl = fetch)` using built-in `fetch` and `FormData`/`Blob`.
   - It needs an AbortController timeout and Zod-parsed responses.
   - Network, timeout, 429 and 5xx errors become a `transient` result, never a throw that escapes.
   - Logs carry `{code, ms}` only. Never log the body, the key or the URL query.
2. **QR worker** (`qr-worker.ts`, `qr-decode.ts`, `qr.ts`): return `{ qr: SlipQr | null, raw: string } | null`. The raw text is in memory only. Update the doc comments, which today say the raw text is never returned. Existing callers keep using `.qr`.
3. **`checker.ts`:**
   - Accept an optional `verifier`.
   - In `evaluate`:
     - decode the QR, then call `verifyQr` if raw text exists, else `verifyImage` for JPEG/PNG, else `unchecked`;
     - build the conditions with the Slice 1 helpers and settings read at check time;
     - re-check the amount locally;
     - fill `slip_qr_hash` from `sender.bank.id:transRef` when the local decode had none;
     - make OCR optional (skip it when `ocr` is absent).
   - In `read`: a transient result increments `slip_verify_attempts` and leaves `pending` until 3 attempts, then `unchecked`.
   - Enforce the daily cap (a count of rows with `slip_verified_at` on today's business date, or an in-memory counter reset by business date; choose the DB count).
4. **`slips/service.ts` and `claimPayment`:** split today's single `read` flag into two:
   - `ocr`: sets `slip_check='pending'`, only when OCR is on;
   - `verify`: sets `slip_verify='pending'`, only when the verifier is on.

   `read()` and the sweep must gate on **each flag separately**. Otherwise, with OCR off, `slip_check` never leaves `pending` and the sweep would pick the row (and call Slip2Go) every minute.

   Keep the earlier verdict when the image hash equals the payment's current one (4.3).
5. **`config.ts`, `.env.example`, `server.ts`:** the vars in 4.6. Create the checker when OCR **or** the verifier is on.
6. **`payments/service.ts` `listOrderPayments`:** add `verify` to `slipChecks` entries. Create an entry when only the verifier ran (no OCR result).

**Tests, all with a fake `fetchImpl` and synthetic bodies:**
- **with `SLIP_OCR` off and the verifier on, once the verdict lands the sweep selects nothing, and the fake fetch sees exactly one call over several sweep runs;**
- each code becomes the stored verdict;
- QR path vs image path vs WebP;
- the amount re-check overrides a "valid";
- a transient failure retries 3 times, then `unchecked`;
- 401004 raises an alert, at most once per day;
- the daily cap;
- the same file re-uploaded makes no second call;
- a new slip resets the verdict;
- a stale answer is ignored (key changed mid-call);
- the key never appears in any log line (spy on the logger);
- the customer endpoints never include `verify`;
- the payment status is never changed by the checker.

### Slice 4: quota job and alerts (backend-engineer)

- Add the `slip2go-account-check` daily job to `apps/api/src/jobs/jobs.ts`, plus the alert events `slip2go.quota_low`, `slip2go.package_expiring` and `slip2go.unavailable`, through the existing alert path (`apps/api/src/alerts.ts`). Alerts carry numbers and dates only.
- **Tests:** the thresholds; no alert when everything is fine; the job is a no-op when `SLIP_VERIFIER=off`.

### Slice 5: staff screen (pos-frontend-engineer; ux-ui-designer for wording)

- `slip-gate.ts`: the rule in 4.5. Update `slip-gate.test.ts` first.
- The banner component (where the D-26 banners live: `SlipView.tsx` / `PromptPayPanel.tsx`): one banner per verdict, with the strongest warning on top. The duplicate banner stays above everything.
- th and en strings in `packages/i18n`. No hardcoded text.
- Tests: `SlipCheck.test.tsx`-style cases for each verdict, the one-tap vs tick rule, the fallback to the OCR rule when `verify` is absent, and `pending` showing the spinner text.

Slice 5 can run in parallel with Slice 4.

### Slice 6: privacy and docs (main session; owner approves the text)

- **Privacy notice (th/en):**
  - slips are checked by Slip2Go Co., Ltd., which may process them in Thailand or abroad, to confirm the transfer and prevent fake slips;
  - what is sent: the slip's QR text, or the picture when the QR cannot be read.

  Bump `PRIVACY_NOTICE_VERSION`. Update the short LINE and app summaries.
- `docs/04-integrations.md`: a new Slip2Go section (endpoints, codes, quota, IP whitelist).
- `docs/06-legal-compliance.md`: the processor and cross-border note.
- `docs/07-limitations-risks.md`: vendor outage or expiry means falling back to the tick.
- `docs/10-open-questions.md`: record the owner's answers from section 10.

### Slice 7: review (qa-security-reviewer)

Run it on `git diff <deployed sha>..HEAD`. It focuses on:
- the key never logged or sent to a client, and Sentry not capturing the `Authorization` header;
- no personal data from responses stored or logged;
- verdicts absent from sync, realtime and customer routes;
- the satang conversions;
- rule 2 (no status change anywhere in the checker);
- the daily cap;
- PDPA wording.

### Slice 8: deploy (devops-engineer plus the owner)

1. The owner sets the Slip2Go IP whitelist to the VM egress IP from Slice 0. Remove `*`.
2. The owner adds to `/opt/sds/.env` **before** the push: `SLIP_VERIFIER=slip2go`, `SLIP2GO_SECRET_KEY=…` (they type it themselves; it is never echoed), `SLIP2GO_BASE_URL=…`, `SLIP_OCR=off`, `SLIP_QR=on`.
3. Push only after the Slice 7 OK. Migration 0031 runs on deploy. Poll `/healthz` for the new sha.
4. Smoke test on the test OA: one real small transfer (for example ฿1) with a slip gives `valid` and one-tap confirm. Send the same slip to a second order: it gives the local duplicate banner plus the tick, and no token is spent if the QR hash matched before the call. *(Optional improvement: skip the Slip2Go call when the local QR hash already matches a claimed or confirmed payment.)*
5. Check the api container memory after a few checks (OCR off should lower it).
6. Run `/checkpoint`, and update the slip memory note.

### Slice 9: auto-confirm (APPROVED by the owner 2026-10-12; conditions are in D-27, follow them exactly)

This needs a rule 2 amendment in CLAUDE.md, an accepted D-27 variant, and a payments-finance-engineer design:
- a `system:slip2go` actor;
- `claimed → confirmed` only when the verdict is `valid`, there is no local duplicate and the local amount equals the payment amount;
- an audit row;
- a staff alert;
- the void path unchanged.

Build it after slices 1–4, behind `SLIP_AUTOCONFIRM` (default off), amount ceiling `SLIP_AUTOCONFIRM_MAX_SATANG` (default 100000), tests first (payments-finance-engineer reviews).

## 7. Order and parallelism

```
Slice 0 (probe) ─▶ Slice 1 ∥ Slice 2 ─▶ Slice 3 ─▶ Slice 4 ∥ Slice 5 ─▶ Slice 6 ─▶ Slice 7 ─▶ Slice 8
```

Slice 0 must happen while the trial still has tokens. Slices 1 and 2 can start before Slice 0 finishes only if the amount format stays behind a single function that Slice 0 can fix.

## 8. Risks

- **The trial ends in about a week.** After that, every check is `unchecked` until a package is bought. The shop falls back to today's tick flow, so nothing breaks.
- **Token cost:** every re-upload and every retry after a lost response may cost a token. The daily cap and the same-file rule limit this.
- **Vendor outage or slowness:** this is handled as `unchecked`. The upload is never delayed.
- **A `valid` result is still not money in the account** (for example, a reversed transfer). Rule 2 stays: staff are the final word, which is why one tap remains a human action.
- **WebP slips** are not checked (the local decoder skips WebP, and Slip2Go documents only png/jpg).
- **PDPA:** go-live needs the updated notice first.

## 9. Definition of done

- With `SLIP_VERIFIER=slip2go`, a genuine slip to the shop with the right amount shows the green banner and confirms with one tap. Every other code shows its banner and needs the tick.
- With `SLIP_VERIFIER=off`, the app behaves exactly as today with OCR off.
- No secret, name, account, QR text or response body appears in git, logs, Sentry, sync, realtime or customer responses (verified by tests and the Slice 7 review).
- Biome is clean, `pnpm build` passes, and every package's tests pass. The counts are recorded in `PROGRESS.md`.

## 10. Information needed from the owner

**Blocking before Slice 3:**
1. **One tap or auto-confirm?** When Slip2Go says valid, should staff still tap confirm (recommended; keeps rule 2), or should the system confirm automatically (Slice 9; amends rule 2)?
2. **Privacy:** do you accept that slip data (the QR text, or the picture when the QR cannot be read) goes to Slip2Go, which may process it abroad, and that the privacy notice is updated (customers re-acknowledge)?
3. **The PromptPay ID in settings:** is it the shop's **real** ID now? The handoff says the test ID is in use. Slip2Go checks the receiver against it, so a test ID makes every real slip `receiver_mismatch`.
4. **The receiving bank account:** is it entered in Settings > bank account, **with the bank chosen**? Many slips show the bank account, not the PromptPay number.

**Needed for Slice 0 (this week, while the trial lasts):**

5. The trial's start date (it ends 7 days later).
6. Put the Secret Key in a gitignored file yourself (e.g. `apps/api/.env.slip2go`), and say when it is there. Never paste it in the chat.
7. 2–3 recent real slips of transfers **to the shop**, as files on the laptop, with at least one with satang if possible. About 4–5 of the 50 trial tokens are used.

**Not blocking (defaults in brackets):**

8. Keep Tesseract OCR as a fallback when Slip2Go is down? [No: switch it off; it costs memory on the 1 GB VM.]
9. After the trial: buy BASIC-1 (฿88 for 30 days, about 352 slips) or switch the check off? How many LINE/app slips a month do you expect?
10. Daily call cap. [100 per day]
11. Lock the Slip2Go IP whitelist to the VM. [Yes]
12. WebP slips. [Leave them unchecked; staff use the tick.]

## 11. Probe results (Slice 0, run 2026-10-12; 10 of the 50 trial tokens used, 40 left)

Run by the main session with a scratchpad script (not in the repo). It read the key from `apps/api/.env.slip2go` and printed only codes and shapes. Two real slips were used: one actual transfer for order L_003 and one transfer not for an order.

| Question | Answer |
|---|---|
| Base URL | `https://connect.slip2go.com` (`api.slip2go.com` answers 404 for `/api/...`) |
| Auth header | `Authorization: Bearer <key>`. Without `Bearer ` the answer is `401001`. |
| Trial | package `ทดลอง`, 50 tokens, **expires 2026-10-19T23:59:59.999Z**, 0.5 token per slip |
| Amount in the response | `data.amount` is a **Number in baht** (`15` for ฿15). Date: `data.dateTime` is ISO with `+07:00`. |
| `checkAmount.amount` | A string in baht. **Both `"15"` and `"15.00"` are accepted.** Send the 2-decimal form. |
| Valid with conditions | `qr-code/info` **and** `qr-image/info` return **`200200`** when all conditions pass. No conditions gives `200000` ("Slip found"). So `200200` is the only `valid`, and `200000` stays `unchecked`. |
| Wrong conditions | Amount `200402`, date `200403`, receiver `200401`. **When amount and receiver are both wrong, `200401` (receiver) wins.** |
| Image endpoint | `POST /api/verify-slip/qr-image/info`, multipart `file` + `payload`. **Conditions go at the root of `payload`** (`{ "checkReceiver": [...] }`). The wrapped shape (`checkCondition`) answers `400400`. A successful image call returns **HTTP 201** (QR-text calls return 200), so branch on `code`, not on `status === 200`. |
| Repeat sends | The same slip sent about 10 times without `checkDuplicate` never returned `200501`. Retries and re-uploads are safe (section 4.3 holds). |
| Receiver by **name** | `{ accountType: "02001", accountNameTH: <name without title> }` returned `200200`. A wrong name returned `200401`. Works. |
| Receiver by **account number** | **Not working yet.** With the masked phone from the response (`xxx-xxx-1234`), `xxxxxx1234` and `1234`, the answer was `200401` every time. The full number was not tried: it is only in the owner's Settings, which the probe cannot read. |
| Response shape for a proxy payment | `receiver.account.proxy = { type: "MSISDN", account: "xxx-xxx-1234" }` (masked), `receiver.account.bank.account = null`, `receiver.bank.id = "004"`, `sender.bank.id = "002"`, `transRef` is 25 digits |

### What this changes in the plan

1. **Receiver condition (section 4.2).** The design assumed `accountNumber` from the PromptPay ID in settings would match. That is unproven.
   - **Test next:** the full phone number as `accountNumber` (needs the owner's phone number, or a probe run from a place that can read Settings). It costs 0.5 token.
   - **Fallback (works today):** a new owner setting "receiver name as printed on slips" (`accountNameTH`), with the same protections as `bank_account` (owner only, step-up, audit, alert, masked, never in sync).
   - Until one of these is chosen, slice 1's `slip2goReceivers` must accept either form.
2. **Image call shape:** root-level conditions, and accept HTTP 201 as success.
3. **The 7-day trial ends 2026-10-19.** After that, expect `401004`/`401005`/`401006` and fall back to the tick.

### Still open
- Egress IP of the VM for the whitelist (needs a read-only `ssh pos-ts` and `curl https://ifconfig.me`; not run).
- Whether the full phone number works as `accountNumber`.

### Probe update (2026-10-12, 1 more token pair)
- **Receiver by account number works with the FULL number:** `{ accountType: "02001", accountNumber: "<10-digit phone, no dashes>" }` returned `200200` on the real slip, and the same number with the last digit changed returned `200401` (the condition is applied, not ignored). The masked form from the response does not work. So the plan's section 4.2 stands as written: build `checkReceiver` from the PromptPay ID in settings. **The "receiver name" setting is not needed.** `02003` (13-digit ID) and `02004` (e-wallet) were not tested: test them before the real ID type is used if it is not a phone.
- The number used in this probe belongs to the owner's personal account, not the shop's. It is not written in this repo. 3 of 50 trial tokens fewer: about 39 left.
