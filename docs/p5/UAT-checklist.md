# P5 UAT checklist

Run on the real devices and the production API (test LINE OA until the owner switches). Mark each with date, device and tester. Anything failing becomes a fix-list item; do not tick on a mock API (`VITE_MOCK_API`).

## A. Staff app — iPad (Safari, Home Screen) · iPhone · laptop
| # | Check | iPad | iPhone | Laptop |
|---|---|---|---|---|
| A1 | Sign-in: owner, staff PIN, wrong PIN lock countdown | | | |
| A2 | Register device (owner), staff cards appear | | | |
| A3 | 20-second order with modifiers (timer: ___ s) | | | n/a |
| A4 | Dine-in, takeaway, room (entrance) delivery with recipient | | | |
| A5 | Cash: keypad, change, double tap makes one payment | | | |
| A6 | PromptPay QR: exact amount, K PLUS scan, Krungthai NEXT scan, masked target matches | | | n/a |
| A7 | QR link fresh after 5+ minutes in background | | | |
| A8 | Customer view (long press to return) | | | n/a |
| A9 | Claimed payment highlighted; confirm; "money not found" | | | |
| A10 | Void/refund with step-up (manager) and audit/alert received | | | |
| A11 | ไทยช่วยไทย blocked outside scheme window/with reason; (if registered) one real payment | | | |
| A12 | Change on device 1 visible on device 2 in under 1 s (p95 over 20 changes: ___ ms) | | | |
| A13 | Kitchen view: chime, audio unlock, warn 8 min / late 12 min, idle-limit behaviour | | | |
| A14 | Airplane mode: cash + PromptPay orders sync once, no duplicates; did iOS discard the app? | | | n/a |
| A15 | Sign out with unsent entries is blocked/warned | | | |
| A16 | Home Screen update with a payment open does not reload | | | n/a |
| A17 | Menu editor, sold-out toggle, settings, devices screens against real API | | | |
| A18 | Layout/blur/scroll performance of the glass theme; iPhone one-handed | | | |
| A19 | Invite flow: copy link, set password/authenticator/PIN, recovery codes shown once | | | |
| A20 | Dashboard shows "sample data" badge (no real numbers claimed) | n/a | n/a | |

## B. LINE app — iOS and Android (test OA)
| # | Check | iOS | Android |
|---|---|---|---|
| B1 | Follow OA: greeting, privacy notice, acknowledgement stored | | |
| B2 | Rich menu opens ordering app; language switch | | |
| B3 | Menu → cart → checkout (building + name) → order confirmation reply | | |
| B4 | PromptPay: order page shows QR; save image, pay from gallery | | |
| B5 | "โอนแล้ว" → staff see claimed → staff confirm → status updates | | |
| B6 | Change payment method from chat buttons and from app; POS updates < 1 s | | |
| B7 | ไทยช่วยไทย in LINE shows instructions only, never a QR | | |
| B8 | Completion push once per order; quota page shows usage; policy `off` stops pushes | | |
| B9 | Same webhook delivered twice does not double-process | (API test) | |
| B10 | CSP/behaviour inside the LINE in-app browser | | |

## C. Operations
| # | Check | Result |
|---|---|---|
| C1 | `/healthz`, `/readyz`, backups hourly, healthchecks.io UP | |
| C2 | Restore drill with real business data; bucket size vs 10 GB | |
| C3 | Rebuild on a second Micro VM, then delete VM and volume | |
| C4 | Oracle console: PAYG, budget alert, Cost Analysis zero, reserved IP cost | |
| C5 | Alert mail path (Sentry/UptimeRobot) after the host change | |
| C6 | Lost-device drill: revoke a device, confirm it cannot sync | |
| C7 | Load sanity: 10 devices, 150 orders in an hour on staging data | |

## D. Sign-off
Soft launch ≥ 7 business days, paper backup ready, issue log triaged, no open high security/PDPA finding, owner signs go-live.
