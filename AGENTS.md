# AGENTS.md — Saap Don Sen POS (แซ่บโดนเส้น)

Instructions for AI coding agents other than Claude Code (Gemini, Antigravity and others).
Claude Code works on this repo too. It reads `CLAUDE.md` and gets some help automatically
(hooks, a checkpoint skill, role agents, saved memory). This file shows you how to do the same by hand,
so that you and Claude share one project memory and follow the same rules.

**`CLAUDE.md` is the source of truth.** If this file and `CLAUDE.md` disagree, follow `CLAUDE.md`
and tell the owner about the mismatch.

## 1. Project memory: where it lives
Nothing is remembered between sessions except what is written in the repo. The memory is:

| File | What it holds |
|---|---|
| `CLAUDE.md` | Project summary, domain rules, conventions, docs map, system map, commands, glossary |
| `docs/PROGRESS.md` | **Header:** current phase, live state, next step. **Entries:** newest first, one per finished task |
| `docs/checkpoints/PHASE-XX-*.md` | Per phase: goals, exit criteria, as-built notes, log |
| `docs/decisions.md` | Every stack and design decision (`D-xx`). About 110 KB: **search it for `D-xx`; never read all of it** |
| `docs/10-open-questions.md` | Owner questions and recorded answers |
| `ARCHITECTURE.md` | As-built code index: files, exports, routes, stores, tables. **Read it before you search the code** |
| `.claude/agents/<role>.md` | Role playbooks (rules, scope, testing) for each area of the code |
| `.claude/agent-memory/<role>/` | Lessons learned per role (e.g. pnpm release-age trap, GitHub plan limits) |
| `.claude/skills/checkpoint/SKILL.md` | The procedure for recording progress (section 4) |
| `docs/plans/` | Written plans for larger tasks; a plan may come from Claude for you to carry out |

## 2. At the start of every session
1. Read `CLAUDE.md` in full. It is short, and every rule in it applies to you.
2. Read the **header** and the **newest entry** of `docs/PROGRESS.md`. Older entries are archived in `docs/progress/`. Open them only when the task needs that history.
3. Read the current phase file in `docs/checkpoints/` (named in the header).
4. Run `git status --short` and `git log --oneline -5` so you know what is uncommitted.
5. Load only the docs the task needs (docs map in `CLAUDE.md`). For the code area you will touch, read the matching role playbook and memory (section 5).

