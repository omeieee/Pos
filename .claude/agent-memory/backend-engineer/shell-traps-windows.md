---
name: shell-traps-windows
description: Windows worktree shell traps that cost turns: PowerShell 5.1 corrupts UTF-8 Thai in Get/Set-Content, and the worktree guard refuses cd plus heredoc in one Bash call
metadata:
  type: feedback
---

In this repo's worktree sessions: (1) never round-trip source files through PowerShell 5.1 `Get-Content`/`Set-Content` without `-Encoding utf8`; Thai test strings get corrupted. Edit text files with python (`open(..., encoding='utf8', newline='')`) or the Edit/Write tools. (2) The worktree guard refuses a Bash call that combines `cd` with a heredoc or other "complex" git-ish chains; use the Write tool for new files and run commands as plain separate calls (PowerShell `Set-Location` + one command works).

**Why:** both cost several turns during P3 task 5 (payments).
**How to apply:** any multi-file edit or file creation in a worktree.
