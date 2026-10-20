import { describe, expect, test } from 'vitest';
import { govCopaySchemeSchema } from './gov-copay.ts';
import {
  bankAccountPatchInputSchema,
  bankAccountSettingsSchema,
  bankAccountViewSchema,
  CASH_OPENING_MAX_YEARS_BACK,
  cashOpeningEarliest,
  cashOpeningPatchInputSchema,
  cashOpeningSettingsSchema,
  DEFAULT_BANK_ACCOUNT,
  DEFAULT_CASH_OPENING,
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_LINE_ORDERING,
  DEFAULT_PLATFORM_COMMISSION,
  deliveryPatchInputSchema,
  deliverySettingsSchema,
  govCopayPatchInputSchema,
  lineOrderingOpenAt,
  lineOrderingPatchInputSchema,
  lineOrderingSchema,
  maskBankAccount,
  maskPromptpayId,
  numberingPatchInputSchema,
  openingHoursPatchInputSchema,
  openingHoursSchema,
  openingWindow,
  paymentsSettingsSchema,
  platformCommissionPatchInputSchema,
  platformCommissionSettingsSchema,
  promptpayPatchInputSchema,
  serviceOpenAt,
  shopPatchInputSchema,
  shopSettingsSchema,
} from './settings.ts';

describe('shop profile', () => {
  test('reads the seeded shape (names only) and fills the rest with null', () => {
    expect(shopSettingsSchema.parse({ nameTh: 'แซ่บโดนเส้น', nameEn: 'Saap Don Sen' })).toEqual({
      nameTh: 'แซ่บโดนเส้น',
      nameEn: 'Saap Don Sen',
      phone: null,
      address: null,
    });
  });

  test('a patch needs the version and at least one field, and refuses unknown ones', () => {
    expect(
      shopPatchInputSchema.safeParse({ expectedVersion: 1, phone: '0812345678' }).success,
    ).toBe(true);
    expect(shopPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(shopPatchInputSchema.safeParse({ phone: '0812345678' }).success).toBe(false);
    expect(
      shopPatchInputSchema.safeParse({ expectedVersion: 1, nameTh: 'x', logo: 'y' }).success,
    ).toBe(false);
    expect(shopPatchInputSchema.safeParse({ expectedVersion: 1, nameTh: '  ' }).success).toBe(
      false,
    );
  });

  test('version 0 means "never saved yet"', () => {
    expect(shopPatchInputSchema.safeParse({ expectedVersion: 0, nameTh: 'ร้าน' }).success).toBe(
      true,
    );
    expect(shopPatchInputSchema.safeParse({ expectedVersion: -1, nameTh: 'ร้าน' }).success).toBe(
      false,
    );
  });
});

describe('opening hours', () => {
  const seeded = {
    storefront: { openMinute: 660, closeMinute: 1380 },
    delivery: { openMinute: 780, closeMinute: 1380 },
    overrides: [],
  };

  test('accepts the seeded value', () => {
    expect(openingHoursSchema.safeParse(seeded).success).toBe(true);
  });

  test('a window must open before it closes and stay within the day', () => {
    for (const bad of [
      { openMinute: 700, closeMinute: 700 },
      { openMinute: 800, closeMinute: 700 },
      { openMinute: -1, closeMinute: 700 },
      { openMinute: 600, closeMinute: 1441 },
      { openMinute: 1440, closeMinute: 1440 },
    ]) {
      expect(
        openingHoursSchema.safeParse({ ...seeded, storefront: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  test('refuses two overrides for the same date, and a malformed date', () => {
    const o = { date: '2026-12-31', closed: true };
    expect(openingHoursSchema.safeParse({ ...seeded, overrides: [o, o] }).success).toBe(false);
    expect(
      openingHoursSchema.safeParse({ ...seeded, overrides: [{ date: '31/12/2026' }] }).success,
    ).toBe(false);
  });

  const hours = openingHoursSchema.parse({
    ...seeded,
    weekly: {
      sun: { storefront: { openMinute: 720, closeMinute: 1200 }, delivery: null },
      mon: { storefront: null },
    },
    overrides: [
      { date: '2026-12-31', closed: true, note: 'ปีใหม่' },
      { date: '2026-12-25', storefront: { openMinute: 600, closeMinute: 900 } },
    ],
  });

  test('openingWindow: the default applies on an ordinary day (2026-10-07 is a Wednesday)', () => {
    expect(openingWindow(hours, '2026-10-07', 'storefront')).toEqual({
      openMinute: 660,
      closeMinute: 1380,
    });
    expect(openingWindow(hours, '2026-10-07', 'delivery')).toEqual({
      openMinute: 780,
      closeMinute: 1380,
    });
  });

  test('openingWindow: a weekday rule replaces the default for that service only (2026-10-04 is a Sunday)', () => {
    expect(openingWindow(hours, '2026-10-04', 'storefront')).toEqual({
      openMinute: 720,
      closeMinute: 1200,
    });
    expect(openingWindow(hours, '2026-10-04', 'delivery')).toBeNull();
    // Monday: storefront closed, delivery as default.
    expect(openingWindow(hours, '2026-10-05', 'storefront')).toBeNull();
    expect(openingWindow(hours, '2026-10-05', 'delivery')).toEqual({
      openMinute: 780,
      closeMinute: 1380,
    });
  });

  test('openingWindow: a date override beats the weekday rule; closed closes both services', () => {
    expect(openingWindow(hours, '2026-12-31', 'storefront')).toBeNull();
    expect(openingWindow(hours, '2026-12-31', 'delivery')).toBeNull();
    // 2026-12-25 is a Friday: storefront overridden, delivery falls back to the default.
    expect(openingWindow(hours, '2026-12-25', 'storefront')).toEqual({
      openMinute: 600,
      closeMinute: 900,
    });
    expect(openingWindow(hours, '2026-12-25', 'delivery')).toEqual({
      openMinute: 780,
      closeMinute: 1380,
    });
  });

  test('serviceOpenAt: the wall clock in Bangkok decides, opening included and closing excluded', () => {
    // Wednesday 2026-10-07, delivery 13:00 to 23:00 Bangkok (06:00 to 16:00 UTC).
    const at = (utc: string) => serviceOpenAt(hours, new Date(utc), 'delivery');
    expect(at('2026-10-07T05:59:00Z').open).toBe(false); // 12:59
    expect(at('2026-10-07T06:00:00Z').open).toBe(true); // 13:00
    expect(at('2026-10-07T15:59:00Z').open).toBe(true); // 22:59
    expect(at('2026-10-07T16:00:00Z').open).toBe(false); // 23:00
    expect(at('2026-10-07T06:00:00Z').window).toEqual({ openMinute: 780, closeMinute: 1380 });
  });

  test('serviceOpenAt: the calendar day is the wall clock day, not the business day', () => {
    // 00:30 Bangkok on Thursday 2026-10-08 is still Wednesday's business day, but it is Thursday
    // on the wall clock, where delivery has not opened yet.
    expect(serviceOpenAt(hours, new Date('2026-10-07T17:30:00Z'), 'delivery').open).toBe(false);
    // A day with no window is closed all day (Sunday 2026-10-04 has no delivery).
    expect(serviceOpenAt(hours, new Date('2026-10-04T08:00:00Z'), 'delivery')).toEqual({
      open: false,
      window: null,
    });
    // A closure override closes everything.
    expect(serviceOpenAt(hours, new Date('2026-12-31T08:00:00Z'), 'storefront').open).toBe(false);
  });

  test('a patch replaces whichever top-level parts it names', () => {
    expect(
      openingHoursPatchInputSchema.safeParse({ expectedVersion: 2, overrides: [] }).success,
    ).toBe(true);
    expect(openingHoursPatchInputSchema.safeParse({ expectedVersion: 2 }).success).toBe(false);
  });
});

describe('numbering (business day)', () => {
  test('cutoff in minutes and a known time zone', () => {
    expect(
      numberingPatchInputSchema.safeParse({ expectedVersion: 1, cutoffMinutes: 240 }).success,
    ).toBe(true);
    expect(
      numberingPatchInputSchema.safeParse({ expectedVersion: 1, cutoffMinutes: 1440 }).success,
    ).toBe(false);
    expect(
      numberingPatchInputSchema.safeParse({ expectedVersion: 1, timeZone: 'Mars/Base' }).success,
    ).toBe(false);
    expect(numberingPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });
});

describe('payment methods', () => {
  test('cash and PromptPay are on by default, "other" is off', () => {
    expect(paymentsSettingsSchema.parse({})).toEqual({
      cash: true,
      promptpay: true,
      platform: true,
      other: false,
    });
  });
});

describe('PromptPay ID', () => {
  test('a patch carries the ID type and value and the version', () => {
    expect(
      promptpayPatchInputSchema.safeParse({
        expectedVersion: 1,
        idType: 'phone',
        idValue: '0812345678',
      }).success,
    ).toBe(true);
    expect(
      promptpayPatchInputSchema.safeParse({
        expectedVersion: 1,
        idType: 'national_id',
        idValue: '1234567890123',
      }).success,
    ).toBe(true);
  });

  test('refuses a wrong length, letters, separators and a missing version', () => {
    for (const body of [
      { expectedVersion: 1, idType: 'phone', idValue: '812345678' },
      { expectedVersion: 1, idType: 'phone', idValue: '081-234-5678' },
      { expectedVersion: 1, idType: 'national_id', idValue: '123456789012' },
      { expectedVersion: 1, idType: 'national_id', idValue: '12345678901ab' },
      { idType: 'phone', idValue: '0812345678' },
    ]) {
      expect(promptpayPatchInputSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  test('masking keeps only the last four digits, whatever the type', () => {
    expect(maskPromptpayId('0812345678')).toBe('******5678');
    expect(maskPromptpayId('1234567890123')).toBe('*********0123');
    expect(maskPromptpayId('12')).toBe('**');
    expect(maskPromptpayId('0812345678')).not.toContain('08123');
  });
});

describe('gov co-pay patch', () => {
  test('any scheme field may change, with the version; nothing else', () => {
    expect(govCopayPatchInputSchema.safeParse({ expectedVersion: 1, enabled: true }).success).toBe(
      true,
    );
    expect(
      govCopayPatchInputSchema.safeParse({
        expectedVersion: 1,
        activeFromMinute: 360,
        activeToMinute: 1380,
      }).success,
    ).toBe(true);
    expect(govCopayPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      govCopayPatchInputSchema.safeParse({ expectedVersion: 1, enabled: true, id: 'x' }).success,
    ).toBe(false);
    expect(
      govCopayPatchInputSchema.safeParse({ expectedVersion: 1, govShareBp: 10001 }).success,
    ).toBe(false);
  });

  test('a scheme built from a patch still passes the shared scheme rules', () => {
    const scheme = {
      govShareBp: 6000,
      govDailyCapSatang: 20000,
      govTotalCapSatang: 100000,
      activeFrom: '2026-10-01',
      activeTo: '2026-11-30',
      activeFromMinute: 360,
      activeToMinute: 1380,
      channels: ['storefront'],
      enabled: true,
    };
    expect(govCopaySchemeSchema.safeParse(scheme).success).toBe(true);
    expect(govCopaySchemeSchema.safeParse({ ...scheme, activeFrom: '2026-12-01' }).success).toBe(
      false,
    );
    expect(
      govCopaySchemeSchema.safeParse({ ...scheme, activeFromMinute: 1380, activeToMinute: 360 })
        .success,
    ).toBe(false);
  });
});

describe('delivery buildings (settings.delivery)', () => {
  test('the default is the eight buildings the owner named', () => {
    expect(DEFAULT_DELIVERY_SETTINGS).toEqual({
      buildings: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'],
    });
    expect(deliverySettingsSchema.safeParse(DEFAULT_DELIVERY_SETTINGS).success).toBe(true);
  });

  test('names are trimmed; 1 to 30 items; each 1 to 10 characters', () => {
    expect(deliverySettingsSchema.parse({ buildings: ['  A1 ', 'B1'] }).buildings).toEqual([
      'A1',
      'B1',
    ]);
    const names = (n: number) => Array.from({ length: n }, (_, i) => `T${i + 1}`);
    expect(deliverySettingsSchema.safeParse({ buildings: names(30) }).success).toBe(true);
    expect(deliverySettingsSchema.safeParse({ buildings: names(31) }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ buildings: [] }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ buildings: ['   '] }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ buildings: ['A234567890'] }).success).toBe(true);
    expect(deliverySettingsSchema.safeParse({ buildings: ['A2345678901'] }).success).toBe(false);
  });

  test('names are unique, ignoring case and surrounding spaces', () => {
    expect(deliverySettingsSchema.safeParse({ buildings: ['A1', 'A1'] }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ buildings: ['A1', ' a1 '] }).success).toBe(false);
    expect(deliverySettingsSchema.safeParse({ buildings: ['A1', 'A2'] }).success).toBe(true);
  });

  test('a change carries the version and the whole list, and nothing else', () => {
    expect(
      deliveryPatchInputSchema.safeParse({ expectedVersion: 0, buildings: ['A1'] }).success,
    ).toBe(true);
    expect(deliveryPatchInputSchema.safeParse({ buildings: ['A1'] }).success).toBe(false);
    expect(deliveryPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      deliveryPatchInputSchema.safeParse({ expectedVersion: 1, buildings: ['A1'], fee: 0 }).success,
    ).toBe(false);
    expect(deliveryPatchInputSchema.safeParse({ expectedVersion: 1, buildings: [] }).success).toBe(
      false,
    );
  });
});

describe('LINE ordering switch', () => {
  const hours = openingHoursSchema.parse({
    storefront: { openMinute: 660, closeMinute: 1380 },
    delivery: { openMinute: 780, closeMinute: 1380 },
  });
  // 2026-10-07 in Bangkok (UTC+7): 03:00, 12:00 (before delivery opens at 13:00), 15:00.
  const night = new Date('2026-10-06T20:00:00Z');
  const noon = new Date('2026-10-07T05:00:00Z');
  const afternoon = new Date('2026-10-07T08:00:00Z');

  test('a never-saved setting follows the delivery hours, as LINE ordering did before it existed', () => {
    expect(DEFAULT_LINE_ORDERING).toEqual({ mode: 'scheduled' });
    expect(lineOrderingSchema.parse({})).toEqual({ mode: 'scheduled' });
  });

  test('scheduled gives exactly what the delivery hours give', () => {
    for (const at of [night, noon, afternoon]) {
      const expected = serviceOpenAt(hours, at, 'delivery');
      expect(lineOrderingOpenAt('scheduled', hours, at)).toEqual({
        ...expected,
        mode: 'scheduled',
      });
    }
  });

  test('open takes orders at any time, with no window to show', () => {
    expect(lineOrderingOpenAt('open', hours, night)).toEqual({
      open: true,
      window: null,
      mode: 'open',
    });
    expect(lineOrderingOpenAt('open', hours, noon).open).toBe(true);
  });

  test('closed takes no orders, even inside the delivery hours', () => {
    expect(lineOrderingOpenAt('closed', hours, afternoon)).toEqual({
      open: false,
      window: null,
      mode: 'closed',
    });
  });

  test('a patch needs the version and a known mode', () => {
    expect(
      lineOrderingPatchInputSchema.safeParse({ expectedVersion: 0, mode: 'open' }).success,
    ).toBe(true);
    expect(lineOrderingPatchInputSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(lineOrderingPatchInputSchema.safeParse({ expectedVersion: 0, mode: 'x' }).success).toBe(
      false,
    );
    expect(lineOrderingPatchInputSchema.safeParse({ mode: 'open' }).success).toBe(false);
  });
});

describe('shop receiving bank account (fake numbers only)', () => {
  test('digits only, 10 to 15 of them; the bank code is optional and from a small list', () => {
    expect(bankAccountSettingsSchema.parse({ accountNumber: '1234567890' })).toEqual({
      bankCode: null,
      accountNumber: '1234567890',
    });
    expect(
      bankAccountSettingsSchema.parse({ bankCode: '004', accountNumber: '123456789012345' }),
    ).toEqual({
      bankCode: '004',
      accountNumber: '123456789012345',
    });
    for (const bad of [
      '123456789',
      '1234567890123456',
      '123-4-56789-0',
      '12345 67890',
      'abcdefghij',
      '',
    ]) {
      expect(bankAccountSettingsSchema.safeParse({ accountNumber: bad }).success, bad).toBe(false);
    }
    expect(
      bankAccountSettingsSchema.safeParse({ bankCode: '999', accountNumber: '1234567890' }).success,
    ).toBe(false);
  });
  test('the default is nothing saved', () => {
    expect(bankAccountSettingsSchema.parse({})).toEqual(DEFAULT_BANK_ACCOUNT);
    expect(DEFAULT_BANK_ACCOUNT).toEqual({ bankCode: null, accountNumber: null });
  });
  test('a patch carries the version and at least one field; null clears', () => {
    expect(bankAccountPatchInputSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(
      bankAccountPatchInputSchema.safeParse({ expectedVersion: 1, accountNumber: null }).success,
    ).toBe(true);
    expect(
      bankAccountPatchInputSchema.safeParse({ expectedVersion: 1, bankCode: null }).success,
    ).toBe(true);
    expect(
      bankAccountPatchInputSchema.safeParse({ expectedVersion: 1, accountNumber: '12' }).success,
    ).toBe(false);
    expect(
      bankAccountPatchInputSchema.safeParse({
        expectedVersion: 1,
        extra: 1,
        accountNumber: '1234567890',
      }).success,
    ).toBe(false);
  });
  test('the masked form keeps only the last four digits', () => {
    expect(maskBankAccount('1234567890')).toBe('******7890');
    expect(maskBankAccount('123456789012345')).toBe('***********2345');
  });
  test('the view never has room for the full number', () => {
    const view = bankAccountViewSchema.parse({
      bankCode: '014',
      accountMasked: '******7890',
      configured: true,
    });
    expect(Object.keys(view).sort()).toEqual(['accountMasked', 'bankCode', 'configured']);
    expect(
      bankAccountViewSchema.parse({
        bankCode: '014',
        accountMasked: '******7890',
        configured: true,
        accountNumber: '1234567890',
      }),
    ).not.toHaveProperty('accountNumber');
  });
});

describe('platform commission', () => {
  test('nothing is set by default: no built-in rate', () => {
    expect(DEFAULT_PLATFORM_COMMISSION).toEqual({ grabRateBp: null, linemanRateBp: null });
    expect(platformCommissionSettingsSchema.parse({})).toEqual(DEFAULT_PLATFORM_COMMISSION);
  });
  test('a rate is whole basis points from 0 to 10000, or null to clear it', () => {
    for (const grabRateBp of [0, 900, 10000, null]) {
      expect(
        platformCommissionPatchInputSchema.safeParse({ expectedVersion: 0, grabRateBp }).success,
        String(grabRateBp),
      ).toBe(true);
    }
    for (const grabRateBp of [-1, 10001, 9.5, '9%']) {
      expect(
        platformCommissionPatchInputSchema.safeParse({ expectedVersion: 0, grabRateBp }).success,
        String(grabRateBp),
      ).toBe(false);
    }
  });
  test('a patch changes something and takes no other keys', () => {
    expect(platformCommissionPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(
      false,
    );
    expect(
      platformCommissionPatchInputSchema.safeParse({ expectedVersion: 1, phoneRateBp: 5 }).success,
    ).toBe(false);
  });
});

describe('cash opening (D-35)', () => {
  test('nothing is set by default: no opening amount, never 0', () => {
    expect(DEFAULT_CASH_OPENING).toEqual({ amountSatang: null, asOf: null });
    expect(cashOpeningSettingsSchema.parse({})).toEqual(DEFAULT_CASH_OPENING);
  });
  test('the amount and the date are set together or both cleared', () => {
    expect(
      cashOpeningSettingsSchema.safeParse({ amountSatang: 50000, asOf: '2026-09-24' }).success,
    ).toBe(true);
    expect(
      cashOpeningSettingsSchema.safeParse({ amountSatang: 0, asOf: '2026-09-24' }).success,
    ).toBe(true);
    expect(cashOpeningSettingsSchema.safeParse({ amountSatang: 50000, asOf: null }).success).toBe(
      false,
    );
    expect(
      cashOpeningSettingsSchema.safeParse({ amountSatang: null, asOf: '2026-09-24' }).success,
    ).toBe(false);
  });
  test('whole non-negative satang and an ISO date only', () => {
    for (const amountSatang of [-1, 1.5, '500']) {
      expect(
        cashOpeningSettingsSchema.safeParse({ amountSatang, asOf: '2026-09-24' }).success,
        String(amountSatang),
      ).toBe(false);
    }
    expect(
      cashOpeningSettingsSchema.safeParse({ amountSatang: 1, asOf: '24/09/2026' }).success,
    ).toBe(false);
  });
  test('a patch names the version, changes something and takes no other keys', () => {
    expect(
      cashOpeningPatchInputSchema.safeParse({
        expectedVersion: 0,
        amountSatang: 100,
        asOf: '2026-10-01',
      }).success,
    ).toBe(true);
    expect(cashOpeningPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(cashOpeningPatchInputSchema.safeParse({ expectedVersion: 1, note: 'x' }).success).toBe(
      false,
    );
  });
  test('the start date may not be more than 10 years before today (the report adds it up window by window)', () => {
    expect(CASH_OPENING_MAX_YEARS_BACK).toBe(10);
    expect(cashOpeningEarliest('2026-10-21')).toBe('2016-10-21');
    // 29 February has no twin ten years back in a non-leap year: the 28th is the limit
    expect(cashOpeningEarliest('2028-02-29')).toBe('2018-02-28');
    expect(cashOpeningEarliest('2026-10-21') <= '2016-10-21').toBe(true);
    expect('2016-10-20' < cashOpeningEarliest('2026-10-21')).toBe(true);
  });
});
