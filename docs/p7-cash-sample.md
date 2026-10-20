# P7 receipts and payments hand-check sample (synthetic, for the owner)

Made-up orders and expenses, in baht, over the same two weeks as `docs/p7-pnl-sample.md` and with its expense ledger. The orders are the same except that the two platform orders of 20.00 (LINE MAN) and 90.00 (Grab) are left out and one partly paid order is added, so the receipts here are 685.00, not that sample's 795.00. Work out each figure yourself from the rows, then compare with the "Expected" tables. Nothing here is real shop data. The same rows are pinned by the test `packages/finance/src/cash-sample.test.ts`, so if the rules change, change both.

**What the report is** (`docs/decisions.md` D-35, amended 2026-10-21): the working record behind the Revenue Department's **รายงานเงินสดรับ-จ่าย** (income-tax announcement No. 161, 21 Dec 2549, https://rd.go.th/33300.html; blank form and example: https://rd.go.th/fileadmin/images/image_law/images/prob.pdf, read 2026-10-21). The form has: date, item, **receipts**, **payments** split into **buying goods (ซื้อสินค้า)** and **other expenses (ค่าใช้จ่ายอื่นๆ)**, and a remark; its summary is receipts, payments, and the difference. It is a record you keep and show an accountant, **not a document you file**. The shop has **no cash drawer** (every sale is a transfer into your own account), so our extra column is a **running net from a start amount**, not a drawer balance, and **not a bank statement**.

**The rules being checked:**
- **Receipts** are the same as the revenue report: paid orders that were not cancelled, on the order's own day, each confirmed payment minus what was handed back on it. **Every method counts** (PromptPay, government co-pay, platform, other, and cash if it ever appears); each has its own column, and all the columns add up to the day's revenue.
- Government co-pay and platform receipts are shown on the **sale day**, though the money arrives later (settlement and payouts are not tracked).
- An order that is **not fully paid** yet counts nothing (order 11 below), as in the revenue report.
- **Payments** = the expense ledger by its own date, **voided rows left out**. **Buying goods** = the categories you flagged "counts as buying goods" on the Expenses screen. By default that is **ingredients and packaging**; gas, utilities, rent, staff, platform fees, equipment and other are **other expenses**. A category you add yourself is ticked by default; untick it for things that are not goods (for example a payment-verification fee).
- **Every expense is assumed paid from the same account**: the ledger has no "paid with" field yet.
- **Start amount** = the figure at the **start** of the as-of day. The **running net** of a day = start amount + receipts - payments from the as-of day to the end of that day. Days before the as-of day show no running net. Without a start amount there is none at all (never 0).
- Days with no receipts and no payments are left out (a switch lists them); the running net carries over them.

Start amount for this sample: **500.00 at the start of 24 Sep.**

## Orders

| # | Date | Channel | Paid with | What happened | Receipt counted |
|---|---|---|---|---|---:|
| 1 | 24 Sep | Storefront | Cash | | 130.00 |
| 2 | 25 Sep | LINE | PromptPay | | 130.00 |
| 3 | 26 Sep | Storefront | Cash | | 60.00 |
| 4 | 27 Sep | Grab | Platform | | 80.00 |
| 5 | 28 Sep | Storefront | Cash | 60.00 paid, 10.00 handed back | 50.00 |
| 6 | 30 Sep | Storefront | Government co-pay | full amount | 60.00 |
| 7 | 30 Sep | LINE | - | Cancelled | 0 |
| 8 | 1 Oct | Storefront | Cash | | 25.00 |
| 9 | 3 Oct | LINE | PromptPay | | 120.00 |
| 10 | 7 Oct | Storefront | Cash | | 30.00 |
| 11 | 7 Oct | Storefront | Cash 20.00 taken | **partly paid**, not counted yet | 0 |

(The sample keeps some cash rows so the per-method columns are exercised; the real shop is all transfers, where those columns read 0.00.)

## Expense ledger (same as the P&L sample)

