import {
  DEFAULT_DELIVERY_SETTINGS,
  DEFAULT_OPENING_HOURS,
  DEFAULT_SHOP_SETTINGS,
  type OpeningHours,
} from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  addBuilding,
  buildDeliveryInput,
  buildHoursPatch,
  buildNumberingPatch,
  buildPaymentsPatch,
  buildShopPatch,
  hasOtherHoursRules,
  hoursFormFrom,
  minutesToText,
  numberingFormFrom,
  parseTimeText,
  removeBuilding,
  shopFormFrom,
  validateHoursForm,
  validateNumberingForm,
  validateShopForm,
} from './model.ts';

describe('time text', () => {
  test('reads H:MM and HH:MM as minutes from midnight, and 24:00 only where a closing time may be', () => {
    expect(parseTimeText('11:00')).toBe(660);
    expect(parseTimeText('9:05')).toBe(545);
    expect(parseTimeText(' 04:00 ')).toBe(240);
    expect(parseTimeText('00:00')).toBe(0);
    expect(parseTimeText('23:59')).toBe(1439);
    expect(parseTimeText('24:00')).toBeNull();
    expect(parseTimeText('24:00', { allowMidnight: true })).toBe(1440);
    expect(parseTimeText('24:01', { allowMidnight: true })).toBeNull();
  });

  test('refuses anything that is not a time', () => {
    for (const bad of ['', '11', '11:5', '25:00', '11:60', '1100', 'ab:cd', '11:00:00', '-1:00']) {
      expect(parseTimeText(bad), bad).toBeNull();
    }
  });

  test('writes minutes back as HH:MM, 1440 as 24:00', () => {
    expect(minutesToText(660)).toBe('11:00');
    expect(minutesToText(545)).toBe('09:05');
    expect(minutesToText(0)).toBe('00:00');
    expect(minutesToText(1440)).toBe('24:00');
  });
});

describe('shop details', () => {
  const base = { ...DEFAULT_SHOP_SETTINGS, phone: '0812345678', address: null };

  test('fills the form from the saved value, empty text for none', () => {
    expect(shopFormFrom(base)).toEqual({
      nameTh: 'แซ่บโดนเส้น',
      nameEn: 'Saap Don Sen',
      phone: '0812345678',
      address: '',
    });
  });

  test('the Thai name is required; the others are optional', () => {
    const form = shopFormFrom(base);
    expect(validateShopForm({ ...form, nameTh: '  ' })).toEqual(['nameTh']);
    expect(validateShopForm({ ...form, nameEn: '', phone: '', address: '' })).toEqual([]);
  });

  test('lengths follow the shared schema', () => {
    const form = shopFormFrom(base);
    expect(validateShopForm({ ...form, nameTh: 'ก'.repeat(81) })).toEqual(['nameTh']);
    expect(validateShopForm({ ...form, phone: '1'.repeat(31) })).toEqual(['phone']);
    expect(validateShopForm({ ...form, address: 'ก'.repeat(201) })).toEqual(['address']);
  });

  test('a save sends only what changed, with the version, and blank optional text as null', () => {
    const form = shopFormFrom(base);
    expect(buildShopPatch(base, 3, form)).toBeNull();
    expect(buildShopPatch(base, 3, { ...form, phone: '' })).toEqual({
      expectedVersion: 3,
      phone: null,
    });
    expect(buildShopPatch(base, 3, { ...form, nameTh: ' ร้านใหม่ ', address: ' 1/2 ถนน ' })).toEqual({
      expectedVersion: 3,
      nameTh: 'ร้านใหม่',
      address: '1/2 ถนน',
    });
  });
});

