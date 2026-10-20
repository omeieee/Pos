/**
 * Thai personal income tax rules for tax year B.E. 2569 (2026), a sole trader with section 40(8)
 * income (selling food and drink). DATA ONLY: a new year is a new file like this one, listed in
 * `registry.ts`, with no change to the estimator.
 *
 * Status: proposed. Every figure below was read from the Revenue Department (RD, กรมสรรพากร) pages
 * named beside it on 2026-10-20 and has not been confirmed by an accountant. The two RD form
 * instructions are read from the PDFs themselves (Thai text rendered to images and read):
 *   INS94 = วิธีกรอกแบบ ภ.ง.ด.94 ปีภาษี 2569   https://www.rd.go.th/fileadmin/tax_pdf/pit/2569/Ins94_160669.pdf
 *   INS90 = วิธีกรอกแบบ ภ.ง.ด.90 ปีภาษี 2568   https://www.rd.go.th/fileadmin/tax_pdf/pit/2568/Ins90_241268.pdf
 * The 2569 annual instruction (ภ.ง.ด.90) is not published yet; where a figure is taken from the 2568
 * one it says so.
 */
import type { RuleSource, TaxRules } from './types.ts';

const CHECKED = '2026-10-20';
const INS94 = 'https://www.rd.go.th/fileadmin/tax_pdf/pit/2569/Ins94_160669.pdf';
const INS90 = 'https://www.rd.go.th/fileadmin/tax_pdf/pit/2568/Ins90_241268.pdf';

const src = (url: string, says: string): RuleSource => ({ url, checkedOn: CHECKED, says });