| # | Date | Category | Amount | Goes in | Note |
|---|---|---|---:|---|---|
| 1 | 24 Sep | ingredients | 150.00 | buying goods | |
| 2 | 26 Sep | gas | 80.00 | other | |
| 3 | 28 Sep | platform_fees | 15.00 | other | |
| 4 | 29 Sep | ingredients | 999.00 | - | typed wrongly, **voided** (left out) |
| 5 | 2 Oct | ingredients | 100.00 | buying goods | |
| 6 | 4 Oct | packaging | 20.00 | buying goods | packaging is goods by default |
| 7 | 6 Oct | other | 10.00 | other | |

## Expected, day by day (24 Sep to 7 Oct)

| Day | Cash column | All receipts | Payments | Net of the day | Running net (end of day) |
|---|---:|---:|---:|---:|---:|
| 24 Sep | 130.00 | 130.00 | 150.00 | -20.00 | 480.00 |
| 25 Sep | 0.00 | 130.00 | 0.00 | 130.00 | 610.00 |
| 26 Sep | 60.00 | 60.00 | 80.00 | -20.00 | 590.00 |
| 27 Sep | 0.00 | 80.00 | 0.00 | 80.00 | 670.00 |
| 28 Sep | 50.00 | 50.00 | 15.00 | 35.00 | 705.00 |
| 30 Sep | 0.00 | 60.00 | 0.00 | 60.00 | 765.00 |
| 1 Oct | 25.00 | 25.00 | 0.00 | 25.00 | 790.00 |
| 2 Oct | 0.00 | 0.00 | 100.00 | -100.00 | 690.00 |
| 3 Oct | 0.00 | 120.00 | 0.00 | 120.00 | 810.00 |
| 4 Oct | 0.00 | 0.00 | 20.00 | -20.00 | 790.00 |
| 6 Oct | 0.00 | 0.00 | 10.00 | -10.00 | 780.00 |
| 7 Oct | 30.00 | 30.00 | 0.00 | 30.00 | 810.00 |

There is no row for 29 Sep (only the voided expense) or for 5 Oct (nothing happened). 24 Sep: 500.00 + 130.00 - 150.00 = 480.00.

## Expected totals (the Revenue Department summary)

| Line | Baht | How |
|---|---:|---|
| Receipts, cash | 295.00 | 130 + 60 + 50 + 25 + 30 |
| Receipts, PromptPay | 250.00 | 130 + 120 |
| Receipts, government co-pay | 60.00 | order 6 |
| Receipts, platform | 80.00 | order 4 |
| **Total receipts** | **685.00** | **equals the revenue report of these orders** (the P&L sample's 795.00 less its 20.00 and 90.00 platform orders) |
| Buying goods | 270.00 | 150.00 + 100.00 + 20.00 packaging |
| Other expenses | 105.00 | 80 + 15 + 10 |
| **Total payments** | **375.00** | the ledger without the voided 999.00 |
| Receipts less payments | 310.00 | 685.00 - 375.00 |
| Running net at the end | 810.00 | 500.00 + 310.00 |

## Expected by month

| | All receipts | Cash column | Buying goods | Total payments |
|---|---:|---:|---:|---:|
| September (24-30) | 510.00 | 240.00 | 150.00 | 245.00 |
| October (1-7) | 175.00 | 55.00 | 120.00 | 130.00 |
| Whole range | 685.00 | 295.00 | 270.00 | 375.00 |

## Asking only for 1 to 7 October

The start amount is dated 24 Sep, before the range, so the report first works out what moved the running net from 24 to 30 Sep: receipts 510.00 less payments 245.00 = **265.00**. The running net at the start of 1 Oct is therefore **765.00**, and the days then read 790.00, 690.00, 810.00, 790.00, 780.00, 810.00, the same as above.

## If a figure does not match

Write down the row number and what you expected. A question about the rules (for example "should rent count as buying goods?") can be answered by ticking or unticking the category on the Expenses screen; anything else goes into `docs/10-open-questions.md` before any code changes.
