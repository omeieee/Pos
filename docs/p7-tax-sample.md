# P7 income tax estimate: hand-check sample (synthetic, for the owner)

Made-up shop figures, in baht, for tax year 2569 (2026). Work each line out yourself, then compare with "Expected". Nothing here is real shop data, and the result is **an estimate to plan with, not a tax return**. The same numbers are pinned by `packages/finance/src/tax-sample.test.ts`; if you change one, change the other.

**Status: proposed. Confirm with the Revenue Department (RD).** Rule year: **2569**.

## The rules being checked (`docs/decisions.md` D-34)
- **Income** = the P&L revenue of the period (net paid, on the business date). **Actual expenses** = cost of goods + platform commission + the expense ledger (voided rows left out), exactly the lines the P&L takes off. **Flat 60%** = 60% of income (RD table 2, item 9: restaurant, food and drink). Pick one method for the whole income.
- **Net income** = income - expenses. Take off the allowances. **If it is 0 or less, there is no tax** (the loss is still shown).
- **Rates on the rest** (same for the half-year and the annual return): up to 150,000 exempt; 150,001-300,000 5%; 300,001-500,000 10%; 500,001-750,000 15%; 750,001-1,000,000 20%; 1,000,001-2,000,000 25%; 2,000,001-5,000,000 30%; over 5,000,000 35%.
- **Allowances:** personal 60,000 a year; **30,000 on the half-year return (ภ.ง.ด.94)**.
- **0.5% rule:** work out 0.5% of income. If it is **5,000 or less, ignore it**. If it is more, pay the higher of that and the normal tax. (That means it only matters when income is over 1,000,000.)
- Rounding: the tax is rounded once, half up, to a satang. RD's tables are in whole baht, so the last satang is not confirmed.

Where each rule comes from, with the page and the date read, is in `packages/finance/src/tax-rules/th-pit-2569.ts` and in `docs/06-legal-compliance.md` §1.

## Worksheet A: half-year (Jan-Jun 2569, the ภ.ง.ด.94 basis)

P&L figures for 1 Jan - 30 Jun 2026:

| Line | Baht |
|---|---:|
| Revenue (income) | 540,000 |
| Cost of goods | 150,000 |
| Platform commission | 18,000 |
| Expenses: rent 60,000 + gas 30,000 + electricity and water 24,000 + packaging 18,000 + other 12,000 | 144,000 |

| Step | Actual expenses | Flat 60% |
|---|---:|---:|
| Expenses | 150,000 + 18,000 + 144,000 = **312,000** | 540,000 x 60% = **324,000** |
| Net income | 540,000 - 312,000 = **228,000** | 540,000 - 324,000 = **216,000** |
| Allowance (personal, half-year) | 30,000 | 30,000 |
| Taxable | **198,000** | **186,000** |
| Tax: first 150,000 | 0 | 0 |
| Tax: next part at 5% | 48,000 x 5% = **2,400** | 36,000 x 5% = **1,800** |
| 0.5% of 540,000 = 2,700, not over 5,000 | ignored | ignored |

**Expected:** with actual expenses (your choice) the estimate is **2,400**. The flat 60% would be 1,800, so it is cheaper by 600. The estimate names that but does not switch you: actual expenses need receipts, flat does not.

Also expected: the shop **must file** (income over 60,000 for Jan-Jun), the window **1 July - 30 September 2026 has passed**, so a late-filing note shows. VAT: 540,000 is 30% of 1,800,000 (below). The estimate also lists: cost of goods comes from your menu cost estimates, not receipts; and every note about the proposed status and the sources.

## Worksheet B: a year over 1,000,000 (the 0.5% rule shows)

| Line | Baht |
|---|---:|
| Revenue for 1 Jan - 31 Dec | 1,200,000 |
| Cost of goods 600,000 + commission 100,000 + expenses 450,000 | 1,150,000 |

| Step | Actual expenses | Flat 60% |
|---|---:|---:|
| Net income | 1,200,000 - 1,150,000 = **50,000** | 1,200,000 - 720,000 = **480,000** |
| Allowance (personal, year) | 60,000 | 60,000 |
| Taxable | 0 (loss after allowance) | **420,000** |
| Normal tax | 0 | 7,500 + (420,000 - 300,000) x 10% = **19,500** |
| 0.5% of 1,200,000 | **6,000** (over 5,000: it counts) | 6,000 (lower than 19,500) |
| Tax to pay | **6,000** | **19,500** |

**Expected:** with actual expenses the estimate is **6,000** and a 0.5% block is shown, with a note that RD pages disagree on the 60,000 / 120,000 threshold and that the result is the same either way.

## Revenue Department's own examples (checked by the tests)
- Rate table 1, tax at the top of each step: 300,000 -> 7,500; 500,000 -> 27,500; 750,000 -> 65,000; 1,000,000 -> 115,000; 2,000,000 -> 365,000; 5,000,000 -> 1,265,000. Source: [RD ภ.ง.ด.94 instruction 2569](https://www.rd.go.th/fileadmin/tax_pdf/pit/2569/Ins94_160669.pdf), page 17.
- Net income 520,000 -> **30,500** (0 + 7,500 + 20,000 + 3,000). Source: [RD FAQ](https://www.rd.go.th/61549.html).
- 0.5% against the normal tax (tax year 2552 examples): income 800,000 (0.5% = 4,000, normal tax 0) -> pays 0; income 1,000,000 (5,000, normal 2,000) -> pays 2,000; income 1,100,000 (5,500, normal 4,000) -> pays 5,500. Source: [RD](https://www.rd.go.th/31847.html).

## What you still need to check yourself
- The allowances beyond your personal one, if you have any (insurance, social security, funds, parents, children). The estimate takes the amounts you type and does not check the caps.
- That your expense records (receipts) support the actual expenses, and that the same food is not both a dish cost and an "ingredients" expense.
- That the shop's tax-return deadlines are as shown, especially if you filed online.
