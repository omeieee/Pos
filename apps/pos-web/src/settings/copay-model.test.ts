import type { GovCopayDto } from '@sds/shared';
import { satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  basisPointsToPercentText,
  buildCopayInput,
  copayFormFrom,
  isStorefrontOnly,
  parsePercentText,
  validateCopayForm,
} from './copay-model.ts';

const scheme = (over: Partial<GovCopayDto> = {}): GovCopayDto => ({
  id: '0192f3a0-0000-7000-8000-000000000077',
  code: 'thai_chuay_thai_plus_2',
  nameTh: 'ไทยช่วยไทย พลัส',
  nameEn: 'Thai Chuay Thai Plus',
  settlementNote: null,
  version: 3,
  rev: 30,
  govShareBp: 6000,
  govDailyCapSatang: satang(20000),
  govTotalCapSatang: satang(100000),
  activeFrom: '2030-10-01',
  activeTo: '2030-11-30',
  activeFromMinute: 360,
  activeToMinute: 1380,
  channels: ['storefront'],
  enabled: false,
  ...over,
});

describe('percent text', () => {
  test('is read as text into basis points, with up to two decimals, never a float', () => {
    expect(parsePercentText('60')).toBe(6000);
    expect(parsePercentText(' 60.5 ')).toBe(6050);
    expect(parsePercentText('60.55')).toBe(6055);
    expect(parsePercentText('0')).toBe(0);
    expect(parsePercentText('100')).toBe(10000);
    expect(parsePercentText('0.01')).toBe(1);
  });

  test('refuses what is not a share', () => {
    for (const bad of ['', 'abc', '-1', '100.01', '101', '60.555', '6e1', '60%', '.5']) {
      expect(parsePercentText(bad), bad).toBeNull();
    }
  });

  test('writes basis points back as percent text', () => {
    expect(basisPointsToPercentText(6000)).toBe('60');
    expect(basisPointsToPercentText(6050)).toBe('60.5');
    expect(basisPointsToPercentText(6055)).toBe('60.55');
    expect(basisPointsToPercentText(1)).toBe('0.01');
    expect(basisPointsToPercentText(10000)).toBe('100');
  });
});

describe('the form', () => {
  test('fills from the saved scheme: share as percent, caps in baht, dates, hours as times', () => {
    expect(copayFormFrom(scheme({ activeToMinute: 1440 }))).toEqual({
      nameTh: 'ไทยช่วยไทย พลัส',
      nameEn: 'Thai Chuay Thai Plus',
      share: '60',
      dailyCap: '200',
      totalCap: '1000',
      activeFrom: '2030-10-01',
      activeTo: '2030-11-30',
      fromTime: '06:00',
      toTime: '24:00',
      enabled: false,
    });
  });

  test('with no scheme yet the form is blank and OFF: nothing about the scheme is assumed', () => {
    const blank = copayFormFrom(null);
    expect(blank.enabled).toBe(false);
    expect(blank.share).toBe('');
    expect(blank.activeFrom).toBe('');
    expect(blank.fromTime).toBe('');
    expect(blank.dailyCap).toBe('');
  });

  test('no cap is an empty box', () => {
    const form = copayFormFrom(scheme({ govDailyCapSatang: null, govTotalCapSatang: null }));
    expect(form.dailyCap).toBe('');
    expect(form.totalCap).toBe('');
  });
});

