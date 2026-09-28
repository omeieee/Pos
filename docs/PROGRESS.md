# Progress Log

**Current phase:** P0 — Planning ([checkpoint](checkpoints/PHASE-00-planning.md)), status **ready for P1**. The owner will say when to start coding.
**Next phase:** P1 — Foundation ([checkpoint](checkpoints/PHASE-01-foundation.md)).

> **Handoff for the next session (read first):**
> - **No code exists yet.** The owner asked not to code until they say so in a new session.
> - **P1 inputs are settled.** Answers are in [10-open-questions.md](10-open-questions.md); the stack is Accepted in [decisions.md](decisions.md).
> - **P1 prerequisites confirmed (2026-09-29):** Claude may commit and push to `main`. Supabase project `yejvrooxqdpynruwnegg` (Singapore); its MCP still needs re-auth (restart Claude Code → `/mcp`), which doesn't block P1.
> - **Local tools:** Node 24 + pnpm 12.6.0 (shims in `%APPDATA%
pm`). No Docker, so use **PGlite** for local DB/tests.
> - **Still open, not blocking P1:** Q3 (tax status; ภ.ง.ด.94 due 30 Sep 2026), Q11, Q12 (costs: owner provides later), reserved IP, and whether ไทยช่วยไทย can be paid on room delivery.
> - **LINE OA:** already exists, but has no Messaging API/bot and no ordering UI yet (P4).
> - **Standing rule:** before starting each phase, ask the owner for all missing information that phase needs (see `CLAUDE.md` workflow).

Newest entries first. Add entries with `/checkpoint`. Each entry covers what changed, how it was verified, what was decided, and what comes next. State facts only, and never record tests as passed unless they were run.

---

## 2026-09-29 · P0 · P1 prerequisites confirmed
- **Summary:** connections checked and the P1 kickoff answers recorded.
  - Supabase: the old ref didn't exist, so it was replaced by `yejvrooxqdpynruwnegg`, region **Singapore** (`ap-southeast-1`). The MCP sign-in is still refused on reconnect.
  - pnpm 12.6.0 installed. Claude may commit and push to `main`. Hooks are allowed in the shared `.claude/settings.json`.
  - PromptPay scan test: **1 bank app** for now.
  - Wireframes are delivered in **both** `design/` HTML and Figma.
  - **New A4 sub-requirement:** per-device (iPad / iPhone / laptop) mockups and independently adjustable customization.
