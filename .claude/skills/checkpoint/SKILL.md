---
name: checkpoint
description: "Record progress after finishing a task or phase in the Saap Don Sen POS. It adds an entry to docs/PROGRESS.md, updates the current phase checkpoint (exit criteria, as-built architecture, log), and updates docs/decisions.md if a decision changed. Use when a task is complete, before ending a work session, or when the user says checkpoint, log progress or save progress."
argument-hint: "[one-line summary of what was done]"
---

# Checkpoint

Summary given by the user (may be empty): $ARGUMENTS

## Steps
1. **Find the phase.** Read the header of `docs/PROGRESS.md` for the current phase, then open that phase's file in `docs/checkpoints/`.
2. **Collect facts. Don't invent any.**
   - Run `git status --short` and `git log --oneline -10`. If the last entry records a commit, also run `git diff --stat <that commit>`.
   - Note which tests and commands were **actually run in this session**, and their results.
   - Note decisions made in this session, and reports returned by subagents.
3. **Add a progress entry** at the top of the entries in `docs/PROGRESS.md`: below the header, above older entries. Use the Asia/Bangkok date and keep it to 15 lines or fewer:
   ```
   ## YYYY-MM-DD · P<n> · <short title>
   - **Summary:** …
   - **Changed:** files and modules, briefly
   - **Verification:** exact commands and results, or "not run"
   - **Decisions:** D-xx added or changed, or "none"
   - **Open issues:** …
   - **Next:** …
   - **Commit:** <hash> or "uncommitted"
   ```
4. **Update the phase checkpoint.**
   - Tick exit criteria that are now shown to be met, and point to the evidence (test name, command output, screenshot).
   - **As built:** refresh the short architecture notes (packages/modules, endpoints, tables, events, settings, infra). Replace outdated text and keep it brief.
   - **Log:** add one line that links to the new PROGRESS entry.
5. **Decisions.** If one was made or changed, update its row and section in `docs/decisions.md` (status and date).
6. **Phase transition.** If every exit criterion is met:
   - set the checkpoint status to `✅ Done (date)`;
   - point the `docs/PROGRESS.md` header at the next phase;
   - set the next checkpoint's status to `🟡 In progress`.
7. **CLAUDE.md.** Update only the sections that became outdated, e.g. a new package in the system map or new commands.
8. **Tell the user** in 3–5 lines what was recorded and what comes next. **Do not commit** unless the user asks.

## Rules
- Record facts only. Never mark tests as passed unless they ran in this session.
- No secrets, tokens or customer personal data in any log.
- Keep diffs small, and change only the lines that need updating.
