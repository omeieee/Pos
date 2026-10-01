import { describe, expect, test } from 'vitest';
import { FULFILLMENTS, ORDER_CHANNELS } from './enums.ts';
import {
  copayAvailabilityInputSchema,
  copayAvailabilityResultSchema,
  estimateGovCopaySplit,
  type GovCopayScheme,
  govCopaySchemeSchema,
  govCopaySplitEstimateSchema,
  govCopaySplitInputSchema,
  isCopayAvailable,
  MAX_COPAY_TOTAL_SATANG,
} from './gov-copay.ts';
import { type Satang, satang } from './money.ts';
import { mulberry32, randomInt } from './test-prng.ts';

const s = (n: number): Satang => satang(n);
const raw = (n: number): Satang => n as Satang;

/**
 * TEST FIXTURE ONLY. These are the owner's figures for the 1 Oct - 30 Nov 2026 round
 * (docs/04 §3.1, recorded 2026-10-01): government 60%, ฿200 a day and ฿1,000 for the round per
 * person, 06:00-23:00 Asia/Bangkok, 2026-10-01 to 2026-11-30. Production code reads the
 * scheme from `gov_copay_schemes`; nothing in src outside tests contains these numbers.
 */
const ROUND_2: GovCopayScheme = govCopaySchemeSchema.parse({
  govShareBp: 6000,
  govDailyCapSatang: 20000,
  govTotalCapSatang: 100000,
  activeFrom: '2026-10-01',
  activeTo: '2026-11-30',
  activeFromMinute: 360,
  activeToMinute: 1380,
  channels: ['storefront'],
  enabled: true,
});

/** Same dates, but open all day, so date edges are not hidden by the 06:00-23:00 hours. */
const ALL_DAY: GovCopayScheme = { ...ROUND_2, activeFromMinute: 0, activeToMinute: 1440 };

const NO_CAPS: GovCopayScheme = { ...ROUND_2, govDailyCapSatang: null, govTotalCapSatang: null };

describe('govCopaySchemeSchema', () => {
  test('parses a scheme and brands the caps', () => {
    expect(ROUND_2).toEqual({
      govShareBp: 6000,
      govDailyCapSatang: 20000,
      govTotalCapSatang: 100000,
      activeFrom: '2026-10-01',
      activeTo: '2026-11-30',
      activeFromMinute: 360,
      activeToMinute: 1380,
      channels: ['storefront'],
      enabled: true,
    });
  });

  test('parses a gov_copay_schemes row as the database returns it and drops the other columns', () => {
    const row = {
      id: '0198a4c2-7b1e-7000-8000-000000000001',
      code: 'thai_chuay_thai_plus_2026_r2',
      nameTh: 'ไทยช่วยไทย พลัส 60/40',
      nameEn: 'Thai Chuay Thai Plus 60/40',
      govShareBp: 6000,
      govDailyCapSatang: 20000,
      govTotalCapSatang: 100000,
      activeFrom: '2026-10-01',
      activeTo: '2026-11-30',
      activeFromMinute: 360,
      activeToMinute: 1380,
      channels: ['storefront'],
      settlementNote: 'next day',
      enabled: false,
      version: 1,
      rev: 12,
    };
    const parsed = govCopaySchemeSchema.parse(row);
    expect(parsed.enabled).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'activeFrom',
        'activeFromMinute',
        'activeTo',
        'activeToMinute',
        'channels',
        'enabled',
        'govDailyCapSatang',
        'govShareBp',
        'govTotalCapSatang',
      ].sort(),
    );
  });

  test('null caps mean "no cap known" and are accepted', () => {
    expect(
      govCopaySchemeSchema.safeParse({
        ...ROUND_2,
        govDailyCapSatang: null,
        govTotalCapSatang: null,
      }).success,
    ).toBe(true);
  });

  test('a one-day scheme (activeFrom = activeTo) is allowed', () => {
    expect(
      govCopaySchemeSchema.safeParse({
        ...ROUND_2,
        activeFrom: '2026-10-05',
        activeTo: '2026-10-05',
      }).success,
    ).toBe(true);
  });

  const bad: [string, Record<string, unknown>][] = [
    ['share above 100%', { govShareBp: 10001 }],
    ['negative share', { govShareBp: -1 }],
    ['fractional share', { govShareBp: 59.5 }],
    ['end date before start date', { activeFrom: '2026-12-01', activeTo: '2026-11-30' }],
    ['impossible calendar date', { activeTo: '2026-02-30' }],
    ['not an ISO date', { activeFrom: '01/10/2026' }],
    ['hours reversed', { activeFromMinute: 1380, activeToMinute: 360 }],
    ['empty hours', { activeFromMinute: 360, activeToMinute: 360 }],
    ['closing after 24:00', { activeToMinute: 1441 }],
    ['negative opening minute', { activeFromMinute: -1 }],
    ['fractional minute', { activeFromMinute: 360.5 }],
    ['unknown channel', { channels: ['facebook'] }],
    ['enabled as text', { enabled: 'true' }],
    ['negative daily cap', { govDailyCapSatang: -1 }],
    ['fractional total cap', { govTotalCapSatang: 1000.5 }],
    ['daily cap as text', { govDailyCapSatang: '20000' }],
  ];
  test.each(bad)('rejects %s', (_label, patch) => {
    expect(govCopaySchemeSchema.safeParse({ ...ROUND_2, ...patch }).success).toBe(false);
  });

  test.each([
    'govShareBp',
    'govDailyCapSatang',
    'govTotalCapSatang',
    'activeFrom',
    'activeTo',
    'activeFromMinute',
    'activeToMinute',
    'channels',
    'enabled',
  ])('rejects a scheme with %s missing (a forgotten cap must not mean "uncapped")', (key) => {
    const partial: Record<string, unknown> = { ...ROUND_2 };
    delete partial[key];
    expect(govCopaySchemeSchema.safeParse(partial).success).toBe(false);
  });
});

