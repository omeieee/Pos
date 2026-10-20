# P7 profit-and-loss hand-check sample (synthetic, for the owner)

Made-up orders and expenses, in baht, over two weeks that cross a month end. Work out each figure yourself from the rows, then compare with the "Expected" lines. Nothing here is real shop data, and the two commission rates are **examples only** (the real rates are the ones you type in Settings from each merchant app). The same rows are pinned by the test `packages/finance/src/pnl-sample.test.ts`, so if the rules change, change both. The menu and cost rules are the ones in `docs/p7-margin-sample.md`.

**The rules being checked** (`docs/decisions.md` D-33, on top of D-32 and `docs/03-data-model.md` §6):
- **Revenue** = what was paid minus cash handed back, for paid orders that were not cancelled, on the order's own day.
- **Cost of goods** = cost typed in the POS x quantity, only for orders where **every** line has a cost. An order with a "no cost entered" line adds its revenue but **no cost**, and is listed.
- **Gross profit** = revenue - cost of goods.
- **Platform commission**: a figure recorded on the order wins; otherwise Grab / LINE MAN orders use the rate from Settings; with no rate there is no number and the order is listed.
- **Expenses** = the expense ledger by its date, **voided rows left out**.
- **Net profit before income tax** = gross profit - commission - expenses + the two overlaps that are not taken off (next two rules). A loss shows as a minus.
- **Food cost, larger of two** (owner-approved 2026-10-21): when the period has both a cost of goods and `ingredients` expenses, only the **larger** is taken off, because the menu cost may be the same food as the purchases. Both numbers still show; the smaller is listed as "not taken off", and the answer says which one was used. A tie uses the cost of goods.
- **Platform fees, larger of two**: the same for the platform commission against the `platform_fees` expense category. Only the larger is taken off. Other expense categories are never touched.
- **Month rows apply these two rules to their own month**, so the months need not add up to the whole-range total (one month's larger side can differ from the other's).
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
| Expenses (shown raw) | **375.00** | ingredients 250.00, gas 80.00, packaging 20.00, platform_fees 15.00, other 10.00 (the voided 999.00 is out) |
| Food cost not taken off | **250.00** | cost of goods 271.00 is larger than ingredients 250.00, so the ingredients are left out |
| Platform fees not taken off | **15.00** | commission 45.50 is larger than the platform_fees expense 15.00, so that expense is left out |
| **Net profit before income tax** | **368.50** | 524.00 - 45.50 - 375.00 + 250.00 + 15.00 (that is 524.00 - 45.50 - 110.00: gas, packaging, other) |

- **Incomplete**: order 3 (60.00 of revenue) has no cost, so its cost is missing and the 368.50 is **at most** the real profit. Order 3 and the item X are listed.
- The margin figure (as in the margin sample) uses only the 10 fully costed orders: revenue 735.00, cost 271.00, gross profit 464.00, margin 63.13%. It differs from the 524.00 above by exactly the 60.00 of order 3.
- Government co-pay revenue inside the 795.00: **60.00** (order 7). It counts on the sale date. Tracking when the government's share arrives (the receivable) is **not built yet**, and the answer says so.
- The `platform_fees` expense (15.00) and the commission (45.50) are both present, so only the larger (the commission) is taken off, and the screen says so. The same holds for the ingredients (250.00) against the cost of goods (271.00).

## Expected month by month

| | Revenue | Cost | Gross profit | Commission | Expenses (raw) | Food cost not taken off | Fees not taken off | Net profit | Complete? |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| September (24-30) | 530.00 | 178.00 | 352.00 | 23.00 | 245.00 | 150.00 (ingredients) | 15.00 (platform_fees) | **249.00** | no (order 3) |
| October (1-7) | 265.00 | 93.00 | 172.00 | 22.50 | 130.00 | 93.00 (cost of goods) | 0 | **112.50** | yes |
| Whole range | 795.00 | 271.00 | 524.00 | 45.50 | 375.00 | 250.00 | 15.00 | **368.50** | no |

The first and last month are only the part inside the dates you asked for. **The two months add to 361.50, not to 368.50**: each month picks its own larger side (in October the ingredients, 100.00, are larger than the cost of goods, 93.00), while the whole range picks the cost of goods (271.00 against 250.00). This is the rule as approved ("the larger in the period"); say if you would rather the months add up exactly.

## If the Grab rate were **not set**

- Orders 4 and 10 have no commission number and are listed as "rate not set" (Grab). Commission is only the recorded 3.00, which is now **smaller** than the 15.00 platform_fees expense, so the expense is the one taken off (the 3.00 is the "not taken off" amount).
- Net profit shows **399.00** (524.00 - 3.00 - 375.00 + 250.00 + 3.00; September 257.00, October 135.00) and the answer is **incomplete for two reasons**: order 3 has no cost, and the Grab rate is missing. The real profit is lower than 399.00.

## If a figure does not match

Write down the row number and what you expected. That is a question for the rules (for example "should the 15.00 platform charge be taken off when a commission is also taken off?" - today only the larger of the two is), and it goes into `docs/10-open-questions.md` before any code changes.