export const thPit2569: TaxRules = {
  ruleYear: 2569,
  status: 'proposed - confirm with the Revenue Department',

  brackets: {
    // INS94 p.17 "ตารางที่ 1": net income 0-150,000 exempt (Royal Decree No. 470 B.E. 2551), then
    // 5% to 300,000, 10% to 500,000, 15% to 750,000, 20% to 1,000,000, 25% to 2,000,000, 30% to
    // 5,000,000, 35% above. Same rates for the half-year and annual returns (RD FAQ 61549.html:
    // "ไม่ว่าการคำนวณภาษีครึ่งปีหรือสิ้นปีก็ต้องใช้อัตราเดียวกัน").
    tiers: [
      { overSatang: 0, ratePercent: 0 },
      { overSatang: 15_000_000, ratePercent: 5 },
      { overSatang: 30_000_000, ratePercent: 10 },
      { overSatang: 50_000_000, ratePercent: 15 },
      { overSatang: 75_000_000, ratePercent: 20 },
      { overSatang: 100_000_000, ratePercent: 25 },
      { overSatang: 200_000_000, ratePercent: 30 },
      { overSatang: 500_000_000, ratePercent: 35 },
    ],
    sources: [
      src(INS94, 'p.17 table 1: rate table, cumulative tax column (1,265,000 baht at 5,000,000)'),
      src(
        'https://www.rd.go.th/61549.html',
        'same rates for the half-year and year-end calculation',
      ),
    ],
  },

  flatExpense: {
    // INS94 p.17 "ตารางที่ 2" item (9): hotel, restaurant, preparing food or drink for sale: 60%.
    // INS94 p.2: for 40(8) the taxpayer picks actual expenses OR the flat rate, not both.
    ratePercent: 60,
    sources: [
      src(
        INS94,
        'p.17 table 2 item (9) restaurant, food and drink: 60 percent; p.2 choose one method',
      ),
    ],
  },

  allowances: {
    // INS90 (2568) p.7: personal 60,000 baht a year. INS94 (2569) p.3: on the half-year return the
    // personal allowance is entered as 30,000 baht (spouse 30,000, each child 15,000, each parent
    // 15,000: half of the annual figures; RD FAQ 61549.html "ให้ใช้ค่าลดหย่อนได้เพียงกึ่งหนึ่ง").
    personalAnnualSatang: 6_000_000,
    personalHalfYearSatang: 3_000_000,
    sources: [
      src(
        INS90,
        'p.7 item 1: personal allowance 60,000 baht (2568 form; 2569 form not yet published)',
      ),
      src(
        INS94,
        'p.3: half-year personal allowance 30,000 baht; spouse 30,000; child 15,000; parent 15,000',
      ),
      src(
        'https://www.rd.go.th/61549.html',
        'half-year return: allowances only half (section 56 ter)',
      ),
    ],
  },

  halfPercent: {
    // Revenue Code section 48(2): tax is at least 0.5% of the assessable income of 40(2)-(8) (not
    // 40(1)), unless that amount is 5,000 baht or less, in which case the normal tax is paid
    // (Royal Decree No. 480 B.E. 2552). Worked examples: RD page 31847.html.
    rateBasisPoints: 50,
    // Threshold: the two CURRENT form instructions (INS94 p.15 and INS90 p.6, both under "คำนวณภาษี
    // จาก 2 วิธี") say "ตั้งแต่ 120,000 บาทขึ้นไป". Two older RD pages say 60,000 (31847.html, updated
    // 2022, and letter กค 0702/9340 of 11 Nov 2009 on 42101.html, updated 2020); 555.html (updated
    // 2020) says 120,000. We use the current form figure and keep the other as a recorded conflict.
    // Our own docs/06 said 1,000,000; no RD page gives that: it is where 0.5% reaches 5,000 baht.
    thresholdSatang: 12_000_000,
    thresholdStatus: 'conflict',
    conflictingThresholdsSatang: [6_000_000],
    exemptCeilingSatang: 500_000,
    sources: [
      src(
        INS94,
        'p.15: 0.5% of assessable income when it is 120,000 baht or more; not over 5,000 baht then normal tax',
      ),
      src(INS90, 'p.6: same rule on the annual return (tax year 2568)'),
      src('https://www.rd.go.th/555.html', 'threshold 120,000 baht, updated 2020-11-21'),
      src(
        'https://www.rd.go.th/31847.html',
        'threshold 60,000 baht (older wording), 5,000 baht exemption, worked examples of tax year 2552',
      ),
      src('https://rd.go.th/42101.html', 'letter กค 0702/9340 (2009): threshold 60,000 baht'),
    ],
  },

  filing: {
    // INS94 p.1: a single person files ภ.ง.ด.94 when the Jan-Jun 40(5)-(8) income is over 60,000
    // baht (couples: over 120,000 together). INS90 p.1: the same 60,000 for ภ.ง.ด.90.
    annualIncomeOverSatang: 6_000_000,
    halfYearIncomeOverSatang: 6_000_000,
    // INS94 p.15: file ภ.ง.ด.94 from 1 July to 30 September of the tax year (online filing may be
    // extended by an RD notice: not checked). INS90 p.6: ภ.ง.ด.90 from 1 January to 31 March of the
    // next year (2568 form: 2569-01-01 to 2569-03-31); the 2569 form is not published, so the
    // same dates are assumed for 2570.
    halfYearWindow: { from: '2026-07-01', to: '2026-09-30' },
    annualWindow: { from: '2027-01-01', to: '2027-03-31' },
    // INS94 p.15: 1.5 percent a month on the tax (a part month counts as a month) and a fine up
    // to 2,000 baht for filing late.
    lateSurchargePercentPerMonth: 1.5,
    lateFineMaxSatang: 200_000,
    sources: [
      src(
        INS94,
        'p.1 who files (over 60,000 single, 120,000 couple); p.15 window and late surcharge and fine',
      ),
      src(INS90, 'p.1, p.6 annual return: who files and window (tax year 2568 form)'),
    ],
  },

  vat: {
    // Sales of more than 1,800,000 baht a year: register for VAT within 30 days (Revenue Code
    // sections 85/1 and 79/3; RD ruling 0702/3397 "ไม่เกิน 1,800,000 บาท จึงยังไม่มีหน้าที่ต้องจดทะเบียน").
    // "More than", so exactly 1,800,000 baht does not register. warnAtPercent is OUR choice.
    registrationOverSatang: 180_000_000,
    warnAtPercent: 80,
    sources: [
      src(
        'https://www.rd.go.th/38573.html',
        'ruling 0702/3397: not over 1,800,000 baht, no duty to register',
      ),
      src(
        'https://www.rd.go.th/fileadmin/download/insight_pasi/4morjor_vat3_20181011.pdf',
        'RD VAT registration manual (2018)',
      ),
    ],
  },

  ePayment: {
    // Banks report to RD an individual's incoming deposits/transfers, all accounts at one bank, per
    // calendar year: 3,000 times or more, OR 400 times or more with a total of 2,000,000 baht or
    // more (Royal Decree on e-Payment reporting, Ministerial Regulation No. 355 B.E. 2562).
    transferCount: 3000,
    altTransferCount: 400,
    altTotalSatang: 200_000_000,
    warnAtPercent: 80,
    sources: [
      src(
        'https://www.rd.go.th/fileadmin/download/Q&A_271162.pdf',
        'RD Q&A on bank reporting: 3,000 times, or 400 times and 2,000,000 baht',
      ),
    ],
  },
};
