# CLAUDE.md — Saap Don Sen POS (แซ่บโดนเส้น)

A cloud POS for a made-to-order noodle restaurant inside a condominium.
- **Orders** come from the storefront and the shop's LINE Official Account.
- **Payments** are PromptPay, cash or a government co-pay scheme, **always confirmed by staff**.
- **Devices** (iPad, iPhone, laptop) stay in sync in real time. Staff use Safari on iPad/iPhone and standard browsers on computers. Native installable apps come in P10.
- **Back office** covers revenue, customers, menu performance, costs/P&L and Thai tax estimates.
- **Hosting** runs 24/7 on free tiers (Oracle VM + Cloudflare). The UI is Thai-first.

## Status and sources of truth
- **Current phase:** the header of [docs/PROGRESS.md](docs/PROGRESS.md). P1 Foundation built the packages; apps come in P2–P4.
- **Stack and design choices:** [docs/decisions.md](docs/decisions.md). Don't restate them elsewhere, and don't change them silently. Propose a decision entry first.
- **Open owner questions:** [docs/10-open-questions.md](docs/10-open-questions.md).

## Workflow
**At the start of every session**
1. Read `docs/PROGRESS.md`: current phase, last entry, next step.
2. Read the current phase file in `docs/checkpoints/`.
3. Load only the docs the task needs (map below).

