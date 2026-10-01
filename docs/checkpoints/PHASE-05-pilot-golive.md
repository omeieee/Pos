# Phase 5 — Pilot and Go-Live

**Status:** ⚪ Not started · **Depends on:** P3, P4 · **Agents:** qa-security-reviewer, devops-engineer, ux-ui-designer

## Goal
Run the real shop on the system safely, with trained staff and written procedures.

## Scope
- **In:**
  - UAT on the actual devices and network;
  - SOPs (in Thai): payment confirmation, fake slips, gov co-pay, outage mode, day close, lost device;
  - staff training;
  - security and PDPA review;
  - load sanity check;
  - soft launch (1–2 weeks, paper backup ready);
  - go-live checklist;
  - fix list.
- **Out:** new features.

## Exit criteria
- [ ] UAT checklist passed on iPad, iPhone and laptop, and in LINE on iOS and Android
- [ ] SOPs printed or saved where staff can reach them; staff can run each SOP unaided
- [ ] Security/PDPA review: no open high-severity findings
- [ ] Soft launch: at least 7 business days with no data loss and every issue logged and triaged
- [ ] (carried from P2) Rebuild-on-new-host procedure tested once on a second Always Free Micro VM, then the test VM **and its volume** deleted (docs/05 §3.1); Oracle Pay-As-You-Go checked in the console: account type, budget alert (about US$1), Cost Analysis at zero
- [ ] (carried from P2) Restore drill repeated with real business data (the empty-table check was untested), and the backup bucket size checked against the 10 GB Standard allowance
- [ ] Owner signs off go-live; P6/P8 priorities set

## As built
_Fill in with `/checkpoint`._

## Log
_Empty._
