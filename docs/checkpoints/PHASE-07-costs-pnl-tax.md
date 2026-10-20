# Phase 7 — Costs, P&L and Tax

**Status:** 🟡 In progress (since 2026-10-20) · **Depends on:** P6, Q3, Q12 · **Agents:** payments-finance-engineer, pos-frontend-engineer, qa-security-reviewer

## Goal
The owner sees real profit and a trustworthy tax estimate, and can hand clean numbers to the accountant.

## Scope
- **In:**
  - item and modifier costs;
  - optional recipe/ingredient costing;
  - expense ledger with receipt photos;
  - platform commissions and payout reconciliation;
  - gov co-pay receivables and settlement check;
  - P&L;
  - pricing helper;
  - tax estimator: 60% flat vs actual expenses, allowances, brackets, 0.5% method;
  - ภ.ง.ด.94 estimate;
  - VAT threshold and e-Payment watches;
  - cash receipts–payments report;
  - tax rules file for the current year.
- **Out:** filing returns, e-Tax invoices.

## Exit criteria
- [x] Tax estimator reproduces the accountant's worked examples (or rd.go.th examples) exactly
- [ ] P&L for a sample month is agreed by the owner or accountant
- [ ] Each tax screen shows the rule year and a disclaimer
- [x] Rules for a new year are added as a data file only, with no code changes

## As built
Part 1 (2026-10-20): `expenses` ledger (migration 0037, void not delete), `/v1/expenses` and `/v1/expenses/categories`, `/v1/settings/platform-commission` (owner, step-up). Part 2: nullable item cost (0038), margin and commission in `@sds/finance` and the reports answers. Part 3: `GET /v1/reports/pnl` (owner, `finance.pnl`), `profitAndLoss`. Part 4: `estimateTax` + yearly rules file, `GET /v1/reports/tax`, `/v1/settings/tax-profile`. See ARCHITECTURE.md.

## Log
- 2026-10-20: kickoff answers recorded; see PROGRESS entry "P7 · Kickoff answers recorded".
- 2026-10-20: part 1 expense ledger backend; see PROGRESS "P7 · Part 1".
- 2026-10-20: part 2 item costs, margin, commission estimate; see PROGRESS "P7 · Part 2".
- 2026-10-20: part 3 P&L backend; see PROGRESS "P7 · Part 3".
- 2026-10-20: part 4 tax estimator backend; see PROGRESS "P7 · Part 4".
