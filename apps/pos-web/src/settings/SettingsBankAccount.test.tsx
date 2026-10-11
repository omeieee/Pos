// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { type SettingsOverrides, settingAnswer } from '../test-support/settings-env.ts';
import { buildBankAccountPatch, validateBankAccountForm } from './bank-account-model.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';
import { hubEntries } from './sections.ts';

afterEach(cleanup);
const tr = translator('th');

// Made-up numbers only. The API answers masked values; the full number is only ever typed here.
const NUMBER = '5550123456';
const NONE = { bankCode: null, accountMasked: null, configured: false } as const;
const SAVED = { bankCode: '014', accountMasked: '******3456', configured: true } as const;

async function open(role: StaffRole = 'owner', settingsApi: SettingsOverrides = {}) {
  const { auth } = await createTestAuth(role);
  if (role === 'owner') {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({ auth, settingsApi });
  renderScreen(<SettingsSectionScreen section="bank-account" />, env.services);
  return env;
}

describe('the receiving bank account section', () => {
  test('nothing saved: says so, and it is optional', async () => {
    await open('owner', { bankAccount: { read: async () => settingAnswer(NONE, 0) } });
    expect(await screen.findByText(tr('settings.bankAccount.none'))).toBeTruthy();
  });

  test('a saved account is shown masked with the bank name, never the full number', async () => {
    await open('owner', { bankAccount: { read: async () => settingAnswer(SAVED, 2) } });
    const shown = await screen.findByText(
      tr('settings.bankAccount.shownBank', {
        bank: tr('settings.bankAccount.bankName.014'),
        masked: '******3456',
      }),
    );
    expect(shown).toBeTruthy();
    // The number field starts empty: the saved number is not put back into the form.
    expect(
      (screen.getByLabelText(tr('settings.bankAccount.number')) as HTMLInputElement).value,
    ).toBe('');
  });

  test('the owner picks a bank and types the number; one save sends both with the version', async () => {
    const env = await open('owner', {
      bankAccount: {
        read: async () => settingAnswer(NONE, 0),
        save: async () => settingAnswer(SAVED, 1),
      },
    });
    fireEvent.change(await screen.findByLabelText(tr('settings.bankAccount.bank')), {
      target: { value: '014' },
    });
    fireEvent.change(screen.getByLabelText(tr('settings.bankAccount.number')), {
      target: { value: '555-0-12345-6' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    await waitFor(() => expect(env.settingsApi.bankAccount.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.bankAccount.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      bankCode: '014',
      accountNumber: NUMBER,
    });
  });

  test('a number that is not 10 to 15 digits is refused before any save', async () => {
    const env = await open('owner', { bankAccount: { read: async () => settingAnswer(NONE, 0) } });
    fireEvent.change(await screen.findByLabelText(tr('settings.bankAccount.number')), {
      target: { value: '12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    expect(await screen.findByText(tr('settings.bankAccount.error.accountNumber'))).toBeTruthy();
    expect(env.settingsApi.bankAccount.save).not.toHaveBeenCalled();
  });

  test('"remove" clears the number and the bank in one save', async () => {
    const env = await open('owner', {
      bankAccount: {
        read: async () => settingAnswer(SAVED, 2),
        save: async () => settingAnswer(NONE, 3),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: tr('settings.bankAccount.clear') }));
    await waitFor(() => expect(env.settingsApi.bankAccount.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.bankAccount.save).toHaveBeenCalledWith({
      expectedVersion: 2,
      bankCode: null,
      accountNumber: null,
    });
  });

  test('other roles do not get the page', async () => {
    await open('manager');
    expect(await screen.findByText(tr('settings.notFound'))).toBeTruthy();
    expect(screen.queryByLabelText(tr('settings.bankAccount.number'))).toBeNull();
  });
});

describe('bank account form rules', () => {
  const base = { bankCode: '014', accountMasked: '******3456', configured: true } as const;

  test('an empty number keeps the saved one; nothing changed sends nothing', () => {
    expect(buildBankAccountPatch(base, 2, { bankCode: '014', accountNumber: '' })).toBeNull();
    expect(buildBankAccountPatch(base, 2, { bankCode: '004', accountNumber: '' })).toEqual({
      expectedVersion: 2,
      bankCode: '004',
    });
    expect(buildBankAccountPatch(base, 2, { bankCode: '', accountNumber: '' })).toEqual({
      expectedVersion: 2,
      bankCode: null,
    });
  });

  test('hyphens and spaces are dropped from the number', () => {
    expect(
      buildBankAccountPatch(base, 2, { bankCode: '014', accountNumber: '555 0-12345 6' }),
    ).toEqual({ expectedVersion: 2, accountNumber: NUMBER });
  });

  test('validation: blank is fine, 10 to 15 digits only', () => {
    expect(validateBankAccountForm({ bankCode: '', accountNumber: '' })).toEqual([]);
    expect(validateBankAccountForm({ bankCode: '', accountNumber: NUMBER })).toEqual([]);
    for (const bad of ['123456789', '1234567890123456', 'abcdefghij', '5550-1234-5x']) {
      expect(validateBankAccountForm({ bankCode: '', accountNumber: bad }), bad).toEqual([
        'accountNumber',
      ]);
    }
  });

  test('only the owner sees the section in the hub and may change it', () => {
    const entry = (permissions: Parameters<typeof hubEntries>[0]) =>
      hubEntries(permissions).find((e) => e.section.id === 'bank-account');
    expect(entry(['settings.view'])).toBeUndefined();
    expect(entry(['settings.view', 'settings.edit'])).toBeUndefined();
    expect(entry(['settings.view', 'settings.bank_account'])?.canEdit).toBe(true);
  });
});
