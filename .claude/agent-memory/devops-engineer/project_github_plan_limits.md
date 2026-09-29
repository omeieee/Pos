---
name: project-github-plan-limits
description: Repo omeieee/Pos is private and probably GitHub Free, so environments, environment secrets and branch protection are not enforced; CI gating is the working control
metadata:
  type: project
---

GitHub docs (checked 2026-09-29): for a **private** repo, environments with deployment-branch rules, environment secrets, and branch protection / required status checks need GitHub Pro, Team or Enterprise; on Free they are ignored. The repo is private (unauthenticated API returns 404); plan not confirmed with the owner.

**Why:** the owner runs everything at ฿0, so a paid plan is an ask-first decision, and the QA finding "GitHub write access = root on the VM" cannot be fully closed by GitHub settings on Free.

**How to apply:** write owner steps for environment/branch protection as conditional on the plan (SETUP "H1"), never tell the owner to move TS_OAUTH_*/CLOUDFLARE_* secrets into an environment unless the plan supports it (on Free they would be ignored and deploys would run with empty secrets). The `workflow_run` CI gate, SHA-pinned actions, and the deploy `plan` job are the controls that work on Free. `environment: production` in the workflows is harmless labelling on Free (docs: unconfigured environments are auto-created without rules; not tested).
