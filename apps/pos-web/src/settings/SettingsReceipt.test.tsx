// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { type SettingsOverrides, settingAnswer } from '../test-support/settings-env.ts';
import { buildReceiptPatch, validateReceiptForm } from './receipt-model.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';
import { hubEntries } from './sections.ts';

afterEach(cleanup);
const tr = translator('th');

// Made-up IDs: 1234567890121 has a valid check digit, 1234567890122 does not.
const VALID = '1234567890121';
const BAD = '1234567890122';

async function open(role: StaffRole = 'owner', settingsApi: SettingsOverrides = {}) {
  const { auth } = await createTestAuth(role);
  if (role === 'owner') {
    await auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });
  }
  const env = createTestServices({ auth, settingsApi });
  renderScreen(<SettingsSectionScreen section="receipt" />, env.services);
  return env;
}

describe('the receipt settings section', () => {
  test('the owner types the tax ID and address; one save sends both with the version', async () => {
    const env = await open('owner', {
      receipt: {
        save: async () => settingAnswer({ taxId: VALID, address: '1 Test Rd' }, 2),
      },
    });
    fireEvent.change(await screen.findByLabelText(tr('settings.receipt.taxId')), {
      target: { value: '1-2345-67890-12-1' },
    });
    fireEvent.change(screen.getByLabelText(tr('settings.receipt.address')), {
      target: { value: '1 Test Rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    await waitFor(() => expect(env.settingsApi.receipt.save).toHaveBeenCalledTimes(1));
    expect(env.settingsApi.receipt.save).toHaveBeenCalledWith({
      expectedVersion: 0,
      taxId: VALID,
      address: '1 Test Rd',
    });
  });

  test('a tax ID with a wrong check digit is refused before any save', async () => {
    const env = await open();
    fireEvent.change(await screen.findByLabelText(tr('settings.receipt.taxId')), {
      target: { value: BAD },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    expect(await screen.findByText(tr('settings.receipt.error.taxId'))).toBeTruthy();
    expect(env.settingsApi.receipt.save).not.toHaveBeenCalled();
  });

  test('a manager can look but not change', async () => {
    await open('manager');
    await screen.findByLabelText(tr('settings.receipt.taxId'));
    expect(screen.queryByRole('button', { name: tr('common.save') })).toBeNull();
    expect(screen.getByText(tr('settings.viewOnly'))).toBeTruthy();
  });
});

describe('receipt form rules', () => {
  const base = { taxId: VALID, address: 'A' };
  test('blank clears a field; unchanged sends nothing', () => {
    expect(buildReceiptPatch(base, 3, { taxId: VALID, address: 'A' })).toBeNull();
    expect(buildReceiptPatch(base, 3, { taxId: '', address: 'A' })).toEqual({
      expectedVersion: 3,
      taxId: null,
    });
  });

  test('validation', () => {
    expect(validateReceiptForm({ taxId: '', address: '' })).toEqual([]);
    expect(validateReceiptForm({ taxId: BAD, address: 'x'.repeat(201) })).toEqual([
      'taxId',
      'address',
    ]);
  });

  test('the hub lists the section for settings.view; only settings.receipt edits', () => {
    const entry = (permissions: Parameters<typeof hubEntries>[0]) =>
      hubEntries(permissions).find((e) => e.section.id === 'receipt');
    expect(entry(['settings.view'])?.canEdit).toBe(false);
    expect(entry(['settings.view', 'settings.receipt'])?.canEdit).toBe(true);
  });
});