describe('estimateGovCopaySplit: worked examples (docs/04 §3.2, 02 §4.3)', () => {
  test.each([
    // total, gov, customer, capped
    [9500, 5700, 3800, false], // ฿95: the documented example (about ฿57 / ฿38)
    [4500, 2700, 1800, false], // ฿45
    [10000, 6000, 4000, false], // ฿100
    [40000, 20000, 20000, true], // ฿400: 60% would be ฿240, the daily cap is ฿200
    [0, 0, 0, false],
  ])('total %i → government %i, customer %i, capped %s', (total, gov, customer, capped) => {
    expect(estimateGovCopaySplit(s(total), ROUND_2)).toEqual({
      total,
      govShare: gov,
      customerShare: customer,
      capped,
      estimate: true,
    });
  });

  test('around the daily cap: ฿333.33 and ฿333.34 are not capped, ฿333.35 is', () => {
    // 60% of 33333 = 19999.8 → 20000 = the cap exactly, so nothing is cut.
    expect(estimateGovCopaySplit(s(33333), ROUND_2)).toMatchObject({
      govShare: 20000,
      customerShare: 13333,
      capped: false,
    });
    // 60% of 33334 = 20000.4 → 20000.
    expect(estimateGovCopaySplit(s(33334), ROUND_2)).toMatchObject({
      govShare: 20000,
      customerShare: 13334,
      capped: false,
    });
    // 60% of 33335 = 20001 → cut back to 20000.
    expect(estimateGovCopaySplit(s(33335), ROUND_2)).toMatchObject({
      govShare: 20000,
      customerShare: 13335,
      capped: true,
    });
  });

  test('the estimate is always labelled as an estimate', () => {
    expect(estimateGovCopaySplit(s(9500), ROUND_2).estimate).toBe(true);
  });
});

describe('estimateGovCopaySplit: rounding rule (half up on the government share, remainder to the customer)', () => {
  // 60%: 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0 → rounded half up.
  test.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [6, 4],
    [7, 4],
    [8, 5],
    [9, 5],
    [10, 6],
  ])('60%% of %i satang → government %i', (total, gov) => {
    const out = estimateGovCopaySplit(s(total), NO_CAPS);
    expect(out.govShare).toBe(gov);
    expect(out.customerShare).toBe(total - gov);
  });

  test('exact halves round up for the government share, so the customer gets the smaller part', () => {
    const half: GovCopayScheme = { ...NO_CAPS, govShareBp: 5000 };
    expect(estimateGovCopaySplit(s(1), half)).toMatchObject({ govShare: 1, customerShare: 0 });
    expect(estimateGovCopaySplit(s(3), half)).toMatchObject({ govShare: 2, customerShare: 1 });
    expect(estimateGovCopaySplit(s(4), half)).toMatchObject({ govShare: 2, customerShare: 2 });
  });
});

