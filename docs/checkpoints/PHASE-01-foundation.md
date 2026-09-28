# Phase 1 — Foundation

**Status:** 🟡 In progress (code complete 2026-09-29; owner checks pending) · **Depends on:** P0 exit · **Agents:** backend-engineer, payments-finance-engineer, ux-ui-designer, devops-engineer (CI), qa-security-reviewer

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
  - `design/` brand and wireframes for key screens, **for each of the 3 devices**, as HTML pages in `design/` (Figma deferred by the owner, 2026-09-29);
  - Claude Code hooks: format and typecheck after edits, protect applied migrations and `.env*`.
- **Out:** feature screens, deployment.

## Exit criteria
- [ ] `pnpm install && pnpm build && pnpm test` passes locally and in CI — locally ✅ 2026-09-29; CI run not yet confirmed
- [x] State-machine tests cover every allowed and forbidden transition (`shared/src/machines.test.ts`: every state × state × 6 actors, plus reason and step-up)
- [x] Money tests: rounding, totals with modifiers, cash change (`shared/src/money.test.ts`)
- [ ] PromptPay: decoded TLV + CRC match the reference library for the test matrix (✅ 1,271 tests, 313 amounts × 4 targets); **scanned correctly in K PLUS** (owner's choice, 2026-09-29); more apps when the owner decides (test PromptPay 0642230924, personal test account; list amounts and results below)
- [x] Migrations run on an empty Postgres; seed loads (`db/src/db.test.ts` on PGlite 0.4.6 = PostgreSQL 17)
- [ ] Wireframes/mockups for POS order entry, payment sheet and LINE menu/checkout, for **iPad, iPhone and laptop**, as `design/` HTML (Figma deferred), approved by the owner
- [x] Per-device tokens: changing one device's overrides leaves the other two unchanged (`ui/src/resolve.test.ts`)

## As built
- **Tooling:** pnpm 12 workspaces + Turborepo; TypeScript 7 strict (`packages/config`); Biome (format + lint; `noRestrictedImports`/`noRestrictedGlobals` keep `shared|promptpay|finance/src` pure and the ORM in `db`). Packages are source-only (`exports` → `src/index.ts`); `pnpm build` = typecheck.
- **shared:** `money` (branded safe-integer satang, half-up bp, totals, change), `business-date` (Asia/Bangkok, cutoff 04:00), `enums`, `permissions` (role matrix + step-up set), `state-machine` + `order-machine` + `payment-machine` (+ `derivePaymentStatus`), Zod `schemas`.
- **promptpay:** `promptpayPayload`, `crc16`, `decodeTlv`, `hasValidCrc`; `scripts/scan-test.ts` → HTML QR page.
- **db:** Drizzle schema v1 (21 tables, 03-data-model), migrations 0000 functions (`uuid_generate_v7`, `set_sync_columns`, `forbid_change`), 0001 schema, 0002 triggers; `createPgliteDb()`, idempotent `seed()`.
- **i18n:** th/en catalogs, `t()`, `formatBaht`, BE `formatDate`. **ui:** tokens + iPad/iPhone/laptop overrides, `resolveTokens`, `toCssVariables`, contrast helpers; `pnpm --filter @sds/ui tokens:css`. React components deferred to P3.
- **design/:** `brand.md`, `wireframes/` (3 screens × 3 devices + index).
- **Sync note:** `menu_item_channel_prices`, `menu_item_modifier_groups` and `order_items` have no `rev`; the API must bump the parent row (`menu_items` / `orders`) in the same transaction when they change.
- **Infra/CI:** `.github/workflows/ci.yml`; `infra/supabase/bootstrap.sql`; hooks in `.claude/settings.json` (protect migrations/.env, format + per-package typecheck).

## Carry-forward from the P1 QA review (2026-09-29)
Fixed in P1: purity lint gaps (M1), protect hook fails closed and covers relative paths + `migrations/meta` (M2), scan script needs the phone argument (M3), `pnpm audit --prod` in CI (M4), TRUNCATE blocked by migration 0003 (F1), TLV length validation + max amount in the matrix (F11).
- **P2:** sync must exclude `staff.pin_hash` and `devices.token_hash` (F10); `SET search_path` on the SQL functions and run the migration set on Supabase 17.6 (F9); link tables need a parent-row bump or their own sync columns (F4); decide on dev-only esbuild advisory via drizzle-kit.
- **P3:** DB-level guards for confirmed payments (immutable amount/method, allowed status edges, no `order_items` update) and lock the order row on confirm (F2); separate staff vs customer order input, the server sets the channel and customer (F5); `settingPermission(key)` so `promptpay` needs `settings.promptpay` (F6); zero-total/overpayment/exact-amount rules (F7); staff PIN to leave the iPad customer-facing mode (F12, with Q14.6).
- **P3/P4:** define `gov_copay_schemes.channels` as the payment location, add CHECKs (F3).
- **Before P5:** seed must not load the personal test PromptPay ID in production (F8).
- **Tooling (low):** hook path quoting and case-insensitive root match, dependents typecheck (F13); pin CI actions by SHA and add a secret scan (F14); a lint fixture test for the purity rules.

## Log
- 2026-09-29 · Foundation built; owner checks pending ([PROGRESS](../PROGRESS.md#2026-09-29--p1--foundation-built-awaiting-owner-checks))
