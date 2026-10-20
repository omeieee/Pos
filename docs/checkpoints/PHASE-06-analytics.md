# Phase 6 — Back-Office Analytics

**Status:** 🟡 In progress · **Depends on:** P5 · **Agents:** payments-finance-engineer, pos-frontend-engineer, ux-ui-designer

## Goal
The owner understands sales, menu performance and customers at a glance, on the laptop and the iPhone.

## Scope
- **In:**
  - dashboards by day, week, month and year with comparison to the previous period;
  - by channel and payment method;
  - top and bottom items;
  - menu-engineering matrix;
  - hour × weekday heatmap;
  - customer list, segments and favourites;
  - CSV/XLSX exports.
- **Out:** P&L and tax (P7).

## Exit criteria
- [ ] Report totals match a hand-checked sample day and month exactly (to the satang)
- [ ] Every chart follows the dataviz guidelines, with Thai labels, and reads well on iPhone and laptop
- [ ] Exports open correctly in Excel and Google Sheets with Thai text intact
- [ ] Each report query runs in < 300 ms on a year of data

## As built
- `packages/finance` (pure): `revenueByDay`, `itemSales`, `heatmap`, customer segments and favourites; rules from `03-data-model.md` §6. `packages/db` `reportsRepo`. API `GET /v1/reports/{revenue,items,heatmap,customers}` (`apps/api/src/reports`; customers is owner only, `customer.report`). CSV export `GET /v1/reports/export/{revenue,items}.csv` (owner, step-up, audited). Screens: `#/dashboard` reads the report API (`apps/pos-web/src/pos/reports`, `DashboardScreen.tsx`); chart colours are `chart.*` tokens in `@sds/ui`. Orders whose refunds exceed their payment are set aside (`splitInconsistent`) and named in `excludedOrderIds`; same-range loads are shared (`loadReportOrders`); the month calendar (`/v1/orders/summary`) nets refunds. Hand-check sample: `docs/p6-hand-check-sample.md` (pinned by `hand-check.test.ts`; awaiting the owner). Not built: XLSX, items margin (P7), screens on a real device.
- Kickoff answers (defaults): `docs/10-open-questions.md`, "P6 analytics kickoff".

## Log
- 2026-10-17: part 1, revenue core ([PROGRESS](../PROGRESS.md)).
- 2026-10-17: parts 2–5, queries and API for revenue, items, heatmap, customers ([PROGRESS](../PROGRESS.md)).
- 2026-10-17: parts 6–8, CSV export, overview on real data, chart tokens ([PROGRESS](../PROGRESS.md)).
- 2026-10-17: deployed (`da7dfd7`). QA follow-ups settled without code: a refund larger than its payment still makes the report fail loudly (the report must not clamp money silently; the correction service is what prevents it); the overview's items card shows units only, so no "items total is not revenue" note is needed on screen (the items CSV carries revenue and is labelled by its header). Still open and owner- or VM-dependent: year-view timing on real Postgres, hand-checked sample day, XLSX decision, Excel/Sheets and iPad/iPhone checks, D-30 approval.
- 2026-10-17: QA follow-ups built (this supersedes the line above: the report now sets such an order aside and warns instead of failing), hand-check sample, docs drift; uncommitted ([PROGRESS](../PROGRESS.md)).