describe('estimateGovCopaySplit: caps and other schemes (nothing is hardcoded)', () => {
  test('the round cap applies when it is lower than the daily cap', () => {
    // Synthetic: the owner's real figures never reach this case.
    const tight: GovCopayScheme = {
      ...ROUND_2,
      govDailyCapSatang: s(20000),
      govTotalCapSatang: s(15000),
    };
    expect(estimateGovCopaySplit(s(40000), tight)).toMatchObject({
      govShare: 15000,
      customerShare: 25000,
      capped: true,
    });
    expect(estimateGovCopaySplit(s(20000), tight)).toMatchObject({
      govShare: 12000,
      customerShare: 8000,
      capped: false,
    });
  });

  test('no caps means the full share', () => {
    expect(estimateGovCopaySplit(s(40000), NO_CAPS)).toMatchObject({
      govShare: 24000,
      customerShare: 16000,
      capped: false,
    });
  });

  test('a single known cap is used on its own', () => {
    expect(
      estimateGovCopaySplit(s(40000), { ...NO_CAPS, govDailyCapSatang: s(10000) }),
    ).toMatchObject({ govShare: 10000, capped: true });
    expect(
      estimateGovCopaySplit(s(40000), { ...NO_CAPS, govTotalCapSatang: s(12345) }),
    ).toMatchObject({ govShare: 12345, capped: true });
  });

  test('a cap of zero means the government pays nothing', () => {
    expect(estimateGovCopaySplit(s(9500), { ...ROUND_2, govDailyCapSatang: s(0) })).toMatchObject({
      govShare: 0,
      customerShare: 9500,
      capped: true,
    });
  });

  test('another ratio works the same way (50/50 with a ฿100 cap)', () => {
    const fifty: GovCopayScheme = { ...ROUND_2, govShareBp: 5000, govDailyCapSatang: s(10000) };
    expect(estimateGovCopaySplit(s(30000), fifty)).toMatchObject({
      govShare: 10000,
      customerShare: 20000,
      capped: true,
    });
    expect(estimateGovCopaySplit(s(15000), fifty)).toMatchObject({
      govShare: 7500,
      customerShare: 7500,
      capped: false,
    });
  });

  test('0% and 100% shares', () => {
    expect(estimateGovCopaySplit(s(9500), { ...NO_CAPS, govShareBp: 0 })).toMatchObject({
      govShare: 0,
      customerShare: 9500,
    });
    expect(estimateGovCopaySplit(s(9500), { ...NO_CAPS, govShareBp: 10000 })).toMatchObject({
      govShare: 9500,
      customerShare: 0,
    });
  });
});

describe('estimateGovCopaySplit: rejections', () => {
  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_COPAY_TOTAL_SATANG + 1,
    Number.MAX_SAFE_INTEGER,
  ])('rejects total %s', (total) => {
    expect(() => estimateGovCopaySplit(raw(total), ROUND_2)).toThrow(RangeError);
  });
  test('accepts the largest allowed total', () => {
    const out = estimateGovCopaySplit(s(MAX_COPAY_TOTAL_SATANG), NO_CAPS);
    expect(out.govShare + out.customerShare).toBe(MAX_COPAY_TOTAL_SATANG);
  });
  test.each([-1, 10001, 59.5, Number.NaN])('rejects share %s basis points', (bp) => {
    expect(() => estimateGovCopaySplit(s(9500), { ...ROUND_2, govShareBp: bp })).toThrow(
      RangeError,
    );
  });
  test.each([-1, 100.5, Number.NaN])('rejects cap %s', (cap) => {
    expect(() =>
      estimateGovCopaySplit(s(9500), { ...ROUND_2, govDailyCapSatang: raw(cap) }),
    ).toThrow(RangeError);
    expect(() =>
      estimateGovCopaySplit(s(9500), { ...ROUND_2, govTotalCapSatang: raw(cap) }),
    ).toThrow(RangeError);
  });
});

