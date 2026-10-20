# P7 profit-and-loss hand-check sample (synthetic, for the owner)

Made-up orders and expenses, in baht, over two weeks that cross a month end. Work out each figure yourself from the rows, then compare with the "Expected" lines. Nothing here is real shop data, and the two commission rates are **examples only** (the real rates are the ones you type in Settings from each merchant app). The same rows are pinned by the test `packages/finance/src/pnl-sample.test.ts`, so if the rules change, change both. The menu and cost rules are the ones in `docs/p7-margin-sample.md`.

**The rules being checked** (`docs/decisions.md` D-33, on top of D-32 and `docs/03-data-model.md` §6):
- **Revenue** = what was paid minus cash handed back, for paid orders that were not cancelled, on the order's own day.
- **Cost of goods** = cost typed in the POS x quantity, only for orders where **every** line has a cost. An order with a "no cost entered" line adds its revenue but **no cost**, and is listed.
- **Gross profit** = revenue - cost of goods.
- **Platform commission**: a figure recorded on the order wins; otherwise Grab / LINE MAN orders use the rate from Settings; with no rate there is no number and the order is listed.
- **Expenses** = the expense ledger by its date, **voided rows left out**.
- **Net profit before income tax** = gross profit - commission - expenses. A loss shows as a minus.
- The commission and the `platform_fees` expense category are **two separate lines, both taken off**. Do not type a platform's commission into `platform_fees` as well, or it is counted twice (the answer raises a flag when both are present).
- While the answer is marked **incomplete** (an order without a cost, or a platform order without a rate), the profit shown can only be **too high**, never too low.

Example rates: Grab 25.00%, LINE MAN 20.00%. Dish costs: T 22.00, Y 28.00, W 4.00, X (ชาเย็น) 9.00 from 1 Oct, **not entered** before.

## Orders

| # | Date | Channel | What was ordered | Paid | What happened | Revenue | Cost |
|---|---|---|---|---:|---|---:|---:|
| 1 | 24 Sep | Storefront | T x2, W x1 | 130.00 | Cash | 130.00 | 48.00 |
| 2 | 25 Sep | LINE | Y x1, T x1 | 130.00 | PromptPay | 130.00 | 50.00 |
| 3 | 26 Sep | Storefront | X x2, W x1 | 60.00 | Cash; X had **no cost entered** | 60.00 | **none** |
| 4 | 27 Sep | Grab | Y x1 | 80.00 | Platform paid; no commission recorded | 80.00 | 28.00 |
| 5 | 28 Sep | Storefront | T x1 | 60.00 | Cash, 10.00 handed back | 50.00 | 22.00 |
| 6 | 29 Sep | LINE MAN | W x2 | 20.00 | Platform paid; commission 3.00 recorded | 20.00 | 8.00 |
| 7 | 30 Sep | Storefront | T x1 | 60.00 | Government co-pay, full amount | 60.00 | 22.00 |
| 8 | 30 Sep | LINE | T x1 | - | Cancelled | 0 | - |
| 9 | 1 Oct | Storefront | X x1 | 25.00 | Cash; X now has cost 9.00 | 25.00 | 9.00 |
| 10 | 3 Oct | Grab | Y x1 | 90.00 | Platform paid; no commission recorded | 90.00 | 28.00 |
| 11 | 5 Oct | LINE | T x2 | 120.00 | PromptPay | 120.00 | 44.00 |
| 12 | 7 Oct | Storefront | W x3 | 30.00 | Cash | 30.00 | 12.00 |

## Expense ledger

| # | Date | Category | Amount | Note |
|---|---|---|---:|---|
| 1 | 24 Sep | ingredients | 150.00 | |
| 2 | 26 Sep | gas | 80.00 | |
| 3 | 28 Sep | platform_fees | 15.00 | a platform charge other than commission |
| 4 | 29 Sep | ingredients | 999.00 | typed wrongly, **voided** (left out) |
| 5 | 2 Oct | ingredients | 100.00 | |
| 6 | 4 Oct | packaging | 20.00 | |
| 7 | 6 Oct | other | 10.00 | |

## Expected for the whole fortnight (both rates set)

| Line | Baht | How |
|---|---:|---|
| Revenue | **795.00** | 11 paid orders: Sep 530.00 + Oct 265.00 |
| Cost of goods | **271.00** | Sep 178.00 + Oct 93.00 (order 3 has none) |
| Gross profit | **524.00** | 795.00 - 271.00 |
| Platform commission | **45.50** | order 6 recorded 3.00; order 4 = 25% of 80.00 = 20.00; order 10 = 25% of 90.00 = 22.50 |
| Expenses | **375.00** | ingredients 250.00, gas 80.00, packaging 20.00, platform_fees 15.00, other 10.00 (the voided 999.00 is out) |
| **Net profit before income tax** | **103.50** | 524.00 - 45.50 - 375.00 |

- **Incomplete**: order 3 (60.00 of revenue) has no cost, so its cost is missing and the 103.50 is **at most** the real profit. Order 3 and the item X are listed.
- The margin figure (as in the margin sample) uses only the 10 fully costed orders: revenue 735.00, cost 271.00, gross profit 464.00, margin 63.13%. It differs from the 524.00 above by exactly the 60.00 of order 3.
- Government co-pay revenue inside the 795.00: **60.00** (order 7). It counts on the sale date. Tracking when the government's share arrives (the receivable) is **not built yet**, and the answer says so.
- The `platform_fees` expense (15.00) and the commission (45.50) are both present, so the "check you did not enter the same fee twice" flag is on.

## Expected month by month

| | Revenue | Cost | Gross profit | Commission | Expenses | Net profit | Complete? |
|---|---:|---:|---:|---:|---:|---:|---|
| September (24-30) | 530.00 | 178.00 | 352.00 | 23.00 | 245.00 | **84.00** | no (order 3) |
| October (1-7) | 265.00 | 93.00 | 172.00 | 22.50 | 130.00 | **19.50** | yes |
| Total | 795.00 | 271.00 | 524.00 | 45.50 | 375.00 | **103.50** | no |

The first and last month are only the part inside the dates you asked for.

## If the Grab rate were **not set**

- Orders 4 and 10 have no commission number and are listed as "rate not set" (Grab). Commission is only the recorded 3.00.
- Net profit shows **146.00** (October 42.00) and the answer is **incomplete for two reasons**: order 3 has no cost, and the Grab rate is missing. The real profit is lower than 146.00.

## If a figure does not match

Write down the row number and what you expected. That is a question for the rules (for example "should the 15.00 platform charge be taken off when a commission is also taken off?"), and it goes into `docs/10-open-questions.md` before any code changes.