- **Changed:** `.mcp.json`; 01 (N-row, A4), 04 §2.4, 09 P1 row, P1 checkpoint scope + exit criteria, 10 (answers).
- **Verification:** `git ls-remote origin` OK (repo empty); VM :22 open, :80/:443 closed; project REST → 401 (up, key required); DB IPv6 matched AWS ranges → ap-southeast-1; `pnpm -v` → 12.6.0; Supabase MCP → "needs authentication".
- **Decisions:** none (requirements only).
- **Open issues:** Supabase MCP re-auth (needed by P2); which bank app to test with (owner's choice).
- **Next:** push, then P1 kickoff: monorepo scaffold.
- **Commit:** a0c2fc2, d42097b, plus the docs commit that adds this entry

## 2026-09-29 · P0 · Owner answers recorded; ready for P1
- **Summary:** the owner answered the P1-blocking questions:
  - **Payment:** the customer sends the slip via LINE (or shows it) and the owner confirms by hand.
  - **LINE fulfilment:** pickup + condo-room delivery, with returning customers remembered. LINE payment methods: PromptPay, ไทยช่วยไทย (pickup only until the terms confirm delivery), cash.
  - **Stack:** accepted. **Repo:** private.
  - **Menu:** placeholders, fully editable.
  - **Branding:** designer proposes; must stay customizable.
  - **Staff and hours:** the owner is the only staff member; storefront 11:00–23:00, delivery 13:00–23:00, adjustable per day.
  - **Test banks:** K PLUS + Krungthai NEXT (PromptPay 0642230924 is a personal test account; the real shop account comes later).
- **Changed:**
  - `10-open-questions.md` (answers + branding + banks);
  - `01-requirements.md`: new A3 opening hours, A4 customizable look, L2a returning customers; assumptions A1/A3/A5/A6;
  - `decisions.md`: D-01/02/03/05 Accepted, D-03 adds PGlite for local dev, D-08 pickup-only note;
  - P1 exit criterion and roadmap row now use 2 bank apps.
- **Verification:** docs only; no code written.
- **Next:** in a new session, the owner says go → P1 kickoff (confirm commit permission first).
- **Commit:** uncommitted

## 2026-09-29 · P0 · VM network details recorded
- **Summary:** from the owner's screenshots:
  - public IP 138.2.67.89 is **ephemeral** (`publicip20260928193828`);
  - private IP 10.0.0.43, subnet `subnet-20260929-0215`, no network security groups (the subnet security list controls ingress).
- **Changed:** `infra/oracle/README.md`; 05 §6 checklist (reserved-IP decision before P4).
- **Commit:** uncommitted

## 2026-09-29 · P0 · Ingress decided: Caddy on a free hostname (no domain for now)
- **Decision:** D-10 Accepted (interim).
  - The API is served by Caddy + Let's Encrypt on a free sslip.io hostname, with only ports 80/443 open on the VM.
  - Web apps on Cloudflare Pages (`*.pages.dev`).
  - A named Tunnel + domain remains the target later.
- **Changed:** decisions D-10, requirements N4, architecture note, 05 §5–6, devops agent, P2 checkpoint, roadmap P2 row.
- **Open issues:** check whether the VM's public IP is ephemeral or reserved, because the hostname contains it.
- **Commit:** uncommitted

## 2026-09-29 · P0 · Cloudflare account noted; no-domain options
- **Summary:** the owner has a Cloudflare account with the workers.dev subdomain `omeza25482548` (existing Worker `claude-writer`, unrelated to the POS). The no-domain hosting options are written up in 05 §5 (pages.dev for the web apps; Workers VPC (beta) or Caddy on a free hostname for the API).
- **Open issues:** owner to choose between buying a domain (recommended) and a no-domain option. Workers VPC WebSocket support is unverified.
- **Commit:** uncommitted

## 2026-09-29 · P0 · Supabase MCP server added
- **Summary:** the owner created a Supabase project (ref `msxzudufpewhdramjihv`) for Path B, and the Supabase MCP server was added at project scope (`.mcp.json`) with features docs, account, database, debugging, development, functions and branching. It is **not read-only**.
- **Verification:** `claude mcp add` reported success and `.mcp.json` contains the entry. Authentication (OAuth) happens on first use and has not been done yet.
- **Open issues:** confirm the Supabase project's region (Singapore recommended, next to the VM). Database-changing MCP actions need owner approval, especially once real data exists.
- **Commit:** uncommitted

## 2026-09-29 · P0 · SSH key moved out of the repo
- **Summary:** moved `ssh-key-2026-09-28.key` and `.key.pub` from the repo root to `%USERPROFILE%\.ssh\`.
- **Verification:**
  - the private key was copied, its SHA-256 hash matched the original, the copy was set to owner read-only, and then the original was deleted (it was read-only, so a direct move was refused);
  - `ssh-keygen -l` reads it (RSA 2048);
  - the repo no longer contains either file.
- **Changed:** key path updated in `CLAUDE.md`, `infra/oracle/README.md`, 05 §6 and the devops agent.
- **Next:** owner answers Q2–Q12 → start P1.
- **Commit:** uncommitted

## 2026-09-29 · P0 · VM details recorded; native apps deferred
- **Summary:** the owner shared the OCI console details. The VM is **VM.Standard.E2.1.Micro** (1 GB RAM), **ap-singapore-1**, Ubuntu 24.04, user `ubuntu`, IP 138.2.67.89, on a **Free Tier** account (not PAYG). Native apps are deferred until the owner buys a MacBook.
- **Changed:**
  - new `infra/oracle/README.md` (VM record, no secrets);
  - Q1 and Q13 answered;
  - D-03 and D-10 → Path B (Supabase free in Singapore for Postgres; the VM runs the stateless api/backup/cloudflared);
  - D-19 marked deferred;
  - A4 confirmed; 05 §6 status and checklist; R1 updated for Free Tier.
- **Verification:** docs only; facts taken from the owner's screenshots. No SSH connection was made.
- **Decisions:** D-03 and D-10 moved from Open to Proposed (Path B). D-19 deferred.
- **Open issues:** Free Tier idle-reclamation risk (PAYG still recommended, owner's call); Q2–Q12 still open.
- **Next:** owner answers Q2–Q12 → start P1.
- **Commit:** uncommitted

## 2026-09-29 · P0 · VM exists, browser targets, native-apps plan
- **Summary:** the owner reported that the Oracle VM is set up, with its SSH key pair in the repo folder. Staff will use Safari on iPad/iPhone and standard browsers on computers. Native installable apps (iPad, iPhone, Windows, macOS, Linux) are wanted later.
- **Changed:**
  - added `.gitignore` for keys and `.env*`;
  - added D-19 (web-first → Capacitor for iOS / Electron for desktop), with status notes on D-03, D-10 and D-15;
  - added requirement X4 and NFR N11;
  - architecture §12 (Safari specifics, seams built now, native shells);
  - infrastructure: key handling in §6 and native distribution in §12;
  - L13–L14, R14–R15; skills rows; roadmap P10;
  - new `checkpoints/PHASE-10-native-apps.md`; Q1 updated, Q13 added;
  - `CLAUDE.md` rule 11 (private keys) and client targets;
  - agents: devops key rule, pos-frontend Safari/platform rules, qa-security-reviewer made truly read-only (removed `memory`).
- **Verification:**
  - `git check-ignore` shows both key files ignored; `git status` lists only `.claude/`, `.gitignore`, `CLAUDE.md` and `docs/`. The key contents were not opened or printed.
  - Link and anchor check: 32 markdown files, no problems.
  - Frontmatter check (PyYAML): 7 agents + 1 skill parse, 0 problems.
- **Decisions:** D-19 added as Proposed (depends on Q13). D-03 and D-10 stay Open until the VM's shape is known.
- **Open issues:** VM public IP and login user needed for read-only inspection (Q1). Recommend moving the key to `~/.ssh/` (owner's call).
- **Next:** owner answers Q1–Q13 → close Path A/B → start P1.
- **Commit:** uncommitted

## 2026-09-29 · P0 · Planning pack created
- **Summary:** researched constraints (LINE, PromptPay, ไทยช่วยไทย พลัส, Oracle and other free tiers, Thai tax, PDPA) and wrote the planning docs. No application code yet.
- **Files added:**
  - `CLAUDE.md`
  - `docs/01`–`10`, `docs/decisions.md`, `docs/PROGRESS.md`
  - `docs/checkpoints/PHASE-00`–`09`
  - `.claude/agents/` (7 agents), `.claude/skills/checkpoint/`
- **Key findings:**
  - The ไทยช่วยไทย QR is made per transaction and scanned at the storefront → LINE customers pay at the storefront (CR1).
  - The scheme's additional round runs 1 Oct – 30 Nov 2026, so the method is generic and configurable.
  - LINE's free plan counts 300 push messages a month; replies are free → reply-first design.
  - LINE Notify has ended.
  - Grab / LINE MAN have no API for small merchants.
  - Oracle A1 Always Free is now 2 OCPU / 12 GB and idle VMs can be reclaimed → upgrade to PAYG.
- **Verification:** docs only. Sources are linked in 04, 05 and 06.
- **Decisions:** D-01…D-18 recorded. D-07 is Accepted; D-03 and D-10 are Open (Q1); the rest are Proposed.
- **Next:** the owner answers Q1–Q12 → update decisions → start P1.
