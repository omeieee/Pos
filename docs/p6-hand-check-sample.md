# P6 hand-check sample (synthetic, for the owner)

Made-up orders, in baht. Work out each total yourself from the rows, then compare with the "Expected" lines. Nothing here is real shop data. The same rows are pinned by the test `packages/finance/src/hand-check.test.ts`, so if the rules change, change both.

**The rules being checked** (`docs/03-data-model.md` §6): only orders that are **paid** and **not cancelled** count. An order's revenue is the **confirmed payments minus partial refunds**. Everything lands on the order's own business day. A platform's commission is shown beside the revenue and is not taken off it. A ไทยช่วยไทย payment counts at the **full** amount (the government part plus the customer part).

## Day 1 · Monday 14 Sep 2026

| # | Channel | Order total | What happened | Counts? | Revenue |
|---|---|---:|---|---|---:|
| 1 | Storefront | 80.00 | Paid cash 80.00 | yes | 80.00 |
| 2 | LINE | 120.50 | Paid PromptPay 120.50 | yes | 120.50 |
| 3 | Storefront | 100.00 | Paid cash 100.00, owner handed back 25.00 | yes | 75.00 |
| 4 | Grab | 100.00 | Platform paid 100.00, Grab commission 30.00 | yes | 100.00 |
| 5 | Storefront | 100.00 | ไทยช่วยไทย, confirmed, full 100.00 | yes | 100.00 |
| 6 | LINE | 99.00 | Cancelled | no | 0 |
| 7 | Storefront | 77.00 | Not paid | no | 0 |
| 8 | Storefront | 90.00 | Only 40.00 paid so far | no | 0 |

**Expected for day 1**

- Revenue **475.50** from **5** orders; average per order **95.10**.
- Platform commission shown beside it: **30.00**.
- By channel: storefront 255.00 · LINE 120.50 · Grab 100.00.
- By payment method: cash 155.00 · PromptPay 120.50 · platform 100.00 · ไทยช่วยไทย 100.00.

## Day 2 · Tuesday 15 Sep 2026

| # | Channel | Order total | What happened | Counts? | Revenue |
|---|---|---:|---|---|---:|
| 9 | Storefront | 60.00 | Paid cash 60.00 | yes | 60.00 |
| 10 | Storefront | 140.00 | Paid PromptPay 140.00 | yes | 140.00 |
| 11 | LINE | 55.55 | Paid PromptPay 55.55 | yes | 55.55 |

**Expected for day 2**

- Revenue **255.55** from **3** orders; average per order **85.18** (255.55 ÷ 3 = 85.1833, rounded to the satang).
- Commission **0**. By channel: storefront 200.00 · LINE 55.55. By method: cash 60.00 · PromptPay 195.55.

## The two days together (a "month so far")

- Revenue **731.05** from **8** orders; average per order **91.38** (731.05 ÷ 8 = 91.38125).
- Commission **30.00**.

## If a figure does not match

Write down the row number and what you expected. That is a question for the rules (for example "should the 25.00 refund come off day 1?"), and it goes into `docs/10-open-questions.md` before any code changes.
