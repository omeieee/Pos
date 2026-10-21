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
  - P&L;
  - pricing helper;
  - tax estimator: 60% flat vs actual expenses, allowances, brackets, 0.5% method;
  - ภ.ง.ด.94 estimate;
  - VAT threshold and e-Payment watches;
  - receipts–payments report (all methods; running net from an owner-set start amount, D-35);
  - tax rules file for the current year.
- **Out:** filing returns, e-Tax invoices; gov co-pay receivables and a settlement mark (owner decision 2026-10-21: not needed, the P&L says "not tracked").

## Exit criteria
- [x] Tax estimator reproduces the accountant's worked examples (or rd.go.th examples) exactly
- [ ] P&L for a sample month is agreed by the owner or accountant
- [ ] Each tax screen shows the rule year and a disclaimer
- [x] Rules for a new year are added as a data file only, with no code changes

## As built
Part 1 (2026-10-20): `expenses` ledger (migration 0037, void not delete), `/v1/expenses` and `/v1/expenses/categories`, `/v1/settings/platform-commission` (owner, step-up). Part 2: nullable item cost (0038), margin and commission in `@sds/finance` and the reports answers. Part 3: `GET /v1/reports/pnl` (owner, `finance.pnl`), `profitAndLoss`. Part 4: `estimateTax` + yearly rules file, `GET /v1/reports/tax`, `/v1/settings/tax-profile`. Part 5: screens in `apps/pos-web/src/pos/finance` (`#/expenses`, `#/pnl`, `#/tax`) and commission settings. See ARCHITECTURE.md.

## Log
- 2026-10-20: kickoff answers recorded; see PROGRESS entry "P7 · Kickoff answers recorded".
- 2026-10-20: part 1 expense ledger backend; see PROGRESS "P7 · Part 1".
- 2026-10-20: part 2 item costs, margin, commission estimate; see PROGRESS "P7 · Part 2".
- 2026-10-20: part 3 P&L backend; see PROGRESS "P7 · Part 3".
- 2026-10-20: part 4 tax estimator backend; see PROGRESS "P7 · Part 4".
- 2026-10-21: part 5 screens; see PROGRESS "P7 · Part 5".
- 2026-10-21: QA review and fixes (larger-of rules, owner-only rates); see PROGRESS "P7 · QA review and fixes".
- 2026-10-21: part 6 receipts-payments report; see PROGRESS "P7 · Part 6".
- 2026-10-21: part 6 QA fixes, push and deploy; see PROGRESS "P7 · Part 6 QA fixes".
- 2026-10-21: owner answers (R2 photo storage, Slip2Go package); see PROGRESS "P7 · Owner answers".
- 2026-10-21: R2 storage and receipt photo screen (D-36); see PROGRESS "P7 · R2 storage".