**Before starting any phase (owner's standing rule)**
- Read that phase's checkpoint and `docs/10-open-questions.md`.
- **Ask the owner for every piece of missing information the phase needs**, in one list, before writing code for it.
- Record the answers in `10-open-questions.md` and start only when nothing blocking is left.

**For every task**
- Plan briefly, with verifiable steps.
- Ask when a requirement is unclear, especially about money, payments, tax or permissions.
- Keep diffs surgical.
- Delegate to the matching agent when the task sits in its area.

**At the end of every task:** run `/checkpoint "<summary>"`. It logs progress, updates the phase checkpoint's as-built notes, and updates decisions if needed. Commit only when the owner asks.

## Docs map
| Doc | Read when working on |
|---|---|
| [01-requirements](docs/01-requirements.md) | Scope, feature IDs (M/S/L/P/R/C/B/F/T/A), NFRs, changes forced by research (CR1–CR5) |
| [02-architecture](docs/02-architecture.md) | Components, repo layout, flows, realtime protocol, API surface, security, offline, failure modes |
| [03-data-model](docs/03-data-model.md) | Tables, state machines, order numbering, reporting rules, retention |
| [04-integrations](docs/04-integrations.md) | LINE (channels, quota, webhook), PromptPay QR spec, ไทยช่วยไทย rules, Grab/LINE MAN, ntfy, XP-80T printer |
| [05-infrastructure](docs/05-infrastructure.md) | Hosting paths A/B, free-tier limits, Cloudflare, VM hardening, backups/DR, monitoring, CI/CD, 24/7 ops |
| [06-legal-compliance](docs/06-legal-compliance.md) | Tax (PIT, VAT, e-Payment), records, permits, condo rules, PDPA, scheme and LINE terms |
| [07-limitations-risks](docs/07-limitations-risks.md) | Known limitations and the risk register |
| [08-skills-knowledge](docs/08-skills-knowledge.md) | What to learn; how Claude Code is used on this repo |
| [09-roadmap](docs/09-roadmap.md) | Phases P0–P10, MVP line, sizes |
| [decisions](docs/decisions.md) · [PROGRESS](docs/PROGRESS.md) · [checkpoints/](docs/checkpoints/) | Choices · log · per-phase goals, exit criteria and as-built notes |

## System map (planned; P1 creates the folders)
| Component | Responsibility | Agent |
|---|---|---|
| `apps/api` | Fastify REST `/v1`, WebSocket realtime, LINE webhook, pg-boss jobs | backend-engineer (LINE module: line-integration-engineer) |
| `apps/pos-web` | Staff PWA: POS, order board/kitchen, payments, menu, customers, back office, settings | pos-frontend-engineer |
| `apps/liff-web` | Customer app in LINE (MINI App / LIFF): menu, cart, checkout, pay, status | line-integration-engineer |
| `apps/print-agent` (P8) | Mini PC service → XP-80T kitchen tickets over LAN | backend-engineer + devops-engineer |
| `apps/pos-mobile` · `apps/pos-desktop` (P10) | Capacitor (iPad/iPhone) · Electron (Windows/macOS/Linux) shells around the `pos-web` build | pos-frontend-engineer + devops-engineer |
| `packages/shared` | Domain types, Zod schemas, state machines, permissions, money/date utils (pure) | backend-engineer |
| `packages/db` | Drizzle schema, migrations, seed, report queries | backend-engineer |
| `packages/promptpay` | EMVCo PromptPay payload + CRC16 (pure) | payments-finance-engineer |
| `packages/finance` | Reports, P&L, Thai tax estimators, rules per tax year (pure) | payments-finance-engineer |
| `packages/line` | Signature check, Flex builders, quota-aware sender, rich menu | line-integration-engineer |
| `packages/ui` · `packages/i18n` | Design tokens/components · th/en strings and formatters | ux-ui-designer |
| `packages/notify` · `packages/escpos` (P8) | ntfy/web-push adapters · raster ESC/POS tickets | backend-engineer |
| `design/` | Brand, wireframes, specs, rich-menu art | ux-ui-designer |
| `infra/` · `.github/workflows/` | Compose, Oracle, Cloudflare, backups, monitoring, runbook · CI/CD | devops-engineer |

**Dependency rules**
- Apps import packages. An app never imports another app.
- `shared`, `promptpay` and `finance` have no I/O.
- Only `db` imports the ORM. Only `line` and `api/modules/line` talk to LINE.
- No business rules in React components.

## Domain rules (never break)
1. **Money** is integer satang (`bigint`), THB only. The server computes totals; the UI only formats them.
2. **Staff confirm every payment by hand.** A customer's "โอนแล้ว" or slip only makes the payment `claimed`. Never confirm automatically from a slip.
3. **The PromptPay QR** is EMVCo dynamic, with the exact order total and the PromptPay ID from settings.
   - Never hardcode the ID; the initial value is recorded in 01-requirements P3.
   - Changing it requires the owner + step-up + audit + alert.
4. **Government co-pay (ไทยช่วยไทย)** is a configurable scheme.
   - It is available only within the scheme's dates and hours, and only face to face between staff and the customer: at the counter or at the entrance hand-over (owner decision 2026-10-02: the shop delivers only to the building entrance; the scheme terms for this are not yet confirmed with ถุงเงิน).
   - Staff create the ถุงเงิน QR per transaction. It is **never sent through LINE**.
5. **LINE:** reply first, which is free. Push only through the quota-aware sender (the free plan counts 300 messages a month).
6. **Writes:**
   - order and payment changes go only through the `packages/shared` state machines;
   - each write is one transaction that bumps `rev` and `version`, with events published after commit;
   - `POST` is idempotent, and `PATCH` needs `expectedVersion`.
7. **Time:** store `timestamptz` in UTC, display Asia/Bangkok, and group reports by `business_date` (cutoff setting).
8. **Language:** Thai-first. All user-facing text goes through `packages/i18n` (th, en). Buddhist Era dates in the Thai locale.
9. **Sensitive actions** (PromptPay ID, voids or refunds after confirmation, staff and devices, exports) need step-up auth and write `audit_log`.
10. **No secrets or real customer data** in git, logs, notifications or tests.
11. **Private keys:** never open, print, paste or commit them. That includes the Oracle SSH key at `~/.ssh/ssh-key-2026-09-28.key` (outside the repo). Refer to keys by path only. Commands that use a key must be read-only unless the owner has approved the change.

## Conventions
- TypeScript strict. Zod at every boundary. No `any` in domain code.
- **Tests:** anything touching money, payments or tax gets tests first.
  - Vitest for unit and integration tests.
  - Playwright for E2E at iPad (1180×820) and iPhone (390×844) viewports.
- **Migrations:** forward-only, expand/contract. Never edit an applied migration.
- **Commits:** Conventional Commits (`feat(api): …`, `fix(pos-web): …`), one logical change each.
- **Environments:** local development uses the **test LINE OA**. Real customers must never receive test messages.
- **Clients:**
  - Until P10 the targets are Safari on iPad/iPhone (Home Screen recommended) and desktop browsers.
  - Features use the platform interface (`apps/pos-web/src/platform/`), never browser APIs directly, so the native shells can swap implementations later.
  - Playwright runs Chromium, Firefox and WebKit, but real-device Safari checks are still required.

## Agents (`.claude/agents/`)
backend-engineer · pos-frontend-engineer · line-integration-engineer · payments-finance-engineer · ux-ui-designer · devops-engineer · qa-security-reviewer (read-only; run it before merging big changes and at every phase end).
- Give parallel agents separate directories, or use git worktrees.
- Agents report back to the main session, which records progress with `/checkpoint`. Agents do not edit `PROGRESS.md`.

## Commands
- `pnpm install` · `pnpm lint` (Biome) · `pnpm format` · `pnpm build` (typecheck all) · `pnpm test` (Vitest, all packages)
- `pnpm --filter @sds/db db:generate` (new migration from schema; never edit applied ones) · migrations + seed run on PGlite in tests (`createPgliteDb()` from `@sds/db/pglite`, `seed()` from `@sds/db/seed`)
- `pnpm --filter @sds/ui tokens:css` (regenerate `design/wireframes/tokens.css`)
- `node packages/promptpay/scripts/scan-test.ts <out.html> <promptpay-phone>` (bank-app QR scan page)
- Later: dev, e2e, deploy (P2–P3)

## Glossary
| Thai | Meaning here |
|---|---|
| หน้าร้าน | Storefront / walk-in |
| พร้อมเพย์ | PromptPay |
| สลิป · โอนแล้ว | Transfer slip image · the customer's "I've paid" claim |
| เงินทอน | Change (cash) |
| หมด | Sold out |
| ไทยช่วยไทย พลัส | Government 60/40 co-pay scheme (2026) |
| ถุงเงิน · เป๋าตัง | Merchant app (creates the per-transaction QR) · citizen payment app |
| ส่งถึงห้อง | Delivery to a condo room |
| ภ.ง.ด.90 / ภ.ง.ด.94 | Annual / mid-year personal income tax returns |
| นิติบุคคลอาคารชุด | Condominium juristic person (building management) |
