// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { PrintJobDto, StaffRole } from '@sds/shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { uuid } from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { type SettingsOverrides, settingAnswer } from '../test-support/settings-env.ts';
import { SettingsSectionScreen } from './SettingsSectionScreen.tsx';

afterEach(cleanup);
const tr = translator('th');

const job = (n: number, over: Partial<PrintJobDto> = {}): PrintJobDto => ({
  id: uuid(500 + n),
  orderId: uuid(600 + n),
  orderNo: `S-0${n}`,
  kind: 'kitchen',
  seq: 0,
  status: 'pending',
  attempts: 0,
  lastError: null,
  createdAt: '2030-10-15T05:00:00.000Z',
  printedAt: null,
  ...over,
});

async function open(
  role: StaffRole,
  options: { settingsApi?: SettingsOverrides; jobs?: PrintJobDto[] } = {},
) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({
    auth,
    ...(options.settingsApi ? { settingsApi: options.settingsApi } : {}),
    print: { jobs: async () => ({ jobs: options.jobs ?? [] }) },
  });
  renderScreen(<SettingsSectionScreen section="printing" />, env.services);
  return env;
}

const sw = async () => (await screen.findByRole('checkbox')) as HTMLInputElement;

describe('the printing switch', () => {
  test('is off until the owner turns it on, and explains what off means', async () => {
    await open('manager');
    expect((await sw()).checked).toBe(false);
    expect(screen.getByText(tr('settings.printing.stateOff'))).toBeTruthy();
    expect(screen.getByText(tr('settings.printing.explainOff'))).toBeTruthy();
    expect(screen.getByText(tr('settings.printing.explainReprint'))).toBeTruthy();
    expect(screen.getByText(tr('settings.printing.explainShutdown'))).toBeTruthy();
  });

  test('turning it on saves with the version the screen was built on', async () => {
    const env = await open('manager', {
      settingsApi: {
        printing: {
          read: async () => settingAnswer({ enabled: false }, 4),
          save: async () => settingAnswer({ enabled: true }, 5),
        },
      },
    });
    fireEvent.click(await sw());
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    expect(await screen.findByText(tr('settings.saved'))).toBeTruthy();
    expect(env.settingsApi.printing.save).toHaveBeenCalledWith({
      expectedVersion: 4,
      enabled: true,
    });
    expect(await screen.findByText(tr('settings.printing.stateOn'))).toBeTruthy();
  });

  test('saving with no change sends nothing', async () => {
    const env = await open('manager');
    await sw();
    fireEvent.click(screen.getByRole('button', { name: tr('common.save') }));
    expect(await screen.findByText(tr('settings.noChange'))).toBeTruthy();
    expect(env.settingsApi.printing.save).not.toHaveBeenCalled();
  });

  test('a cashier cannot open the section', async () => {
    await open('cashier');
    expect(screen.getByText(tr('settings.notFound'))).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('recent print jobs', () => {
  test('shows each job with its status in words, and why a failed one failed', async () => {
    await open('owner', {
      jobs: [
        job(1, { status: 'pending' }),
        job(2, { status: 'claimed', attempts: 1 }),
        job(3, { status: 'printed', printedAt: '2030-10-15T05:01:00.000Z' }),
        job(4, { status: 'failed', attempts: 5, lastError: 'OUT_OF_PAPER' }),
        job(5, { kind: 'reprint', seq: 2, status: 'printed' }),
      ],
    });
    const list = await screen.findByRole('list', { name: tr('settings.printing.jobs.listLabel') });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(
      within(rows[0] as HTMLElement).getByText(tr('settings.printing.jobs.status.pending')),
    ).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement).getByText(tr('settings.printing.jobs.status.claimed')),
    ).toBeTruthy();
    expect(
      within(rows[2] as HTMLElement).getByText(tr('settings.printing.jobs.status.printed')),
    ).toBeTruthy();
    expect(
      within(rows[3] as HTMLElement).getByText(tr('settings.printing.jobs.status.failed')),
    ).toBeTruthy();
    expect(rows[3]?.textContent).toContain(tr('settings.printing.jobs.error.OUT_OF_PAPER'));
    expect(rows[4]?.textContent).toContain(tr('settings.printing.jobs.kind.reprint', { seq: 2 }));
  });

  test('says so when there are none', async () => {
    await open('owner', { jobs: [] });
    expect(await screen.findByText(tr('settings.printing.jobs.empty'))).toBeTruthy();
  });
});
