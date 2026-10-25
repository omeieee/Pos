---
name: p7-tax-rules-findings
description: How RD Thai-text PDFs were read, and the verified 2569 tax facts (0.5% threshold, half-year allowances) behind packages/finance tax-rules
metadata:
  type: project
---

RD form-instruction PDFs have no Thai text layer (pdftotext/WebFetch return nothing). Render pages with PyMuPDF (`py -3 -m pip install pymupdf`, `get_pixmap(dpi=100).save(png)`) and read the PNGs with the Read tool. Key pages: Ins94_160669.pdf (2569) p.3 allowances, p.15 two-method tax + window, p.17 rate and 40(8) tables; Ins90_241268.pdf (2568) p.6-7.

Verified 2026-10-20: 0.5% threshold is 120,000 in current forms (60,000 only in 2009-era pages); 5,000 baht exemption makes it moot below 1,000,000 gross; half-year personal allowance is 30,000 (stated on the form); ภ.ง.ด.94 2569 window 1 Jul-30 Sep 2026 already passed.

**Why:** the owner has no accountant, so RD primary sources are the only check. **How to apply:** for a new tax year, re-render the new Ins94/Ins90 and update `tax-rules/th-pit-<year>.ts` plus the registry; see D-34.
