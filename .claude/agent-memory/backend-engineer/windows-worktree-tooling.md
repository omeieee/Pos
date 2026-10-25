---
name: windows-worktree-tooling
description: Tooling quirks when editing in this Windows worktree (CRLF from Python, refused compound bash, vitest worker crashes, embedded-postgres encoding)
metadata:
  type: feedback
---

- Edit files with the Edit tool. A Python `open().write()` on Windows rewrites LF files as CRLF and biome then fails the format check (`sed -i 's/\r$//'` fixes it). Compound bash with heredocs plus git words is sometimes refused by the worktree guard: split into plain commands.
- Run vitest with `--no-file-parallelism` in packages/db and apps/api: parallel PGlite workers crash with exit code 2147483651 on this laptop.
- Real-Postgres scratch checks: `embedded-postgres` in the session scratchpad needs `initdbFlags: ['--encoding=UTF8','--locale=C']` (default WIN874 breaks migration 0000), `"type":"module"` in its package.json, and can import repo `.ts` by file URL (Node 24 strips types). Result 2026-10-03: payment order-row lock held under 25 rounds of 10-way races (no double open or confirm, no deadlock).

**Why:** each cost a failed run in the 2026-10-03 P3 QA backend slice.
**How to apply:** any edit/test/scratch-DB work in this repo on Windows.