describe('opening hours', () => {
  const hours = (over: Partial<OpeningHours> = {}): OpeningHours => ({
    ...DEFAULT_OPENING_HOURS,
    ...over,
  });

  test('fills the form: both windows as text, closed weekdays, closed dates', () => {
    const form = hoursFormFrom(
      hours({
        weekly: { mon: { storefront: null, delivery: null }, tue: { delivery: null } },
        overrides: [
          { date: '2026-10-13', closed: true, note: 'วันหยุด' },
          { date: '2026-10-20', closed: false, storefront: { openMinute: 600, closeMinute: 900 } },
        ],
      }),
    );
    expect(form.storefront).toEqual({ open: '11:00', close: '23:00' });
    expect(form.delivery).toEqual({ open: '13:00', close: '23:00' });
    // Only a weekday closed for both services is a "closed day" in this form.
    expect(form.closedDays.mon).toBe(true);
    expect(form.closedDays.tue).toBe(false);
    expect(form.closures).toEqual([{ date: '2026-10-13', note: 'วันหยุด' }]);
  });

  test('validation: both windows need a real open and close, with the close later', () => {
    const form = hoursFormFrom(hours());
    expect(validateHoursForm(hours(), form)).toEqual([]);
    expect(
      validateHoursForm(hours(), { ...form, storefront: { open: '25:00', close: '23:00' } }),
    ).toEqual(['storefront']);
    expect(
      validateHoursForm(hours(), { ...form, delivery: { open: '23:00', close: '13:00' } }),
    ).toEqual(['delivery']);
    expect(
      validateHoursForm(hours(), { ...form, storefront: { open: '11:00', close: '24:00' } }),
    ).toEqual([]);
  });

  test('validation: a closed date must be a real date, appear once, and not repeat a date that has its own hours', () => {
    const base = hours({
      overrides: [
        { date: '2026-10-20', closed: false, storefront: { openMinute: 600, closeMinute: 900 } },
      ],
    });
    const form = hoursFormFrom(base);
    const errors = (closures: { date: string; note: string }[]) =>
      validateHoursForm(base, { ...form, closures });
    expect(errors([{ date: '2026-10-13', note: '' }])).toEqual([]);
    expect(errors([{ date: '', note: '' }])).toEqual(['closure:0']);
    expect(errors([{ date: '2026-02-30', note: '' }])).toEqual(['closure:0']);
    expect(
      errors([
        { date: '2026-10-13', note: '' },
        { date: '2026-10-13', note: '' },
      ]),
    ).toEqual(['closure:1']);
    expect(errors([{ date: '2026-10-20', note: '' }])).toEqual(['closure:0']);
  });

  test('says when the saved hours hold rules this form does not show', () => {
    expect(hasOtherHoursRules(hours())).toBe(false);
    expect(
      hasOtherHoursRules(hours({ weekly: { mon: { storefront: null, delivery: null } } })),
    ).toBe(false);
    expect(hasOtherHoursRules(hours({ weekly: { tue: { delivery: null } } }))).toBe(true);
    expect(
      hasOtherHoursRules(
        hours({ overrides: [{ date: '2026-10-20', closed: false, delivery: null }] }),
      ),
    ).toBe(true);
    expect(hasOtherHoursRules(hours({ overrides: [{ date: '2026-10-13', closed: true }] }))).toBe(
      false,
    );
  });

  test('nothing changed sends nothing', () => {
    expect(buildHoursPatch(hours(), 2, hoursFormFrom(hours()))).toBeNull();
  });

  test('a changed window is sent alone', () => {
    const form = hoursFormFrom(hours());
    expect(
      buildHoursPatch(hours(), 2, { ...form, storefront: { open: '10:30', close: '22:00' } }),
    ).toEqual({
      expectedVersion: 2,
      storefront: { openMinute: 630, closeMinute: 1320 },
    });
  });

  test('closing a weekday sends the whole weekly map and keeps the rules this form does not show', () => {
    const base = hours({ weekly: { tue: { delivery: { openMinute: 900, closeMinute: 1200 } } } });
    const form = hoursFormFrom(base);
    const patch = buildHoursPatch(base, 2, {
      ...form,
      closedDays: { ...form.closedDays, mon: true },
    });
    expect(patch).toEqual({
      expectedVersion: 2,
      weekly: {
        mon: { storefront: null, delivery: null },
        tue: { delivery: { openMinute: 900, closeMinute: 1200 } },
      },
    });
  });

  test('re-opening a closed weekday removes only its closed rule', () => {
    const base = hours({
      weekly: {
        mon: { storefront: null, delivery: null },
        wed: { storefront: null, delivery: null },
        thu: { storefront: { openMinute: 600, closeMinute: 800 }, delivery: null },
      },
    });
    const form = hoursFormFrom(base);
    expect(form.closedDays.thu).toBe(false);
    const patch = buildHoursPatch(base, 5, {
      ...form,
      closedDays: { ...form.closedDays, mon: false },
    });
    expect(patch).toEqual({
      expectedVersion: 5,
      weekly: {
        wed: { storefront: null, delivery: null },
        thu: { storefront: { openMinute: 600, closeMinute: 800 }, delivery: null },
      },
    });
  });

  test('closed dates are replaced as a whole but keep the dates that have their own hours, in order', () => {
    const base = hours({
      overrides: [
        { date: '2026-10-13', closed: true, note: 'วันหยุด' },
        { date: '2026-10-20', closed: false, storefront: { openMinute: 600, closeMinute: 900 } },
      ],
    });
    const form = hoursFormFrom(base);
    const patch = buildHoursPatch(base, 4, {
      ...form,
      closures: [
        { date: '2026-10-14', note: '  ' },
        { date: '2026-10-13', note: 'วันหยุด' },
      ],
    });
    expect(patch).toEqual({
      expectedVersion: 4,
      overrides: [
        { date: '2026-10-13', closed: true, note: 'วันหยุด' },
        { date: '2026-10-20', closed: false, storefront: { openMinute: 600, closeMinute: 900 } },
        { date: '2026-10-14', closed: true },
      ],
    });
  });

  test('removing every closed date keeps the others; leaving them as they are sends nothing', () => {
    const base = hours({
      overrides: [
        { date: '2026-10-13', closed: true },
        { date: '2026-10-20', closed: false, delivery: null },
      ],
    });
    const form = hoursFormFrom(base);
    expect(buildHoursPatch(base, 1, form)).toBeNull();
    expect(buildHoursPatch(base, 1, { ...form, closures: [] })).toEqual({
      expectedVersion: 1,
      overrides: [{ date: '2026-10-20', closed: false, delivery: null }],
    });
  });
});

