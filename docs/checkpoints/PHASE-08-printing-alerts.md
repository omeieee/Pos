# Phase 8 — Kitchen Printing and Phone Alerts

**Status:** ⚪ Not started · **Depends on:** P5; Mini PC + XP-80T bought · **Agents:** backend-engineer, devops-engineer, ux-ui-designer

## Goal
Every order, whatever its source (LINE, storefront, Grab, LINE MAN), prints in the kitchen and rings staff phones.

## Scope
- **In:**
  - self-hosted ntfy in Compose with tokens, private topics and an upstream for iOS;
  - notifications with a thumbnail, priority and a click-through;
  - `apps/print-agent` on the Mini PC as a service with outbound WSS;
  - `packages/escpos` raster rendering of Thai tickets;
  - `print_jobs` queue with retries and reprint;
  - printer on a fixed IP;
  - Mini PC set to power on after a power cut; UPS.
- **Out:** customer receipts (optional stretch), local hub (P9).

## Exit criteria
- [ ] Orders from all four sources print within 3 s with correct Thai text, source badge and order number
- [ ] Printer off or out of paper → job retries and staff are alerted; a reprint gives exactly one copy
- [ ] Mini PC reboot or power loss → agent recovers with no duplicate prints
- [ ] ntfy alert with thumbnail and alarm priority arrives on the kitchen phone(s), with no customer personal data in it

## As built
_Fill in with `/checkpoint`._

## Log
_Empty._
