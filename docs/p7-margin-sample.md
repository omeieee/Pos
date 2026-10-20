# P7 margin hand-check sample (synthetic, for the owner)

Made-up orders, in baht. Work out each figure yourself from the rows, then compare with the "Expected" lines. Nothing here is real shop data, and the two commission rates are **examples only** (the real rates are the ones you type in Settings from each merchant app). The same rows are pinned by the test `packages/finance/src/margin-sample.test.ts`, so if the rules change, change both.

**The rules being checked** (`docs/decisions.md` D-32, on top of `docs/03-data-model.md` §6):
- Cost comes from what was saved on each order line when it was sold (cost of the dish plus the cost of any extras). A line sold when the dish had **no cost entered** has no cost, and it is **not** treated as a cost of 0.
- **Per item:** only the units that have a cost count toward cost, profit and margin. Profit = line totals - cost. Margin = profit / line totals.
- **Per period:** only orders where **every** line has a cost count. Revenue is the usual net paid (cash handed back is taken off). Cost = the sum of cost x quantity. Profit = revenue - cost. A discount or refund lowers revenue but not cost (the food was made). Orders left out are listed.
- Profit here is **before** platform commission. Commission is an expense shown beside it: an amount recorded on the order wins, otherwise Grab/LINE MAN orders use the rate from Settings, and with no rate there is no number.

## The menu

| Dish | Price | Cost typed in the POS |
|---|---:|---|
| T ก๋วยเตี๋ยวต้มยำ | 60.00 | 22.00 (an extra egg adds 3.00 to the cost and 5.00 to the price) |
| Y เย็นตาโฟ | 70.00 | 28.00 |
| W น้ำเปล่า | 10.00 | 4.00 |
| X ชาเย็น | 25.00 | **not entered** on day 1; 9.00 typed in before day 2 |

Example rates: Grab 25.00%, LINE MAN 20.00%.

## Day 1 · Monday 14 Sep 2026

| # | Channel | What was ordered | Paid | What happened | Counts? | Revenue |
|---|---|---|---:|---|---|---:|
| 1 | Storefront | T x2 (120.00), W x1 (10.00) | 130.00 | Cash | yes | 130.00 |
| 2 | LINE | Y x1 (70.00), T x1 with egg (65.00, cost 25.00) | 135.00 | PromptPay | yes | 135.00 |
| 3 | Storefront | X x2 (50.00), W x1 (10.00) | 60.00 | Cash | yes | 60.00 |
| 4 | Grab | Y x1 (80.00 platform price) | 80.00 | Platform paid; no commission recorded | yes | 80.00 |
| 5 | LINE | T x1 (60.00) | - | Cancelled | no | 0 |
| 6 | Storefront | T x1 (60.00) | 60.00 | Cash, 10.00 handed back | yes | 50.00 |
| 7 | LINE MAN | W x2 (20.00) | 20.00 | Platform paid; commission 3.00 recorded | yes | 20.00 |

## Day 2 · Tuesday 15 Sep 2026

| # | Channel | What was ordered | Paid | What happened | Counts? | Revenue |
|---|---|---|---:|---|---|---:|
| 8 | Storefront | X x1 (25.00, cost 9.00) | 25.00 | Cash | yes | 25.00 |

Revenue for the two days: **500.00** from 7 orders (130 + 135 + 60 + 80 + 50 + 20 + 25).

## Expected per item (both days)

| Dish | Units | Line totals | Units with a cost | Cost | Profit | Margin |
|---|---:|---:|---:|---:|---:|---:|
| T | 4 | 245.00 | 4 | 91.00 (22 + 22 + 25 + 22) | 154.00 | 62.86% |
| Y | 2 | 150.00 | 2 | 56.00 | 94.00 | 62.67% |
| W | 4 | 40.00 | 4 | 16.00 | 24.00 | 60.00% |
| X | 3 | 75.00 | **1** | 9.00 | 16.00 | 64.00% (from the 1 costed cup only; 2 cups had no cost) |

X is listed as an item with "no cost entered" on some sales. Its margin is the margin of the costed cup only.

## Expected for the period

- Orders with every line costed: **6** (all except order 3, whose tea had no cost). Order 3 (60.00 of revenue) is left out and named, and so is the item X.
- Revenue of those 6: 130 + 135 + 80 + 50 + 20 + 25 = **440.00**.
- Cost of those 6: 48 + 53 + 28 + 22 + 8 + 9 = **168.00**. (Order 6 still costs 22.00 although 10.00 was handed back.)
- Gross profit: 440.00 - 168.00 = **272.00**. Margin: 272 / 440 = **61.82%**.

## Expected platform commission

- Order 7 (LINE MAN): the recorded **3.00** is used, not the 20% rate.
- Order 4 (Grab): nothing recorded, so the rate applies: 25% of 80.00 = **20.00**.
- Total commission **23.00**. Profit after commission, for the 6 costed orders (both platform orders are among them): 272.00 - 23.00 = **249.00**.
- If the Grab rate were **not set**: the total would be only 3.00 and order 4 would be listed as "rate not set".

## If a figure does not match

Write down the row number and what you expected. That is a question for the rules (for example "should the 10.00 handed back also reduce the cost of order 6?"), and it goes into `docs/10-open-questions.md` before any code changes.