**Before starting a new phase** (owner's standing rule): read that phase's checkpoint and
`docs/10-open-questions.md`. Ask the owner for every missing piece of information, in one list, before
writing any code. Record the answers in `10-open-questions.md`.

## 3. Rules you must never break (summary; full wording in `CLAUDE.md`)
1. **Money** is integer satang (`bigint`), THB only. The server computes totals; the UI only formats them.
2. **Payments are confirmed by staff by hand.** A customer's "โอนแล้ว" or slip only makes a payment `claimed`.
   The only automatic confirm is the Slip2Go path in D-27 (bank-verified `200200`, exact conditions, under
   the ceiling, `SLIP_AUTOCONFIRM` on, `system` actor, audited, voidable).
3. **PromptPay QR** is EMVCo dynamic with the exact total; the PromptPay ID comes from settings, never from code.
4. **Government co-pay (ไทยช่วยไทย)** only within scheme dates and hours, face to face. Its ถุงเงิน QR is **never sent through LINE**.
5. **LINE:** reply first (free); push only through the quota-aware sender (300 messages a month).
6. **Writes:** order and payment changes go only through the `packages/shared` state machines. One transaction
   per write that bumps `rev` and `version`; events are published after commit. `POST` is idempotent; `PATCH` needs `expectedVersion`.
7. **Time:** store `timestamptz` in UTC, display Asia/Bangkok, group reports by `business_date`.
8. **Language:** Thai-first. All user-facing text goes through `packages/i18n` (th, en). Buddhist Era dates in Thai.
9. **Sensitive actions** (PromptPay ID, voids or refunds after confirmation, staff and devices, exports) need step-up auth and write `audit_log`.
10. **No secrets or real customer data** in git, logs, notifications or tests.
11. **Private keys:** never open, print, paste or commit them (including `~/.ssh/ssh-key-2026-09-28.key`). Commands that use a key are read-only unless the owner approves.

**Dependency rules:** apps import packages and never another app. `shared`, `promptpay` and `finance` have no I/O.
Only `db` imports the ORM. Only `packages/line` and `apps/api` LINE code talk to LINE. No business rules in React components.

## 4. Things Claude gets automatically that you must do by hand

**a. File protection (Claude's `protect-files` hook).** Never edit:
- `.env` or `.env.*` files (only `.env.example`). The owner edits secrets.
- An existing, non-empty migration in `packages/db/migrations/`, or anything in its `meta/` folder.
  New migrations come from `pnpm --filter @sds/db db:generate` and take the next free number.

**b. Format and typecheck after edits (Claude's `format-typecheck` hook).** After you change a file:
- `pnpm exec biome check --write <file>` for `.ts/.tsx/.js/.mjs/.json/.css` files;
- for `.ts/.tsx`, run `pnpm run typecheck` inside the package that holds the file, and fix the errors before you go on.

**c. Role agents.** Claude hands work to specialist agents. You can't, so before working in an area,
read its playbook in `.claude/agents/` and follow it:

| Area | Playbook |
|---|---|
| `apps/api`, `packages/db`, `packages/shared`, jobs, realtime | `backend-engineer.md` |
| `apps/pos-web` (staff app) | `pos-frontend-engineer.md` |
| `packages/line`, LINE webhook, `apps/liff-web` | `line-integration-engineer.md` |
| `packages/promptpay`, `packages/finance`, payment/cash/co-pay/tax rules | `payments-finance-engineer.md` |
| `packages/ui`, `packages/i18n`, `design/`, UX copy | `ux-ui-designer.md` |
| `infra/`, `.github/workflows/`, VM, backups, monitoring | `devops-engineer.md` |
| Review before merge and at phase end | `qa-security-reviewer.md` (checklist; review only) |

**d. Role memory.** Read `.claude/agent-memory/<role>/MEMORY.md` and the files it links for the area you work in.
When you learn something a future session needs (a tool trap, an environment fact), add a short file
there in the same format and link it from `MEMORY.md`. No secrets.

**e. Checkpoint (Claude's `/checkpoint` skill).** When the owner says "checkpoint" (or "save progress"),
follow every step of `.claude/skills/checkpoint/SKILL.md` yourself:
a new entry at the top of `docs/PROGRESS.md` (≤ 15 lines, fixed format), the phase checkpoint's exit criteria,
as-built notes and log, `docs/decisions.md` if a decision changed, and `ARCHITECTURE.md` if code moved.
Start the entry's **Summary** with `(Gemini)` so the next session knows who did the work.
Record facts only: never write that a test passed unless you ran it in this session.

## 5. How to work
- **Plan briefly** with steps you can verify. Keep diffs surgical: change only what the task needs.
- **Ask the owner** when a requirement is unclear, especially about money, payments, tax or permissions.
  Never guess a business rule; look for it in `docs/` and `docs/decisions.md` first.
- **Tests first** for anything touching money, payments or tax (Vitest). E2E uses Playwright at iPad (1180×820) and iPhone (390×844) viewports.
- TypeScript strict, Zod at every boundary, no `any` in domain code.
- Staff-app features use the platform interface in `apps/pos-web/src/platform/`, never browser APIs directly.
- Local development uses the **test LINE OA** only. Real customers must never receive test messages.
- Adding a dependency: afterwards run `git diff pnpm-workspace.yaml`. If pnpm added `minimumReleaseAgeExclude`
  entries, revert them and `pnpm-lock.yaml`, and pin an older release (see backend-engineer memory).
- **A plan from Claude** (`docs/plans/<task>.md`): do exactly that plan. If it is wrong or unclear, stop and write
  your question at the bottom of the file. When done, add a `## Result` section: files changed, commands run and their results, anything skipped.

## 6. Verify, then stop
Before saying a task is done, run and report the real results:
```
pnpm lint      # Biome; CI gates on it, and a lint error skips the deploy
pnpm build     # typecheck all packages
pnpm test      # or: pnpm --filter @sds/<package> test
```
Other commands are listed in `CLAUDE.md` under **Commands**.

**At the end of every task** (owner rule 2026-10-16): ask the owner
**"Save a checkpoint, or go to the next step?"** and wait for the answer.

## 7. Git and deployment
- **Commit only when the owner asks.** Conventional Commits (`feat(api): …`, `fix(pos-web): …`), one logical change each.
- **Never push to `main` without the owner's OK. `main` auto-deploys to the live shop.** Before any push: lint, build and tests pass;
  new environment variables go into the VM `.env` first (the owner does this); afterwards check that `/healthz` shows the new sha.
- Never rewrite published history. Work on a branch unless the owner says otherwise.
- The owner works on Windows with Git Bash. Shell scripts that go to the VM over ssh must be run from Git Bash, not PowerShell.

## 8. Glossary
หน้าร้าน storefront · พร้อมเพย์ PromptPay · สลิป transfer slip · โอนแล้ว the customer's "I've paid" claim ·
เงินทอน change · หมด sold out · ไทยช่วยไทย พลัส government 60/40 co-pay · ถุงเงิน merchant app (makes the co-pay QR) ·
เป๋าตัง citizen payment app · ส่งถึงห้อง delivery to a condo room · นิติบุคคลอาคารชุด condo management.