describe('estimateGovCopaySplit: properties (seeded, 5000 cases)', () => {
  /** Independent oracle in BigInt: floor((total × bp + 5000) / 10000), then the caps. */
  function oracle(total: number, bp: number, daily: number | null, round: number | null) {
    const rawShare = (BigInt(total) * BigInt(bp) + 5000n) / 10000n;
    let gov = rawShare;
    for (const cap of [daily, round]) {
      if (cap !== null && BigInt(cap) < gov) gov = BigInt(cap);
    }
    return { gov: Number(gov), customer: total - Number(gov), capped: gov < rawShare };
  }

  function randomScheme(rng: () => number): GovCopayScheme {
    const bp = randomInt(rng, 0, 10000);
    const daily = rng() < 0.2 ? null : randomInt(rng, 0, 100_000);
    const round = rng() < 0.2 ? null : randomInt(rng, 0, 500_000);
    return {
      ...ROUND_2,
      govShareBp: bp,
      govDailyCapSatang: daily === null ? null : s(daily),
      govTotalCapSatang: round === null ? null : s(round),
    };
  }

  test('matches the BigInt oracle; shares add up to the total exactly', () => {
    const rng = mulberry32(60_40);
    for (let i = 0; i < 5000; i++) {
      const scheme = randomScheme(rng);
      const span = i % 2 === 0 ? 100_000 : MAX_COPAY_TOTAL_SATANG;
      const total = randomInt(rng, 0, span);
      const out = estimateGovCopaySplit(s(total), scheme);
      const expected = oracle(
        total,
        scheme.govShareBp,
        scheme.govDailyCapSatang,
        scheme.govTotalCapSatang,
      );
      expect(out.govShare).toBe(expected.gov);
      expect(out.customerShare).toBe(expected.customer);
      expect(out.capped).toBe(expected.capped);
      expect(out.govShare + out.customerShare).toBe(total);
      expect(out.govShare).toBeGreaterThanOrEqual(0);
      expect(out.customerShare).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(out.govShare)).toBe(true);
      expect(Number.isSafeInteger(out.customerShare)).toBe(true);
      expect(out.estimate).toBe(true);
      expect(govCopaySplitEstimateSchema.safeParse(out).success).toBe(true);
    }
  });

  test('never exceeds either cap, and the customer share never shrinks as the total grows', () => {
    const rng = mulberry32(2026);
    for (let i = 0; i < 5000; i++) {
      const scheme = randomScheme(rng);
      const total = randomInt(rng, 0, 1_000_000);
      const a = estimateGovCopaySplit(s(total), scheme);
      const b = estimateGovCopaySplit(s(total + 1), scheme);
      for (const cap of [scheme.govDailyCapSatang, scheme.govTotalCapSatang]) {
        if (cap !== null) expect(a.govShare).toBeLessThanOrEqual(cap);
      }
      expect(b.govShare).toBeGreaterThanOrEqual(a.govShare);
      expect(b.customerShare).toBeGreaterThanOrEqual(a.customerShare);
      expect(b.govShare - a.govShare).toBeLessThanOrEqual(1);
    }
  });
});

