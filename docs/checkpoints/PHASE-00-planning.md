# Phase 0 — Planning

**Status:** 🟡 Waiting for owner answers · **Started:** 2026-09-29

## Goal
Agree on scope, architecture, providers, legal constraints and the phase plan before any code is written.

## Deliverables
- [x] Requirements, with the changes research forced: [01](../01-requirements.md)
- [x] Architecture: deployment, components, flows, realtime, security, offline: [02](../02-architecture.md)
- [x] Data model and state machines: [03](../03-data-model.md)
- [x] Integrations: LINE, PromptPay, gov co-pay, platforms, ntfy, printer: [04](../04-integrations.md)
- [x] Infrastructure, free tiers and 24/7 operations: [05](../05-infrastructure.md)
- [x] Legal and compliance: [06](../06-legal-compliance.md)
- [x] Limitations and risk register: [07](../07-limitations-risks.md)
- [x] Knowledge map: [08](../08-skills-knowledge.md)
- [x] Roadmap: [09](../09-roadmap.md)
- [x] Open questions: [10](../10-open-questions.md)
- [x] Decision log: [decisions.md](../decisions.md)
- [x] `CLAUDE.md`, agents, `/checkpoint` skill

## Exit criteria
- [x] Q1, Q2, Q4, Q5 answered; Q6–Q10 answered or defaults accepted; Q13 deferred. **Q3 (tax status), Q11 and Q12 still open, and they don't block P1.**
- [x] D-03 and D-10 resolved: **Path B** (E2.1.Micro, 1 GB). Other Proposed decisions still to be accepted or changed
- [ ] Owner has done or scheduled the legal action list ([06 §9](../06-legal-compliance.md#9-action-list-for-the-owner))
- [ ] Owner agrees the roadmap and the MVP line (P1–P5)

## Findings that changed the brief
See [01 §6](../01-requirements.md#6-requirements-changed-after-research):
- **CR1:** ไทยช่วยไทย is paid face-to-face at the storefront; its QR is never sent through LINE.
- **CR2:** a customer's "I've paid" is followed by staff confirmation.
- **CR3:** schemes are time-limited, so the method is configurable.
- **CR4:** a chat message for every status change would exceed the LINE quota.
- **CR5:** delivery-platform orders are entered by hand.

## As built
Documentation only. The repo layout in [02 §3](../02-architecture.md#3-components-and-repository-layout) is **planned**; P1 creates it.

## Log
- 2026-09-29: planning pack written. See [PROGRESS.md](../PROGRESS.md).
- 2026-09-29: VM reported as set up; SSH key files git-ignored; browser targets and the native-apps plan (D-19, P10, Q13) added. See [PROGRESS.md](../PROGRESS.md).
- 2026-09-29: VM recorded (E2.1.Micro, ap-singapore-1, Free Tier) → Path B; native apps deferred until the MacBook purchase.
- 2026-09-29: P1 prerequisites confirmed (Supabase in Singapore, pnpm, commit/push, per-device customization). See [PROGRESS.md](../PROGRESS.md).
