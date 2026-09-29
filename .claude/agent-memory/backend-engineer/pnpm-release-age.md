---
name: pnpm-release-age
description: pnpm 12 minimumReleaseAge in this repo silently appends minimumReleaseAgeExclude entries to pnpm-workspace.yaml when `pnpm add` picks a too-fresh release
metadata:
  type: feedback
---

When `pnpm add` resolves a package published within the release-age window (about 1 day), pnpm 12 here quietly adds `minimumReleaseAgeExclude` entries to pnpm-workspace.yaml instead of failing. Always `git diff pnpm-workspace.yaml` after adding deps. If entries appeared, revert the yaml AND `git checkout pnpm-lock.yaml` (the lockfile keeps the fresh versions and later fails verification), pin the previous release in package.json, then `pnpm install`.

**Why:** hit on 2026-09-29 with @sentry/node 11.1.0 (P2). The exclude list is a supply-chain policy the owner set; widening it silently defeats it.
**How to apply:** any dependency add in this repo; prefer the last release older than a day (and avoid brand-new majors).