describe('validation', () => {
  const ok = () => copayFormFrom(scheme());
  const errors = (
    over: Partial<ReturnType<typeof ok>>,
    channels: readonly string[] = ['storefront'],
    wasEnabled = false,
  ) => validateCopayForm({ ...ok(), ...over }, { channels, wasEnabled });

  test('a good form has no errors', () => {
    expect(errors({})).toEqual([]);
  });

  test('the name, the share and the caps', () => {
    expect(errors({ nameTh: '  ' })).toEqual(['nameTh']);
    expect(errors({ share: '101' })).toEqual(['share']);
    expect(errors({ dailyCap: '12x' })).toEqual(['dailyCap']);
    expect(errors({ totalCap: '-5' })).toEqual(['totalCap']);
    expect(errors({ dailyCap: '' })).toEqual([]);
  });

  test('the end date may not be before the start; both must be real dates', () => {
    expect(errors({ activeFrom: '2030-12-01' })).toEqual(['activeTo']);
    expect(errors({ activeFrom: '2030-10-01', activeTo: '2030-10-01' })).toEqual([]);
    expect(errors({ activeFrom: '' })).toEqual(['activeFrom']);
    expect(errors({ activeTo: '2030-02-30' })).toEqual(['activeTo']);
  });

  test('the hours need a real start and end, with the end after the start; 24:00 may end the day', () => {
    expect(errors({ fromTime: '25:00' })).toEqual(['fromTime']);
    expect(errors({ toTime: '05:00' })).toEqual(['toTime']);
    expect(errors({ toTime: '24:00' })).toEqual([]);
    expect(errors({ toTime: '' })).toEqual(['toTime']);
  });

  test('turning it on needs a share above 0 and at least one channel', () => {
    expect(errors({ enabled: true, share: '0' })).toEqual(['share']);
    expect(errors({ enabled: false, share: '0' })).toEqual([]);
    expect(errors({ enabled: true }, [])).toEqual(['enabled']);
  });

  test('turning it on needs the channels to be exactly the storefront', () => {
    expect(isStorefrontOnly(['storefront'])).toBe(true);
    expect(isStorefrontOnly([])).toBe(false);
    expect(isStorefrontOnly(['storefront', 'line'])).toBe(false);
    expect(isStorefrontOnly(['line'])).toBe(false);
    expect(errors({ enabled: true }, ['storefront', 'line'])).toEqual(['enabled']);
    expect(errors({ enabled: true }, ['line'])).toEqual(['enabled']);
    // Off stays savable; a scheme already on is not blocked from saving other fields.
    expect(errors({ enabled: false }, ['storefront', 'line'])).toEqual([]);
    expect(errors({ enabled: true }, ['storefront', 'line'], true)).toEqual([]);
  });
});

describe('the save', () => {
  const base = scheme();

  test('an unchanged form sends nothing', () => {
    expect(buildCopayInput(base, 3, copayFormFrom(base))).toBeNull();
  });

  test('sends only what changed, with the version, and never the channels', () => {
    const form = { ...copayFormFrom(base), share: '55.5', toTime: '22:00', enabled: true };
    expect(buildCopayInput(base, 3, form)).toEqual({
      expectedVersion: 3,
      govShareBp: 5550,
      activeToMinute: 1320,
      enabled: true,
    });
  });

  test('a cap emptied becomes null (no cap on file) and a name emptied in English becomes null', () => {
    const form = { ...copayFormFrom(base), dailyCap: '', nameEn: '' };
    expect(buildCopayInput(base, 3, form)).toEqual({
      expectedVersion: 3,
      govDailyCapSatang: null,
      nameEn: null,
    });
  });

  test('the first save carries every field, version 0, one channel (the storefront) and is OFF unless the owner switched it on', () => {
    const form = {
      nameTh: 'ไทยช่วยไทย พลัส',
      nameEn: '',
      share: '60',
      dailyCap: '200',
      totalCap: '',
      activeFrom: '2030-10-01',
      activeTo: '2030-11-30',
      fromTime: '06:00',
      toTime: '23:00',
      enabled: false,
    };
    expect(buildCopayInput(null, 0, form)).toEqual({
      expectedVersion: 0,
      nameTh: 'ไทยช่วยไทย พลัส',
      govShareBp: 6000,
      govDailyCapSatang: 20000,
      govTotalCapSatang: null,
      activeFrom: '2030-10-01',
      activeTo: '2030-11-30',
      activeFromMinute: 360,
      activeToMinute: 1380,
      channels: ['storefront'],
      enabled: false,
    });
    expect(buildCopayInput(null, 0, { ...form, nameEn: 'Plus' })?.nameEn).toBe('Plus');
  });
});
