---
name: local-only-skills
description: Most .claude/skills folders are gitignored and live only in this working copy; a fresh clone has just the checkpoint skill, and browser/computer-use skills need the Claude Code host to provide their MCP tools
metadata:
  type: reference
---

The repo tracks only `.claude/skills/checkpoint/SKILL.md`. `.gitignore` has `.claude/skills/*` with
`!.claude/skills/checkpoint/`, so the other 62 skill folders (chrome-browser, built-in-browser,
computer-use, xlsx, pdf, tdd, wizard, …), `skills-lock.json`, `.claude/settings.local.json` and
`.claude/worktrees/` are **local-only**. They survived the move to the Mac mini because the whole
folder came over on the SSD; `git clone` on any other machine yields one skill.

- **Portable by file:** the skill text and the `node`-based hooks in `.claude/settings.json`
  (`$CLAUDE_PROJECT_DIR`, `pnpm`); the playbooks in `.claude/agents/` and the notes in
  `.claude/agent-memory/` are committed markdown.
- **Needs the host, not just the file:** `chrome-browser` (`mcp__claude-in-chrome__*`, the Claude in
  Chrome extension), `built-in-browser` (`mcp__Claude_Browser__*`), `computer-use`
  (computer-use / remote-devices MCP), `qwen-agent` (a `qwen` CLI and key), and the office-style
  skills that run their own Python scripts.
- **DSH (the DeepSeek Harness) does not load `.claude/skills` at all.** Its skills come from the
  profile in `~/.dsh`; for this repo a DSH agent follows `AGENTS.md`, which says to run the
  checkpoint procedure by hand.
- Machine-local config that does **not** travel: `~/.claude/skills` (11 skills here),
  `~/.dsh/profiles/desktop/cordis.patch.yml` (e.g. the `chrome-devtools` MCP row), and `~/.ssh`.

**Why:** the owner asked whether the project skills still work after moving machines; the honest
answer is "the text does, 62 of 63 folders are not in git, and browser-driven skills need their host
configured again".
**How to apply:** before promising a skill on a new machine, check `git ls-files .claude/skills` and
which MCP servers the skill names; never assume `~/.claude` or `~/.dsh` state travelled.