describe('numbering and the business day', () => {
  const base = { cutoffMinutes: 240, timeZone: 'Asia/Bangkok' };

  test('the cutoff is shown as a time and may be 00:00 to 23:59, never 24:00', () => {
    expect(numberingFormFrom(base)).toEqual({ cutoff: '04:00' });
    expect(validateNumberingForm({ cutoff: '04:00' })).toEqual([]);
    expect(validateNumberingForm({ cutoff: '00:00' })).toEqual([]);
    expect(validateNumberingForm({ cutoff: '24:00' })).toEqual(['cutoff']);
    expect(validateNumberingForm({ cutoff: '4' })).toEqual(['cutoff']);
  });

  test('a save sends only the cutoff, and only when it changed', () => {
    expect(buildNumberingPatch(base, 2, { cutoff: '04:00' })).toBeNull();
    expect(buildNumberingPatch(base, 2, { cutoff: '05:30' })).toEqual({
      expectedVersion: 2,
      cutoffMinutes: 330,
    });
  });
});

describe('payment methods', () => {
  const base = { cash: true, promptpay: true, platform: true, other: false };

  test('sends only the switches that changed', () => {
    expect(buildPaymentsPatch(base, 1, base)).toBeNull();
    expect(buildPaymentsPatch(base, 1, { ...base, other: true, cash: false })).toEqual({
      expectedVersion: 1,
      cash: false,
      other: true,
    });
  });
});

describe('delivery buildings', () => {
  const list = ['A1', 'B2'];

  test('adds a trimmed name at the end', () => {
    expect(addBuilding(list, ' C3 ')).toEqual({ ok: true, list: ['A1', 'B2', 'C3'] });
  });

  test('refuses an empty name, a name over 10 characters, a repeat (ignoring case) and a 31st building', () => {
    expect(addBuilding(list, '   ')).toEqual({ ok: false, error: 'empty' });
    expect(addBuilding(list, 'ABCDEFGHIJK')).toEqual({ ok: false, error: 'tooLong' });
    expect(addBuilding(list, 'a1')).toEqual({ ok: false, error: 'duplicate' });
    const full = Array.from({ length: 30 }, (_, i) => `T${i + 1}`);
    expect(addBuilding(full, 'Z9')).toEqual({ ok: false, error: 'full' });
  });

  test('removes one, but never the last (an order must name a building)', () => {
    expect(removeBuilding(list, 'A1')).toEqual({ ok: true, list: ['B2'] });
    expect(removeBuilding(['A1'], 'A1')).toEqual({ ok: false, error: 'last' });
  });

  test('a save replaces the whole list with the version, and sends nothing when unchanged', () => {
    expect(buildDeliveryInput({ buildings: list }, 2, list)).toBeNull();
    expect(buildDeliveryInput({ buildings: list }, 2, ['B2', 'A1'])).toEqual({
      expectedVersion: 2,
      buildings: ['B2', 'A1'],
    });
    expect(DEFAULT_DELIVERY_SETTINGS.buildings.length).toBeGreaterThan(0);
  });
});
