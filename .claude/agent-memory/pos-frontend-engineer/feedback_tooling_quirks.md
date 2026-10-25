---
name: tooling-quirks
description: Shell and tooling quirks hit while editing apps/pos-web on this Windows setup
metadata:
  type: feedback
---

Large `python3 - <<'EOF'` heredocs through the Bash tool can fail with "unexpected EOF while looking for matching `'`" and apply nothing. Write the script to the scratchpad with the Write tool and run it, or use Edit.

**Why:** hit three times in the D-23 work; the failed command changes nothing, so check `git diff` before assuming an edit landed.

**How to apply:** for multi-edit changes put the Python in a scratchpad file. The PostToolUse hook typechecks pos-web after every edit and prints stale errors until the whole change is consistent: expect noise mid-change.

Biome: the working copies are LF here and plain `pnpm exec biome check <paths>` passes; the brief's `--line-ending=crlf` was not needed. Never run `biome --write` on a directory that holds owner-modified files without checking `git diff --stat` after.

Playwright: the mock server lives in the page, so any full navigation resets it. Test flows that span a navigation (invite link) via the dev-only `demoInvite` seed (`/invite#mock-invite-demo`). Radio chips and role cards have a hidden input: click the label, not `.check()`.

2026-10-22 (phone alerts): a `cat > file <<'EOF'` with apostrophes in the body also failed with the same EOF error; use the Write tool for new files. Python heredocs for small `str.replace` edits worked. The format hook rewrites `function` declarations into arrows and fixes import order only on some files: run `npx biome check --write <my files>` before the final `biome check`.
