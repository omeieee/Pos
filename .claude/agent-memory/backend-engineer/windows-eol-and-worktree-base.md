---
name: windows-eol-and-worktree-base
description: Two Windows/worktree gotchas for this repo - python file writes create CRLF (repo is eol=lf), and an agent worktree can start behind main
metadata:
  type: feedback
---

Editing files with Python on Windows writes CRLF by default, but the repo is `* text=auto eol=lf` and Biome flags it. Open with `newline=''` on read and `newline='\n'` on write (or run `sed -i 's/\r$//'`). Check with `git ls-files --eol <file>`.

**Why:** hit on 2026-10-02 while editing packages/db/src/sync.ts; git warned "CRLF will be replaced by LF".
**How to apply:** any scripted multi-file edit; prefer the Edit tool for single changes.

An agent worktree may start a few commits behind the `main` HEAD named in the task (docs-only commits). `git merge-base --is-ancestor <sha> HEAD` first, then `git merge --ff-only <sha>` (allowed, no cd out of the worktree). A command that `cd`s to a computed path (e.g. `cd ../..`) before git is refused in a worktree; use separate calls or `pnpm --filter`.
