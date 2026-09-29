---
name: reference-local-lint-tools
description: How to lint/validate infra on the owner's Windows box - no shellcheck/actionlint/yamllint/docker installed; download binaries to the session scratchpad
metadata:
  type: reference
---

The owner's Windows machine has Git Bash, python3 (msys, no PyYAML) and Node, but **no Docker, shellcheck, actionlint or yamllint** (checked 2026-09-29).

Working recipe (scratchpad only, never into the repo). Git Bash `tar` cannot unzip: use PowerShell `Expand-Archive`.
- shellcheck: `https://github.com/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.zip` → `shellcheck.exe -x -P infra/backup ...`
- actionlint: latest `actionlint_<v>_windows_amd64.zip` from rhysd/actionlint releases → `actionlint.exe -shellcheck <path>/shellcheck.exe .github/workflows/*.yml`
- Caddy: `caddy_<v>_windows_amd64.zip` → `caddy adapt --config Caddyfile` (set API_HOST/ACME_EMAIL env) and `caddy run` locally against a node upstream to test headers; use `cygpath -m` for Windows paths in Caddyfile `root`.
- docker compose CLI without a daemon: `docker-compose-windows-x86_64.exe` from docker/compose releases; `config` works (validates `extends`/`profiles`/`tmpfs`), `run`/`--dry-run` need a daemon.
- Chrome DevTools MCP works for CSP checks (serve `vite build --outDir <scratch>` with local caddy + the `_headers` values).
- PyYAML: `python3 -m pip install --target <scratch>/py pyyaml`, then `PYTHONPATH=<scratch>/py`.
- Script logic: stub `docker`/`gh`/`curl`/`rclone` in a temp PATH dir to exercise deploy.sh / plan-job shell. NTFS can't hold chmod 600, so also stub `stat -c %a .env` (deploy.sh check_env). No stub harness lives in the repo.
- Action SHAs: `curl -H 'Accept: application/vnd.github.sha' https://api.github.com/repos/<o>/<r>/commits/<tag>`, cross-check with `git ls-remote --tags` for the exact release tag.

Root `.gitattributes` has `* text=auto eol=lf`, so shell scripts check out LF even with core.autocrlf=true. Owner must pipe scripts to ssh from **Git Bash**, not PowerShell 5.1.

The Bash tool's auto-mode classifier sometimes returns "no verdict" (transient); retry once, and do file edits with Edit/Write meanwhile.
