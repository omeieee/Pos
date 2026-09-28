# 06 · Legal and Compliance (Thailand)

> **This is not legal or tax advice.** It lists what the system must support and what the owner should confirm with an accountant (สำนักงานบัญชี) or the relevant authority.
> ✅ = checked against the linked source in Sept 2026. ⚠️ = general knowledge, **confirm before relying on it**.

## 1. Personal income tax (sole trader, บุคคลธรรมดา)
| Topic | Detail | Status |
|---|---|---|
| Income type | Restaurant income is business income under section 40(8) | ✅ [PEAK](https://www.peakaccount.com/blog/tax/corporate-income-tax/income-tax) |
| Expense deduction | Choose **flat-rate 60%** (for 40(8) since tax year 2560/2017) **or actual expenses** (needs records). The POS computes both | ✅ same source |
| Brackets | 0–150,000 exempt · 150,001–300,000 5% · 300,001–500,000 10% · 500,001–750,000 15% · 750,001–1M 20% · 1M–2M 25% · 2M–5M 30% · > 5M 35% (of net income) | ✅ [PwC](https://taxsummaries.pwc.com/thailand/individual/taxes-on-personal-income) |
| 0.5% method | If income under 40(2)–(8) totals **≥ ฿1,000,000**, also compute 0.5% of that gross income and pay the higher of the two. Exempt if the 0.5% amount is ≤ ฿5,000 | ✅ [RD calculation page](https://www.rd.go.th/555.html) (re-check each year) |
| Allowances | Personal ฿60,000 plus others (insurance, social security, funds …). They change often, so they are entered per year in `tax_profiles`, and caps live in the yearly rules file | ⚠️ confirm each year |
| Mid-year return ภ.ง.ด.94 | Covers Jan–Jun 40(5)–(8) income. Filed in **September** of the same year. **If the shop earned income in Jan–Jun 2026, this is due now.** Check rd.go.th for any e-filing extension | ⚠️ confirm dates |
| Annual return ภ.ง.ด.90 | Filed by the end of March of the following year (e-filing usually gets extra days) | ⚠️ confirm dates |

## 2. VAT
| Topic | Detail | Status |
|---|---|---|
| Registration threshold | Registration is required once annual revenue exceeds **฿1.8M**, within 30 days of crossing it. After that: tax invoices, monthly ภ.พ.30, prices including VAT | ⚠️ well-established; confirm |
| Rate | **7%** (6.3% + local tax), extended **to 30 Sep 2027** (Royal Decree No. 807 B.E. 2569) | ✅ [Nation](https://www.nationthailand.com/news/policy/40069105), [HLB](https://www.hlbthai.com/cabinet-approves-1-year-extension-of-7-vat-rate-until-30-september-2027/) |
| System support | VAT settings are off by default. There is a threshold watch (rolling 12 months, alert at 80%). **Do not print "ใบกำกับภาษี" while not VAT-registered** | ⚠️ confirm receipt wording |

## 3. e-Payment reporting law (banks report to the Revenue Department)
- ✅ Banks and e-wallet providers report an individual who, **per bank, across all their accounts** in a calendar year, has:
  - **≥ 3,000 incoming deposits/transfers** (any amount), **or**
  - **≥ 400 incoming deposits/transfers totalling ≥ ฿2,000,000**.

  Only incoming money counts. Reports go to the Revenue Department by March of the next year. Sources: [FlowAccount](https://flowaccount.com/blog/e-payment-tax/), [RD Q&A (PDF)](https://www.rd.go.th/fileadmin/download/Q&A_271162.pdf), [Finnomena](https://www.finnomena.com/finspace/e-payment-tax/).
- **What it means here:** about 9 PromptPay payments a day already reaches 3,000 a year. **Assume the Revenue Department sees the shop's income** and file correctly. The POS counts PromptPay payments per year so the owner knows early.
- ⚠️ Recommended: use a **separate bank account for the shop**, so business money is not mixed with personal money. Remember that gov co-pay money must go to a Krungthai savings account.

## 4. Records and receipts
| Topic | Detail | Status |
|---|---|---|
| Cash receipts–payments report | Individuals with business income are expected to keep a daily report of cash received and paid (รายงานเงินสดรับ-จ่าย). The POS can generate it from orders and expenses (T5) | ⚠️ confirm the format with the accountant |
| How long to keep records | Keep sales, expense and supporting documents for **5 years** (the default retention) | ⚠️ confirm |
| Receipts | Offer an e-receipt in LINE and printed receipts later (P8). Receipts only, not tax invoices, while not VAT-registered | ⚠️ confirm |

## 5. Business permits and premises
| Topic | Detail | Status |
|---|---|---|
| Commercial registration (ทะเบียนพาณิชย์) | Usually needed for a fixed-location shop. Register at the district office / สำนักงานเขต | ⚠️ confirm with the district |
| Food premises | A notification certificate or licence to run a food outlet from the local authority under the Public Health Act. Which one depends on floor area and location | ⚠️ confirm with สำนักงานเขต/เทศบาล |
| **Condominium rules** | The juristic person's regulations may limit commercial use of units or common areas, signs, QR posters, delivery to rooms and opening hours | ⚠️ ask the condo juristic office |
| Price display | Menu prices must be clearly shown, in the LINE menu too. If platform prices differ, the platform shows its own | ⚠️ confirm |
| Staff | If you employ staff: employment contracts and social security registration | ⚠️ outside this system |

## 6. Personal data (PDPA, พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562)
- ✅ Fully in force since **1 June 2022**. ✅ Under a 2022 PDPC notification, **small businesses are exempt from keeping a record of processing activities (RoPA)**. The exemption does not apply to high-risk or sensitive processing ([PDPA Thailand](https://pdpathailand.com/pdpa/content/article202.php)).
- ⚠️ What the system and shop still do:
  1. **Privacy notice in Thai.** Shown in the LINE app on first use and linked from the rich menu. It says what is collected, why and for how long: LINE ID, display name, picture, orders, optional phone/room, and slip images.
  2. **Lawful basis.** Order handling is performance of a contract. Sales analytics is legitimate interest. **Marketing broadcasts need consent**, with a separate opt-in.
  3. **Collect as little as possible.** Never collect national ID numbers. Keep phone and room optional.
  4. **Rights.** Customers can ask for access or deletion through LINE chat. The owner can anonymise a customer, and financial records are kept.
  5. **Security.** HTTPS, access control, audit log, encrypted backups. Slip images contain bank names and account numbers, so they sit in a private bucket and are deleted after 90 days.
  6. **Breach.** Notify the PDPC within **72 hours** of learning of a qualifying breach. Keep an incident log.
  7. **Transfer abroad.** The cloud servers (Oracle region, Cloudflare, Supabase) may be outside Thailand. Say so in the notice, and use providers with data-processing terms.

## 7. Government co-pay scheme rules (ไทยช่วยไทย พลัส)
- ✅ The QR is created in ถุงเงิน **per transaction**, for the full price, and expires. The customer scans it with เป๋าตัง **at the storefront**, with GPS. Hours are 06:00–23:00. Money is settled the next day into a Krungthai savings account.
- ✅ Merchants who were suspended or had money clawed back in earlier schemes are excluded.
- **So:** never send the scheme QR through LINE, never create a QR for a different amount than the real sale, and don't charge scheme users more. The POS makes the right path the easy one (D-08). Sources in [04 §3.1](04-integrations.md#31-facts-checked-sept-2026).
- ⚠️ Read the full merchant terms in ถุงเงิน, especially on remote or delivery sales and eligible goods (no alcohol or tobacco).

## 8. LINE platform terms
- ✅ Push messages count against the plan quota ([LINE pricing](https://developers.line.biz/en/docs/messaging-api/pricing/)).
- ⚠️ Follow the LINE Official Account Terms, the LINE Developers Agreement and the LINE MINI App Policy: no spam, respect blocks, use the user data LINE provides only for the stated purpose, and publish a privacy policy for the MINI App.

## 9. Action list for the owner
1. Confirm your tax status with an accountant, and **whether ภ.ง.ด.94 for Jan–Jun 2026 is due now**.
2. Open a separate bank account for the shop. Keep the Krungthai account if you use ถุงเงิน.
3. Check commercial registration, the food-premises certificate and the **condo rules**.
4. Approve the Thai privacy notice text (drafted in P4).
5. Decide whether to track actual expenses (for the actual-expense deduction) or use the flat 60%. The POS supports both.
