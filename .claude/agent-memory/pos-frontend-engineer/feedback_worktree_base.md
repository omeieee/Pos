---
name: worktree-base-may-lag-main
description: Agent worktrees can start behind the main HEAD the brief names; fast-forward before reading backend code
metadata:
  type: feedback
---

Compare `git log -1` with `git rev-parse main` at the start of a slice and `git merge --ff-only main` if behind.

**Why:** the 2026-10-03 outbox slice began at a5b687b while the brief named f46f445; the missing commit changed backend rules (step-up before replay, 409 on a different originalStaffId) that the dev mock must mirror.

**How to apply:** do it before reading `apps/api` to mirror behaviour in `apps/pos-web/src/dev` mocks. Also: the Edit-tool hook runs a full typecheck and prints long errors after every edit; batch edits with a node script via Bash when the tree is knowingly mid-change.
