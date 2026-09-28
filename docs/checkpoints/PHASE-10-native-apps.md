# Phase 10 — Native Installable Apps

**Status:** ⏸️ Deferred: future project, starts after the owner buys a MacBook (Xcode for iPad/iPhone) · **Depends on:** P5; Q13 (Apple fee, Mac access, order) · **Agents:** pos-frontend-engineer (shells and platform implementations), devops-engineer (signing, CI, distribution), ux-ui-designer, qa-security-reviewer. Add a dedicated native-apps agent at kickoff if the work is large.

## Goal
Ship the existing staff app as installable native apps, from the same React code. Desktop comes first (Windows, macOS, Linux), then iPad and iPhone. The apps add what Safari can't do: reliable alarms and push, keep-awake, secure token storage, and direct printing to the XP-80T.

## Scope
- **In:**
  - **Desktop:** `apps/pos-desktop` (Electron, D-19) wrapping the `pos-web` build, with:
    - platform implementations over IPC: sound, notifications, wake lock, token storage, print via `packages/escpos` over LAN/USB;
    - installers: MSIX/Store or `.exe`, signed and notarized `.dmg`, AppImage/`.deb`;
    - auto-update.
  - **iPad/iPhone:** `apps/pos-mobile` (Capacitor), with:
    - platform implementations as plugins: APNs push with a custom alarm sound, keep-awake, Keychain token store, LAN printing via a TCP/ESC-POS plugin;
    - TestFlight internal distribution.
  - **Backend:** native origins added to the CORS allow-list, and APNs sending added to `packages/notify`.
- **Out:**
  - Android (possible later with the same Capacitor project);
  - public App Store listing (Unlisted or public only after the owner decides);
  - native versions of the customer app (customers keep using LINE).

## Entry checks (before starting)
- [ ] Q13 answered: which platform first; Apple Developer Program accepted or not; how macOS builds will run (own Mac or cloud CI)
- [ ] D-19 re-checked: Electron vs Tauri 2 against the revisit condition; current plugin support for push and TCP printing on iOS verified
- [ ] The P3 platform interface is in place and every feature uses it (no direct browser API calls)

## Exit criteria
- [ ] Desktop app installs on Windows (and macOS/Linux if in scope), logs in as a registered device, stays in sync in real time, updates itself, and prints a Thai kitchen ticket directly to the XP-80T
- [ ] iPad/iPhone app is on TestFlight; a new order raises a push alarm with sound while the app is in the background; the counter screen stays awake; the ticket prints over LAN
- [ ] The same Playwright/E2E suite passes against the web build; a native smoke-test checklist passes on real devices
- [ ] Signing keys and certificates are stored outside git and documented in `infra/` (what, where and when they expire; not the secrets)

## As built
_Fill in with `/checkpoint`._

## Log
_Empty._
