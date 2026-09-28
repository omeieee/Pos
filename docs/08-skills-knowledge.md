# 08 · Knowledge Needed to Build and Run This System

Each row lists what to learn, the phase where it first matters, and where to learn it. Claude Code agents can do much of the work, but the owner needs enough of each area to **review, operate and fix** the system at 2 a.m.

## 1. Build knowledge
| Area | What you need to know | Phase | Learn from |
|---|---|---|---|
| TypeScript & Node.js | Strict typing, async/await, modules, npm/pnpm workspaces | P1 | typescriptlang.org/docs · nodejs.org/docs |
| Fastify | Routes, schemas (Zod type provider), plugins, hooks, error handling, WebSocket plugin | P1–P3 | fastify.dev/docs |
| PostgreSQL | Schema design, indexes, transactions and isolation, sequences, `timestamptz` and time zones, `date_trunc`/window functions for reports, `pg_dump`/restore | P1–P2 | postgresql.org/docs |
| Drizzle ORM | Schema, migrations with drizzle-kit, typed queries, raw SQL when needed | P1 | orm.drizzle.team |
| React + Vite | Components, hooks, TanStack Query (server state) and Router, forms, performance on low-end tablets | P3 | react.dev · tanstack.com |
| PWA & offline | Service workers (Workbox), install to the Home Screen, IndexedDB (Dexie), iOS Safari limits | P3 | web.dev/learn/pwa |
| Realtime | WebSocket lifecycle, heartbeats, reconnects, idempotency, optimistic concurrency | P3 | architecture doc §5 |
| UI/UX for POS | Touch targets, speed-first flows, kitchen readability, Thai typography, responsive iPad/iPhone/laptop layouts, accessibility | P1, P3 | design/ · WCAG 2.2 quickref |
| LINE platform | Providers and channels, Messaging API (webhooks, signatures, reply vs push, Flex Message, rich menus, quota), LIFF / MINI App (ID tokens, scopes, `sendMessages`) | P4 | developers.line.biz |
| PromptPay / Thai QR | EMVCo merchant-presented QR, TLV encoding, CRC16, PromptPay ID types | P1 | EMVCo QR spec · BOT Thai QR Payment standard · `promptpay-qr` source |
| Gov co-pay operations | The ถุงเงิน merchant flow, settlement timing, scheme terms | P3 | ไทยช่วยไทย official site, the ถุงเงิน app |
| Charts & reporting | Choosing chart types, time-series aggregation, menu engineering (popularity × margin) | P6 | ECharts docs · dataviz skill |
| Cost accounting basics | Cost of goods, gross margin, food-cost %, P&L, platform commissions | P7 | Accountant; the finance package docs |
| Thai tax basics | 40(8) income, 60% flat vs actual expenses, allowances, ภ.ง.ด.90/94, VAT threshold, e-Payment reporting | P7 | rd.go.th · accountant |
| Testing | Vitest unit/property tests, DB integration tests, Playwright E2E with iPad/iPhone viewports, real-device checks inside LINE | P1+ | vitest.dev · playwright.dev |
| ESC/POS printing (P8) | Raster commands, network printers (TCP 9100), rendering Thai tickets, printer maintenance | P8 | Printer manual · ESC/POS reference |
| Safari / WebKit specifics | Home Screen web apps vs tabs, Web Push on iOS, storage policy, audio and wake-lock rules, remote debugging an iPad from a Mac | P3 | webkit.org/blog · Apple "Safari web apps" docs |
| Native iOS shell (P10) | Capacitor (config, plugins, native project), Xcode basics, Apple signing certificates and profiles, TestFlight / App Store Connect, APNs keys | P10 | capacitorjs.com/docs · developer.apple.com |
| Native desktop shell (P10) | Electron main/renderer/preload, IPC and security (context isolation), electron-builder, auto-update, Windows Store/MSIX, macOS notarization, Linux packages | P10 | electronjs.org/docs · electron.build |

## 2. Knowledge for running it 24/7
| Area | What you need to know | Phase |
|---|---|---|
| Linux admin | SSH keys, users/permissions, `systemd`, disk/memory checks, `unattended-upgrades` | P2 |
| Docker & Compose | Images (ARM64 on Oracle A1), volumes, networks, health checks, restart policies, log rotation | P2 |
| Oracle Cloud | Always Free limits, PAYG upgrade, security lists, idle-reclamation rules, block and object storage | P2 |
| Cloudflare | DNS, Tunnel, Pages, R2 (lifecycle rules), Access (optional) | P2 |
| CI/CD | GitHub Actions, secrets, deploy over SSH/Tailscale, migrations during deploy, rollback | P2 |
| Security | OWASP Top 10 basics, auth (PIN, sessions, TOTP), webhook signatures, rate limits, secrets hygiene, least privilege | P2–P5 |
| Backups & DR | Encrypted dumps, retention, **restore drills**, rebuilding on another host | P2 |
| Monitoring | Uptime checks, error tracking, alert routing, reading logs, quota monitoring | P2 |
| Incident handling | Runbooks, calm triage, writing short post-mortems in PROGRESS.md | P5 |
| Privacy (PDPA) | Notices, lawful basis, rights requests, retention, breach response | P4–P5 |

## 3. Working with Claude Code on this repo
- **`CLAUDE.md`** is read at the start of every session. It holds the system map, rules and workflow.
- **Subagents** in `.claude/agents/` split the work by component: backend, staff app, LINE, payments/finance, UX/UI, DevOps, QA/security. Ask for one by name, e.g. "use the line-integration-engineer to …". Several can run in parallel on separate git worktrees.
- **Skills:** `/checkpoint` logs progress and the as-built architecture after each task. Built-in skills that help here:
  - `design:*`: critique, accessibility, UX copy;
  - `engineering:*`: code review, testing strategy, deploy checklist;
  - `dataviz`: charts.
- **Plan mode** is useful at the start of each phase: agree the task list, then build.
- **Hooks** (to add in P1): run Biome and typecheck after edits; block edits to applied migrations; block committing `.env*`.
- **Figma MCP** (optional) lets the ux-ui-designer agent turn screens into Figma frames for review.
