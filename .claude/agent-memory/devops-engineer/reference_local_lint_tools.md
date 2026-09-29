---
name: reference-local-lint-tools
description: How to lint infra on the owner's Windows box - no shellcheck/actionlint/yamllint/docker installed; download binaries to the session scratchpad
metadata:
  type: reference
---

The owner's Windows machine has Git Bash, python3 (msys, no PyYAML) and Node, but **no Docker, shellcheck, actionlint or yamllint** (checked 2026-09-29).

Working recipe (scratchpad only, never into the repo):
- shellcheck: `https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.zip` → `shellcheck.exe -x -P infra/backup ...`
- actionlint: latest `actionlint_<v>_windows_amd64.zip` from rhysd/actionlint releases → `actionlint.exe -shellcheck <path>/shellcheck.exe .github/workflows/*.yml`
- PyYAML: `python3 -m pip install --target <scratch>/py pyyaml`, then `PYTHONPATH=<scratch>/py`.
- Script logic: stub `docker`/`rclone`/`pg_dump` in a temp PATH dir to exercise deploy.sh / backup.sh flows.

Root `.gitattributes` has `* text=auto eol=lf`, so shell scripts check out LF even with core.autocrlf=true. Owner must pipe scripts to ssh from **Git Bash**, not PowerShell 5.1.
