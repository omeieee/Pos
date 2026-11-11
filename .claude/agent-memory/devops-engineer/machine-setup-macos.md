---
name: machine-setup-macos
description: Since 2026-11-10 the working copy is on the owner's Mac mini (external SSD); toolchain versions, the reinstall steps, and two environment traps found while re-verifying it
metadata:
  type: project
---

The repo now lives at `/Volumes/Ome_SSD/omeie_code/project/Pos` on an Apple Silicon Mac mini
(macOS 27.2), moved from the Windows notebook. The pnpm store came along on the same SSD, so
`pnpm install --frozen-lockfile` takes seconds.

- **Toolchain:** Node 26.13 (Homebrew `node`, the default) and Node 24.22 (`node@24`, keg-only,
  matches CI's `node-version: 24`). pnpm 12.6.0 installed with `npm install -g pnpm@12.6.0`
  (Node 26 has no corepack).
- **Stale `node_modules`:** the copy lost every symlink (empty folders), and Turbo replayed Windows
  cache hits. After moving machines, move `node_modules` aside, `pnpm install --frozen-lockfile`,
  and delete `.turbo` before trusting `pnpm build`/`pnpm test`.
- **ICU 79 trap (both Node majors):** `Intl.DateTimeFormat('th-TH…', {hour,minute})` formats
  `00:30 น.`; ICU ≤78 gave `00:30`, which `packages/i18n/src/format.test.ts` expected. Owner chose
  the suffix (2026-11-10); the expectation carries a comment.
- **Wall-clock trap:** the API harness freezes its clock at `START_TIME = 2026-10-01T03:00Z`.
  A test that seeds dates from `Date.now()` drifts as real time passes: `customers-report.test.ts`
  seeded `ago(61)` and its lapsed customer read as `regular` from 2026-11-01. Seed from
  `h.clock.now()`.
- **GitHub over SSH (2026-11-10):** this Mac has its own key, `~/.ssh/id_ed25519_github`, dedicated
  so `~/.ssh/id_ed25519` stays the `win` LAN host key; it is on account `omeieee` with a `Host
  github.com` block in `~/.ssh/config` (backup `config.bak.20261110222653`), and `ssh -T
  git@github.com` answers "Hi omeieee!". github.com host keys were added after comparing
  `ssh-keyscan` with `api.github.com/meta`. The key has no passphrase: never print it. Playwright
  browsers are not installed.
