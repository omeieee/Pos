# 07 · Limitations, Risks and Mitigations

L = likelihood, I = impact (H/M/L). The phase column says where the mitigation is built.

## 1. System limitations (known up front)
| # | Limitation | Why | Recommended solution | Phase |
|---|---|---|---|---|
| L1 | Payments can't be checked automatically | Free personal PromptPay has no API or webhook. Bank merchant APIs and slip-check services charge fees | Manual confirmation from the bank-app notification (D-07). Big amount shown on screen. Optional random-satang amounts to tell orders apart. Optional duplicate-slip detection | P3, P4, P9 |
| L2 | Fake transfer slips | Fake-slip apps are common | SOP: **never confirm from a slip alone**; check the bank app. A slip only makes the payment `claimed` | P3 |
| L3 | A LINE customer can't scan a QR on their own phone | Same screen | Send the QR as an image (save → scan from gallery), plus the PromptPay ID and amount as text | P4 |
| L4 | Gov co-pay can't be automated or paid remotely | The QR is made in ถุงเงิน per transaction, scanned at the storefront with GPS | Guided manual flow at the counter. LINE customers "pay at storefront". Scheme dates/hours are config, off by default | P3, P4 |
| L5 | 300 counted LINE messages a month on the free plan | LINE pricing | Reply first, `sendMessages` trick, live status page, quota tracker and policy switch. Upgrade when volume justifies it | P4 |
| L6 | No LINE Notify | Service ended 31 Mar 2025 | In-app alerts now, self-hosted ntfy in P8 | P3, P8 |
| L7 | No Grab / LINE MAN API | Partner-only access | Manual quick entry with commission tracking. Aggregator later if worth it | P3 |
| L8 | iPad/iPhone browsers can't reach USB, Bluetooth or raw-TCP printers | Web platform limits | Print agent on the Mini PC (P8) | P8 |
| L9 | Thai text garbles on ESC/POS in text mode | Printer code pages | Raster (image) printing | P8 |
| L10 | iOS web-app quirks: sound needs a tap, the screen sleeps, storage can be cleared if unused | Safari rules | Unlock audio at login; Wake Lock + Auto-Lock Never; install to the Home Screen; the server holds the data | P3 |
| L11 | Tax rules and schemes change every year | Policy changes | Rules stored as data per tax year and per scheme; estimates carry a disclaimer; yearly review task | P6, P7 |
| L12 | Free tiers change without notice | Provider policy | Quarterly review (05 §10); portable Compose stack; providers kept behind adapters | Ongoing |
| L13 | Safari **tab** mode: no Web Push; stored data deleted after 7 days without use; background tabs suspended | WebKit policy (Home Screen web apps are exempt from the 7-day rule) | Add to Home Screen on staff devices; quick device re-pairing; catch-up sync on resume (02 §12.1) | P3 |
| L14 | Native iPad/iPhone and Mac apps cost money and need a Mac | Apple Developer Program US$99/yr for any distribution; Xcode only runs on macOS | Stay web-first; desktop app (Windows/Linux, ฿0) first; iOS once the owner accepts the fee and has Mac access (Q13) | P10 |

## 2. Risk register
| # | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Oracle reclaims an "idle" VM (Free Tier account; Micro is idle if CPU p95 < 20% and network < 20% for 7 days) | M | M | **Upgrade to PAYG** (budget alert US$1; owner staying on Free Tier for now). Path B keeps the VM stateless (DB on Supabase, backups in R2) → rebuild from scripts; uptime monitoring | Owner, P2 |
| R2 | Oracle account suspended, or region out of capacity | L–M | H | Off-site encrypted backups (R2); rebuild scripts; tested restore to the Mini PC or a VPS in ≤ 2 h | P2 |
| R3 | Shop internet (AIS) outage at peak | M | M | Storefront offline outbox; phone hotspot; LINE orders unaffected in the cloud | P3 |
| R4 | Someone changes the PromptPay ID to theirs | L | H | Owner-only with step-up, audit, instant alert; staff SOP to check the recipient name | P3 |
| R5 | Staff confirm a payment that never arrived | M | M | SOP + two-step confirm showing the amount; audit trail per staff member; end-of-day reconciliation vs bank statement | P3, P6 |
| R6 | Customer no-show on an unpaid pay-at-pickup order | M | L–M | Per-method rule for whether the kitchen may start an unpaid order; overdue reminders; limit of 3 open unpaid orders per customer | P4 |
| R7 | Breaking gov-scheme rules → suspension or clawback | L | H | QR never sent over LINE; storefront-only method; hours enforced; staff training | P3, P5 |
| R8 | PDPA complaint or breach | L | M | Notice + consent, minimal data, retention jobs, access control, breach runbook | P4, P5 |
| R9 | Data loss from a bad migration | L | H | Forward-only, expand/contract migrations; backup before every deploy; restore drills | P2+ |
| R10 | LINE webhook down during an outage → missed orders | L | M | Webhook redelivery on; idempotent processing; uptime alert | P4 |
| R11 | Solo maintainer (bus factor 1) | H | M | CLAUDE.md, decision log, checkpoints, runbook; everything reproducible from the repo | Ongoing |
| R12 | Scope creep delays go-live | M | M | MVP line in the roadmap (P1–P5); analytics and tax after go-live (the data is captured from day one) | Owner |
| R13 | Dependency or security vulnerabilities | M | M | Renovate/Dependabot; `pnpm audit` in CI; monthly updates | Ongoing |
| R14 | The Oracle SSH private key gets committed or pasted somewhere | M | H | `.gitignore` covers `*.key`, `*.key.pub`, `.env*` (done 2026-09-29); move the key to `~/.ssh`; a hook blocks committing keys (P1); CI uses its own deploy key. **If it ever leaks: replace the key on the VM immediately** | Owner, P1 |
| R15 | Apple rejects a public App Store build as "just a website" | M | M | Use TestFlight internal or Unlisted distribution for the shop's own devices; give the native app real native features (push, printing) | P10 |