describe('isCopayAvailable: hours and dates (Asia/Bangkok is UTC+7)', () => {
  test.each([
    // [UTC instant, Bangkok local time, expected]
    ['2026-09-30T05:00:00Z', '12:00 on 30 Sep: before the round', false],
    ['2026-09-30T22:59:59Z', '05:59:59 on 1 Oct: before opening', false],
    ['2026-09-30T23:00:00Z', '06:00:00 on 1 Oct: opens (the UTC date is still 30 Sep)', true],
    ['2026-10-01T04:00:00Z', '11:00 on 1 Oct', true],
    ['2026-10-01T15:59:59.999Z', '22:59:59.999 on 1 Oct: last moment', true],
    ['2026-10-01T16:00:00Z', '23:00:00 on 1 Oct: closed (hours end at 23:00)', false],
    ['2026-10-01T19:00:00Z', '02:00 on 2 Oct: closed overnight', false],
    ['2026-11-30T15:59:59Z', '22:59:59 on 30 Nov: last day, open', true],
    ['2026-11-30T16:00:00Z', '23:00:00 on 30 Nov: closed', false],
    ['2026-11-30T16:59:59Z', '23:59:59 on 30 Nov: the scheme end instant, hours closed', false],
    ['2026-12-01T03:00:00Z', '10:00 on 1 Dec: after the round', false],
  ])('%s (%s) → %s', (utc, _label, expected) => {
    expect(isCopayAvailable(ROUND_2, new Date(utc), 'storefront', 'pickup')).toBe(expected);
  });

  test.each([
    ['2026-09-30T16:59:59Z', '23:59:59 on 30 Sep', false],
    ['2026-09-30T17:00:00Z', '00:00:00 on 1 Oct (midnight must not read as 24:00)', true],
    ['2026-10-01T19:00:00Z', '02:00 on 2 Oct (no 04:00 business-day cutoff applies)', true],
    ['2026-11-30T16:59:59Z', '23:59:59 on 30 Nov: the end date is included', true],
    ['2026-11-30T17:00:00Z', '00:00:00 on 1 Dec', false],
  ])('all-day scheme: %s (%s) → %s', (utc, _label, expected) => {
    expect(isCopayAvailable(ALL_DAY, new Date(utc), 'storefront', 'pickup')).toBe(expected);
  });

  test('a one-day scheme is open on that Bangkok date only', () => {
    const oneDay: GovCopayScheme = { ...ALL_DAY, activeFrom: '2026-10-05', activeTo: '2026-10-05' };
    expect(isCopayAvailable(oneDay, new Date('2026-10-04T17:00:00Z'), 'storefront', 'pickup')).toBe(
      true,
    );
    expect(isCopayAvailable(oneDay, new Date('2026-10-05T16:59:59Z'), 'storefront', 'pickup')).toBe(
      true,
    );
    expect(isCopayAvailable(oneDay, new Date('2026-10-05T17:00:00Z'), 'storefront', 'pickup')).toBe(
      false,
    );
    expect(isCopayAvailable(oneDay, new Date('2026-10-04T16:59:59Z'), 'storefront', 'pickup')).toBe(
      false,
    );
  });

  test('the time zone is a parameter: the same instant is closed in UTC', () => {
    const t = new Date('2026-10-01T00:30:00Z'); // 07:30 in Bangkok, 00:30 in UTC
    expect(isCopayAvailable(ROUND_2, t, 'storefront', 'pickup')).toBe(true);
    expect(isCopayAvailable(ROUND_2, t, 'storefront', 'pickup', 'UTC')).toBe(false);
  });

  test('an invalid instant throws instead of answering', () => {
    expect(() => isCopayAvailable(ROUND_2, new Date(Number.NaN), 'storefront', 'pickup')).toThrow(
      RangeError,
    );
  });

  test('agrees with an independent UTC+7 calculation for random instants', () => {
    const rng = mulberry32(700);
    const start = Date.parse('2026-09-25T00:00:00Z');
    const end = Date.parse('2026-12-05T00:00:00Z');
    const dayMs = 86_400_000;
    for (let i = 0; i < 4000; i++) {
      const t = randomInt(rng, start, end);
      // Bangkok has no daylight saving, so local time is the instant plus seven hours.
      const local = t + 7 * 3_600_000;
      const date = new Date(local).toISOString().slice(0, 10);
      const secondOfDay = Math.floor((((local % dayMs) + dayMs) % dayMs) / 1000);
      const expected =
        date >= '2026-10-01' &&
        date <= '2026-11-30' &&
        secondOfDay >= 360 * 60 &&
        secondOfDay < 1380 * 60;
      expect(isCopayAvailable(ROUND_2, new Date(t), 'storefront', 'pickup')).toBe(expected);
    }
  });
});

