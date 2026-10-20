import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { buildOpeningBody, openingFormFrom, validateOpeningForm } from './cash-model.ts';

describe('the opening cash form', () => {
  test('starts empty when nothing is set, and from the saved amount and date when it is', () => {
    expect(openingFormFrom({ amountSatang: null, asOf: null }, '2026-10-21')).toEqual({
      amount: '',
      asOf: '2026-10-21',
    });
    expect(
      openingFormFrom({ amountSatang: satang(50050), asOf: '2026-09-24' }, '2026-10-21'),
    ).toEqual({
      amount: '500.50',
      asOf: '2026-09-24',
    });
  });

  test('needs an amount of 0 or more and a date', () => {
    expect(validateOpeningForm({ amount: '500', asOf: '2026-09-24' })).toEqual([]);
    expect(validateOpeningForm({ amount: '0', asOf: '2026-09-24' })).toEqual([]);
    expect(validateOpeningForm({ amount: '', asOf: '2026-09-24' })).toEqual(['amount']);
    expect(validateOpeningForm({ amount: '-5', asOf: '2026-09-24' })).toEqual(['amount']);
    expect(validateOpeningForm({ amount: 'abc', asOf: '2026-09-24' })).toEqual(['amount']);
    expect(validateOpeningForm({ amount: '5', asOf: '' })).toEqual(['asOf']);
  });

  test('the body is whole satang from the typed baht, with the version the screen saw', () => {
    expect(buildOpeningBody({ amount: '1,250.75', asOf: '2026-09-24' }, 3)).toEqual({
      expectedVersion: 3,
      amountSatang: 125075,
      asOf: '2026-09-24',
    });
    expect(buildOpeningBody({ amount: '12.345', asOf: '2026-09-24' }, 0)).toBeNull();
  });
});
