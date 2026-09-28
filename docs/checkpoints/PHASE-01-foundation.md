# Phase 1 — Foundation

**Status:** ⚪ Not started · **Depends on:** P0 exit · **Agents:** backend-engineer, payments-finance-engineer, ux-ui-designer, devops-engineer (CI), qa-security-reviewer

## Goal
A working monorepo with the domain core, database schema, PromptPay library and design tokens, all tested, before any feature screens exist.

## Scope
- **In:**
  - monorepo scaffold, Biome, tsconfig references, boundary lint rules;
  - CI (lint, typecheck, test, build);
  - `packages/shared`: money, business date, enums, order/payment state machines, permission matrix, Zod schemas;
  - `packages/db`: schema v1, migrations, seed with a Thai sample menu and the initial PromptPay ID in settings;
  - `packages/promptpay`;
  - `packages/i18n` skeleton;
  - `packages/ui` tokens + base components, with **per-device overrides for iPad, iPhone and laptop** (A4);
  - `design/` brand and wireframes for key screens, **for each of the 3 devices**, delivered **both as HTML pages in `design/` and in Figma**;
  - Claude Code hooks: format and typecheck after edits, protect applied migrations and `.env*`.
- **Out:** feature screens, deployment.

## Exit criteria
- [ ] `pnpm install && pnpm build && pnpm test` passes locally and in CI
- [ ] State-machine tests cover every allowed and forbidden transition
- [ ] Money tests: rounding, totals with modifiers, cash change
- [ ] PromptPay: decoded TLV + CRC match the reference library for the test matrix; **scanned correctly in 1 of the owner's bank apps (K PLUS or Krungthai NEXT)**; more apps when the owner decides (test PromptPay 0642230924, personal test account; list amounts and results below)
- [ ] Migrations run on an empty Postgres; seed loads
- [ ] Wireframes/mockups for POS order entry, payment sheet and LINE menu/checkout, for **iPad, iPhone and laptop**, in **both** `design/` HTML and Figma, approved by the owner
- [ ] Per-device tokens: changing one device's overrides leaves the other two unchanged

## As built
_Fill in with `/checkpoint`: packages created, key modules, schema tables, test counts._

## Log
_Empty._