describe('isCopayAvailable: enabled flag, channel and fulfilment', () => {
  const open = new Date('2026-10-01T04:00:00Z'); // 11:00 on 1 Oct, inside every window

  test('false when the scheme is disabled', () => {
    expect(isCopayAvailable({ ...ROUND_2, enabled: false }, open, 'storefront', 'pickup')).toBe(
      false,
    );
  });

  test('true at the storefront for counter fulfilments', () => {
    for (const f of ['dine_in', 'takeaway', 'pickup'] as const) {
      expect(isCopayAvailable(ROUND_2, open, 'storefront', f)).toBe(true);
    }
  });

  test.each(['line', 'grab', 'lineman', 'phone'] as const)(
    'false for the %s channel',
    (channel) => {
      expect(isCopayAvailable(ROUND_2, open, channel, 'pickup')).toBe(false);
    },
  );

  test.each(['room_delivery', 'platform_delivery'] as const)('false for %s', (fulfillment) => {
    expect(isCopayAvailable(ROUND_2, open, 'storefront', fulfillment)).toBe(false);
  });

  test('only dine_in, takeaway and pickup can ever be true (allow-list)', () => {
    const allowed = FULFILLMENTS.filter((f) => isCopayAvailable(ROUND_2, open, 'storefront', f));
    expect(allowed).toEqual(['dine_in', 'takeaway', 'pickup']);
  });

  test('only the storefront channel can ever be true, whatever the scheme lists', () => {
    const wide: GovCopayScheme = { ...ROUND_2, channels: [...ORDER_CHANNELS] };
    const allowed = ORDER_CHANNELS.filter((c) => isCopayAvailable(wide, open, c, 'pickup'));
    expect(allowed).toEqual(['storefront']);
  });

  test('a scheme that does not list the storefront is off everywhere', () => {
    expect(isCopayAvailable({ ...ROUND_2, channels: [] }, open, 'storefront', 'pickup')).toBe(
      false,
    );
    expect(isCopayAvailable({ ...ROUND_2, channels: ['line'] }, open, 'storefront', 'pickup')).toBe(
      false,
    );
  });
});

describe('request and response schemas', () => {
  test('split input takes only a total (the scheme comes from the server)', () => {
    expect(govCopaySplitInputSchema.parse({ total: 9500 })).toEqual({ total: 9500 });
    expect(govCopaySplitInputSchema.safeParse({ total: -1 }).success).toBe(false);
    expect(govCopaySplitInputSchema.safeParse({ total: 1.5 }).success).toBe(false);
    expect(govCopaySplitInputSchema.safeParse({ total: MAX_COPAY_TOTAL_SATANG + 1 }).success).toBe(
      false,
    );
  });

  test('split result must add up and must say it is an estimate', () => {
    const ok = { total: 9500, govShare: 5700, customerShare: 3800, capped: false, estimate: true };
    expect(govCopaySplitEstimateSchema.safeParse(ok).success).toBe(true);
    expect(govCopaySplitEstimateSchema.safeParse({ ...ok, customerShare: 3799 }).success).toBe(
      false,
    );
    expect(govCopaySplitEstimateSchema.safeParse({ ...ok, estimate: false }).success).toBe(false);
    const { estimate: _dropped, ...unlabelled } = ok;
    expect(govCopaySplitEstimateSchema.safeParse(unlabelled).success).toBe(false);
  });

  test('availability input takes a channel and a fulfilment, never a clock or a scheme', () => {
    expect(
      copayAvailabilityInputSchema.parse({ channel: 'storefront', fulfillment: 'pickup' }),
    ).toEqual({
      channel: 'storefront',
      fulfillment: 'pickup',
    });
    expect(
      copayAvailabilityInputSchema.safeParse({ channel: 'tiktok', fulfillment: 'pickup' }).success,
    ).toBe(false);
    expect(
      copayAvailabilityInputSchema.safeParse({ channel: 'storefront', fulfillment: 'teleport' })
        .success,
    ).toBe(false);
    expect(
      copayAvailabilityInputSchema.parse({
        channel: 'storefront',
        fulfillment: 'pickup',
        now: 'x',
      }),
    ).toEqual({
      channel: 'storefront',
      fulfillment: 'pickup',
    });
  });

  test('availability result', () => {
    expect(copayAvailabilityResultSchema.parse({ available: false })).toEqual({ available: false });
    expect(copayAvailabilityResultSchema.safeParse({ available: 'yes' }).success).toBe(false);
  });
});
