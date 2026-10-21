// @vitest-environment jsdom
import { catalogs, formatBaht, translator } from '@sds/i18n';
import { DEFAULT_EXPENSE_CATEGORIES, type ExpenseList, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../../api/errors.ts';
import { SAMPLE_EXPENSES } from '../../dev/mock-finance-data.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { ExpensesScreen } from './ExpensesScreen.tsx';

const th = catalogs.th;
const tr = translator('th');
const money = (n: number) => formatBaht(n, 'th');

/** 12:00 in Bangkok on Tuesday 15 Oct 2030: the business day is 2030-10-15. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
  Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const [FIRST, , , VOIDED] = SAMPLE_EXPENSES;
if (!FIRST || !VOIDED) throw new Error('fixture missing');

const LIST: ExpenseList = { expenses: [...SAMPLE_EXPENSES], totalSatang: satang(37500) };
const categoryAnswer = (value = DEFAULT_EXPENSE_CATEGORIES, version = 0) => ({
  value,
  version,
  rev: 0,
  updatedAt: null,
});
const NEW_ROW = { row: FIRST, replay: false, clientRequestId: 'x' };

async function open(
  expenses: Parameters<typeof createTestServices>[0] extends infer O
    ? O extends { expenses?: infer E }
      ? E
      : never
    : never = {},
  role: 'owner' | 'manager' = 'manager',
) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({
    auth,
    expenses: {
      list: async () => LIST,
      categories: { read: async () => categoryAnswer(), save: async () => categoryAnswer() },
      ...expenses,
    },
  });
  renderScreen(<ExpensesScreen />, env.services);
  await screen.findByText(th['exp.total']);
  return env;
}

describe('the list', () => {
  test('shows the rows of the month so far and the total the server gave, not a sum of the rows', async () => {
    const env = await open();
    expect(env.api.expenses.list).toHaveBeenCalledWith({ from: '2030-10-01', to: '2030-10-15' });
    // The server total (375.00) leaves the voided 999.00 out; the screen does not add anything up.
    expect(screen.getByText(money(37500))).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(SAMPLE_EXPENSES.length);
  });

  test('a voided row is struck through, labelled in words, shows its reason and cannot be edited', async () => {
    await open();
    const voided = screen
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText(money(99900)) !== null) as HTMLElement;
    expect(within(voided).getByText(th['exp.voided'])).toBeTruthy();
    expect(within(voided).getByText(tr('exp.voidedReason', { reason: 'พิมพ์ยอดผิด' }))).toBeTruthy();
    expect(within(voided).getByText(money(99900)).closest('.fin-struck')).not.toBeNull();
    expect(within(voided).queryByRole('button')).toBeNull();
    expect(screen.getByText(tr('exp.voidedCount', { count: 1 }))).toBeTruthy();
  });

  test('no expenses in the period says so', async () => {
    await open({ list: async () => ({ expenses: [], totalSatang: satang(0) }) });
    expect(screen.getByText(th['exp.none'])).toBeTruthy();
  });

  test('a failed load shows a retry', async () => {
    const { auth } = await createTestAuth('manager');
    const list = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('NETWORK'))
      .mockResolvedValue(LIST);
    const env = createTestServices({
      auth,
      expenses: {
        list,
        categories: { read: async () => categoryAnswer(), save: async () => categoryAnswer() },
      },
    });
    renderScreen(<ExpensesScreen />, env.services);
    fireEvent.click(await screen.findByRole('button', { name: th['common.retry'] }));
    expect(await screen.findByText(th['exp.total'])).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('the period', () => {
  test('a preset asks for its own range', async () => {
    const env = await open();
    fireEvent.click(screen.getByLabelText(th['dash.range.week']));
    await waitFor(() =>
      expect(env.api.expenses.list).toHaveBeenLastCalledWith({
        from: '2030-10-14',
        to: '2030-10-15',
      }),
    );
  });

  test('a custom range asks only when both dates make a valid range', async () => {
    const env = await open();
    fireEvent.click(screen.getByLabelText(th['fin.range.custom']));
    const calls = env.api.expenses.list.mock.calls.length;
    fireEvent.change(screen.getByLabelText(th['fin.range.from']), {
      target: { value: '2030-10-10' },
    });
    fireEvent.change(screen.getByLabelText(th['fin.range.to']), {
      target: { value: '2030-10-01' },
    });
    expect(await screen.findByText(th['fin.range.invalid'])).toBeTruthy();
    expect(env.api.expenses.list.mock.calls.length).toBe(calls);
    fireEvent.change(screen.getByLabelText(th['fin.range.to']), {
      target: { value: '2030-10-12' },
    });
    await waitFor(() =>
      expect(env.api.expenses.list).toHaveBeenLastCalledWith({
        from: '2030-10-10',
        to: '2030-10-12',
      }),
    );
    expect(screen.queryByText(th['fin.range.invalid'])).toBeNull();
  });

  test('a range longer than the report limit is refused with its limit', async () => {
    const env = await open();
    fireEvent.click(screen.getByLabelText(th['fin.range.custom']));
    const calls = env.api.expenses.list.mock.calls.length;
    fireEvent.change(screen.getByLabelText(th['fin.range.from']), {
      target: { value: '2029-01-01' },
    });
    fireEvent.change(screen.getByLabelText(th['fin.range.to']), {
      target: { value: '2030-10-12' },
    });
    expect(await screen.findByText(tr('fin.range.tooLong', { days: 366 }))).toBeTruthy();
    expect(env.api.expenses.list.mock.calls.length).toBe(calls);
  });
});

describe('adding an expense', () => {
  const fill = (amount: string, date?: string) => {
    fireEvent.click(screen.getByRole('button', { name: th['exp.add'] }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(th['exp.field.amount']), {
      target: { value: amount },
    });
    if (date) {
      fireEvent.change(within(dialog).getByLabelText(th['exp.field.date']), {
        target: { value: date },
      });
    }
    return dialog;
  };
  const save = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));

  test('sends baht as exact satang, a future date as typed, and one idempotency key; then reloads', async () => {
    const create = vi.fn(async () => NEW_ROW);
    const env = await open({ create });
    const dialog = fill('49.5', '2030-12-01');
    save(dialog);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input, options] = create.mock.calls[0] as unknown as [
      unknown,
      { clientRequestId?: string },
    ];
    expect(input).toEqual({
      businessDate: '2030-12-01',
      category: 'ingredients',
      amountSatang: 4950,
      vendor: null,
      note: null,
    });
    expect(options.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.api.expenses.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('a bad amount is told and nothing is sent', async () => {
    const create = vi.fn(async () => NEW_ROW);
    await open({ create });
    const dialog = fill('0');
    save(dialog);
    expect(await within(dialog).findByText(th['exp.error.amount'])).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  test('a retry after a lost answer reuses the key; a changed amount gets a new one', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('NETWORK'))
      .mockRejectedValueOnce(new ApiClientError('NETWORK'))
      .mockResolvedValue(NEW_ROW);
    await open({ create });
    const dialog = fill('20');
    save(dialog);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await within(dialog).findByText(th['error.network']);
    save(dialog);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    fireEvent.change(within(dialog).getByLabelText(th['exp.field.amount']), {
      target: { value: '25' },
    });
    await within(dialog).findByText(th['error.network']);
    save(dialog);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    const ids = create.mock.calls.map((call) => call[1].clientRequestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  test('only active categories are offered', async () => {
    const list = {
      categories: [
        { key: 'gas', nameTh: 'แก๊ส', nameEn: null, active: false },
        { key: 'rent', nameTh: 'ค่าเช่า', nameEn: null, active: true },
      ],
    };
    await open({
      categories: { read: async () => categoryAnswer(list, 2), save: async () => categoryAnswer() },
    });
    fireEvent.click(screen.getByRole('button', { name: th['exp.add'] }));
    const select = within(screen.getByRole('dialog')).getByLabelText(th['exp.field.category']);
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['ค่าเช่า']);
  });
});

describe('correcting an expense', () => {
  const editButton = (category: string, amount: string) =>
    screen.getByRole('button', { name: tr('exp.rowEdit', { category, amount }) });

  test('opens filled in, and a save sends only what changed with the version', async () => {
    const patch = vi.fn(async () => FIRST);
    await open({ patch });
    fireEvent.click(editButton('วัตถุดิบ', money(15000)));
    const dialog = screen.getByRole('dialog');
    const amount = within(dialog).getByLabelText(th['exp.field.amount']) as HTMLInputElement;
    expect(amount.value).toBe('150');
    fireEvent.change(amount, { target: { value: '160.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(FIRST.id, { expectedVersion: 1, amountSatang: 16050 });
  });

  test('saving without a change says so and sends nothing', async () => {
    const patch = vi.fn(async () => FIRST);
    await open({ patch });
    fireEvent.click(editButton('วัตถุดิบ', money(15000)));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(await within(dialog).findByText(th['exp.noChange'])).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  test('a row whose category was switched off keeps it in its own select', async () => {
    const list = {
      categories: DEFAULT_EXPENSE_CATEGORIES.categories.map((c) =>
        c.key === 'ingredients' ? { ...c, active: false } : c,
      ),
    };
    await open({
      categories: { read: async () => categoryAnswer(list, 3), save: async () => categoryAnswer() },
    });
    fireEvent.click(editButton('วัตถุดิบ', money(15000)));
    const select = within(screen.getByRole('dialog')).getByLabelText(th['exp.field.category']);
    expect(
      within(select).getByRole('option', { name: tr('exp.field.categoryOff', { name: 'วัตถุดิบ' }) }),
    ).toBeTruthy();
  });

  test('a version conflict is told in the dialog and the list is read again', async () => {
    const patch = vi
      .fn()
      .mockRejectedValue(new ApiClientError('VERSION_CONFLICT', { status: 409 }));
    const env = await open({ patch });
    const before = env.api.expenses.list.mock.calls.length;
    fireEvent.click(editButton('วัตถุดิบ', money(15000)));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(th['exp.field.amount']), {
      target: { value: '1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
    expect(await within(dialog).findByText(th['error.versionConflict'])).toBeTruthy();
    await waitFor(() => expect(env.api.expenses.list.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('voiding an expense', () => {
  const voidButton = () =>
    screen.getByRole('button', {
      name: tr('exp.rowVoid', { category: 'วัตถุดิบ', amount: money(15000) }),
    });

  test('needs a reason, then sends it with the version', async () => {
    const voided = vi.fn(async () => ({ ...FIRST, voided: true }));
    await open({ void: voided });
    fireEvent.click(voidButton());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.void.confirm'] }));
    expect(await within(dialog).findByText(th['exp.void.error.reason'])).toBeTruthy();
    expect(voided).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(th['exp.void.reason']), {
      target: { value: 'พิมพ์ผิด' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.void.confirm'] }));
    await waitFor(() => expect(voided).toHaveBeenCalledTimes(1));
    expect(voided).toHaveBeenCalledWith(FIRST.id, { expectedVersion: 1, reason: 'พิมพ์ผิด' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('says the row is struck through, not deleted', async () => {
    await open();
    fireEvent.click(voidButton());
    expect(within(screen.getByRole('dialog')).getByText(th['exp.void.explain'])).toBeTruthy();
  });
});

describe('the categories', () => {
  const panel = () => screen.getByRole('group', { name: th['exp.cat.title'] });

  test('a new category with Thai and English names is added to the whole list with the version', async () => {
    const save = vi.fn(async () => categoryAnswer());
    await open({
      categories: { read: async () => categoryAnswer(DEFAULT_EXPENSE_CATEGORIES, 4), save },
    });
    fireEvent.change(within(panel()).getByLabelText(th['exp.cat.nameTh']), {
      target: { value: 'กล่องข้าว' },
    });
    fireEvent.change(within(panel()).getByLabelText(th['exp.cat.nameEn']), {
      target: { value: 'Lunch boxes' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: th['exp.cat.add'] }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      expectedVersion: 4,
      categories: [
        ...DEFAULT_EXPENSE_CATEGORIES.categories,
        {
          key: 'lunch_boxes',
          nameTh: 'กล่องข้าว',
          nameEn: 'Lunch boxes',
          active: true,
          buyingGoods: true, // the add form ticks "buying goods" by default
        },
      ],
    });
  });

  test('the add form can untick buying goods (a verification fee is not goods)', async () => {
    const save = vi.fn(async () => categoryAnswer());
    await open({
      categories: { read: async () => categoryAnswer(DEFAULT_EXPENSE_CATEGORIES, 4), save },
    });
    const box = within(panel()).getByRole('checkbox', {
      name: th['exp.cat.addBuyingGoods'],
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.change(within(panel()).getByLabelText(th['exp.cat.nameTh']), {
      target: { value: 'ค่าตรวจสลิป' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: th['exp.cat.add'] }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = (
      save.mock.calls[0] as unknown as [{ categories: { nameTh: string; buyingGoods?: boolean }[] }]
    )[0];
    expect(sent.categories.at(-1)).toMatchObject({ nameTh: 'ค่าตรวจสลิป', buyingGoods: false });
  });

  test('each category shows whether it counts as buying goods (the default for an old list) and the box saves a change', async () => {
    const save = vi.fn(async () => categoryAnswer());
    const old = {
      categories: DEFAULT_EXPENSE_CATEGORIES.categories.map(({ buyingGoods: _, ...c }) => c),
    };
    await open({ categories: { read: async () => categoryAnswer(old, 2), save } });
    const boxOf = (name: string) =>
      within(panel()).getByRole('checkbox', {
        name: tr('exp.cat.buyingGoodsOf', { name }),
      }) as HTMLInputElement;
    expect(boxOf('วัตถุดิบ').checked).toBe(true);
    expect(boxOf('บรรจุภัณฑ์').checked).toBe(true);
    expect(boxOf('แก๊ส').checked).toBe(false);
    fireEvent.click(boxOf('บรรจุภัณฑ์'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = (
      save.mock.calls[0] as unknown as [
        { expectedVersion: number; categories: { key: string; buyingGoods?: boolean }[] },
      ]
    )[0];
    expect(sent.expectedVersion).toBe(2);
    expect(sent.categories.find((c) => c.key === 'packaging')?.buyingGoods).toBe(false);
    expect(sent.categories.find((c) => c.key === 'ingredients')?.buyingGoods).toBeUndefined();
  });

  test('a category without a Thai name is refused', async () => {
    const save = vi.fn(async () => categoryAnswer());
    await open({ categories: { read: async () => categoryAnswer(), save } });
    fireEvent.click(within(panel()).getByRole('button', { name: th['exp.cat.add'] }));
    expect(await within(panel()).findByText(th['exp.cat.error.nameTh'])).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  test('a category is switched off, never removed: the list keeps every key', async () => {
    const save = vi.fn(async () => categoryAnswer());
    await open({
      categories: { read: async () => categoryAnswer(DEFAULT_EXPENSE_CATEGORIES, 1), save },
    });
    expect(within(panel()).queryByRole('button', { name: /ลบ/ })).toBeNull();
    fireEvent.click(
      within(panel()).getByRole('button', { name: tr('exp.cat.switchOff', { name: 'แก๊ส' }) }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = (
      save.mock.calls[0] as unknown as [{ categories: { key: string; active: boolean }[] }]
    )[0];
    expect(sent.categories.map((c) => c.key)).toEqual(
      DEFAULT_EXPENSE_CATEGORIES.categories.map((c) => c.key),
    );
    expect(sent.categories.find((c) => c.key === 'gas')?.active).toBe(false);
  });

  test('a switched-off category is marked and can be switched on again', async () => {
    const list = {
      categories: DEFAULT_EXPENSE_CATEGORIES.categories.map((c) =>
        c.key === 'gas' ? { ...c, active: false } : c,
      ),
    };
    await open({
      categories: { read: async () => categoryAnswer(list, 2), save: async () => categoryAnswer() },
    });
    expect(within(panel()).getByText(th['exp.cat.off'])).toBeTruthy();
    expect(
      within(panel()).getByRole('button', { name: tr('exp.cat.switchOn', { name: 'แก๊ส' }) }),
    ).toBeTruthy();
  });
});
describe('receipt photos', () => {
  const WITH = { ...FIRST, hasReceipt: true, version: 3 };
  const WITH_LIST: ExpenseList = {
    expenses: SAMPLE_EXPENSES.map((e) =>
      e.id === FIRST.id ? WITH : e.id === VOIDED.id ? { ...e, hasReceipt: true } : e,
    ),
    totalSatang: satang(37500),
  };
  const png = (name = 'bill.png', type = 'image/png') =>
    new File([new Uint8Array([1, 2, 3])], name, { type });
  const created: string[] = [];
  const revoked: string[] = [];
  const madeRow = (version = 1) => ({
    row: {
      ...FIRST,
      id: 'new',
      version,
      amountSatang: satang(2000),
      businessDate: '2030-10-15',
      vendor: null,
      note: null,
    },
    replay: false,
    clientRequestId: 'x',
  });
  const attached = { row: { ...WITH, id: 'new' }, replay: false, requestId: 'k' };
  const sampleBlob = () => new Blob([new Uint8Array([1])], { type: 'image/png' });

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    Object.assign(URL, {
      createObjectURL: vi.fn(() => {
        const url = `blob:test-${created.length}`;
        created.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    });
  });

  /** All three receipt calls answered; a test replaces the one it cares about. */
  function receipt(given: Record<string, unknown> = {}) {
    return {
      attach: vi.fn(async () => ({ row: WITH, replay: false, requestId: 'k' })),
      read: vi.fn(async () => sampleBlob()),
      remove: vi.fn(async () => ({ ...WITH, hasReceipt: false, version: 4 })),
      ...given,
    } as unknown as NonNullable<Parameters<typeof open>[0]>['receipt'] & {
      attach: ReturnType<typeof vi.fn>;
      read: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  }

  const rowView = () =>
    screen.getByRole('button', {
      name: tr('exp.receipt.rowView', { category: 'วัตถุดิบ', amount: money(15000) }),
    });
  const editRow = () =>
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('exp.rowEdit', { category: 'วัตถุดิบ', amount: money(15000) }),
      }),
    );
  const fileInput = (dialog: HTMLElement) =>
    dialog.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = (dialog: HTMLElement, file: File) =>
    fireEvent.change(fileInput(dialog), { target: { files: [file] } });
  const save = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
  const openAdd = (amount = '20') => {
    fireEvent.click(screen.getByRole('button', { name: th['exp.add'] }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(th['exp.field.amount']), {
      target: { value: amount },
    });
    return dialog;
  };

  test('a row with a photo has a view button with a name; one without has none', async () => {
    await open({ list: async () => WITH_LIST, receipt: receipt() });
    expect(rowView()).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /ดูรูปใบเสร็จ/ })).toHaveLength(2);
  });

  test('a row without a photo shows no view button', async () => {
    await open({ receipt: receipt() });
    expect(screen.queryByRole('button', { name: /ดูรูปใบเสร็จ/ })).toBeNull();
  });

  test('viewing fetches the picture, shows it, and revokes the address when closed', async () => {
    const api = receipt();
    await open({ list: async () => WITH_LIST, receipt: api });
    fireEvent.click(rowView());
    const dialog = screen.getByRole('dialog');
    const img = (await within(dialog).findByAltText(th['exp.receipt.alt'])) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:test-0');
    expect(api.read).toHaveBeenCalledWith(WITH.id);
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.close'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(revoked).toEqual(['blob:test-0']);
  });

  test('a voided expense keeps its photo viewable and offers nothing else', async () => {
    await open({ list: async () => WITH_LIST, receipt: receipt() });
    const voided = screen
      .getAllByRole('listitem')
      .find((li) => within(li).queryByText(money(99900)) !== null) as HTMLElement;
    expect(within(voided).getAllByRole('button')).toHaveLength(1);
    expect(within(voided).getByRole('button', { name: /ดูรูปใบเสร็จ/ })).toBeTruthy();
  });

  test('photo storage not set up is told calmly, with no code, and can be retried', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('RECEIPT_STORAGE_UNAVAILABLE', { status: 503 }))
      .mockResolvedValue(sampleBlob());
    await open({ list: async () => WITH_LIST, receipt: receipt({ read }) });
    fireEvent.click(rowView());
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(th['error.expenseReceiptStorage'])).toBeTruthy();
    expect(dialog.textContent).not.toContain('RECEIPT_STORAGE_UNAVAILABLE');
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.retry'] }));
    expect(await within(dialog).findByAltText(th['exp.receipt.alt'])).toBeTruthy();
  });

  test('the file picker takes JPEG and PNG only', async () => {
    await open({ receipt: receipt() });
    fireEvent.click(screen.getByRole('button', { name: th['exp.add'] }));
    expect(fileInput(screen.getByRole('dialog')).getAttribute('accept')).toBe(
      'image/jpeg,image/png',
    );
  });

  test('a new expense is created first and the photo attached with the version it got', async () => {
    const api = receipt();
    const create = vi.fn(async () => madeRow());
    await open({ create, receipt: api });
    const dialog = openAdd();
    const file = png();
    pick(dialog, file);
    expect(within(dialog).getByText(tr('exp.receipt.picked', { name: 'bill.png' }))).toBeTruthy();
    save(dialog);
    await waitFor(() => expect(api.attach).toHaveBeenCalledTimes(1));
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      api.attach.mock.invocationCallOrder[0] as number,
    );
    expect(api.attach).toHaveBeenCalledWith('new', file, {
      expectedVersion: 1,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('if the photo fails after the expense was made, the dialog says so, stays, and a retry does not create again', async () => {
    const attach = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('RECEIPT_STORAGE_UNAVAILABLE', { status: 503 }))
      .mockResolvedValue(attached);
    const create = vi.fn(async () => madeRow());
    const env = await open({ create, receipt: receipt({ attach }) });
    const before = env.api.expenses.list.mock.calls.length;
    const dialog = openAdd();
    pick(dialog, png());
    save(dialog);
    const message = tr('exp.receipt.attachFailed', { reason: th['error.expenseReceiptStorage'] });
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(within(dialog).getByText(th['exp.dialog.editTitle'])).toBeTruthy();
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('button', { name: th['common.save'] }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    save(dialog);
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[1]?.[2].requestId).toBe(attach.mock.calls[0]?.[2].requestId);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.api.expenses.list.mock.calls.length).toBeGreaterThan(before);
  });

  test('closing after the expense was made but the photo failed still reads the list again', async () => {
    const attach = vi.fn().mockRejectedValue(new ApiClientError('NETWORK'));
    const env = await open({ create: vi.fn(async () => madeRow()), receipt: receipt({ attach }) });
    const before = env.api.expenses.list.mock.calls.length;
    const dialog = openAdd();
    pick(dialog, png());
    save(dialog);
    await within(dialog).findByText(
      tr('exp.receipt.attachFailed', { reason: th['error.network'] }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.api.expenses.list.mock.calls.length).toBeGreaterThan(before);
  });

  test('a photo-only change on an existing expense attaches without a patch, with its version', async () => {
    const patch = vi.fn(async () => FIRST);
    const api = receipt();
    await open({ patch, receipt: api });
    editRow();
    const dialog = screen.getByRole('dialog');
    const file = png('r.png');
    pick(dialog, file);
    save(dialog);
    await waitFor(() => expect(api.attach).toHaveBeenCalledTimes(1));
    expect(patch).not.toHaveBeenCalled();
    expect(api.attach).toHaveBeenCalledWith(
      FIRST.id,
      file,
      expect.objectContaining({ expectedVersion: 1 }),
    );
  });

  test('a field change and a photo: patch first, then attach with the version the patch returned', async () => {
    const patch = vi.fn(async () => ({ ...FIRST, amountSatang: satang(16050), version: 2 }));
    const api = receipt();
    await open({ patch, receipt: api });
    editRow();
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(th['exp.field.amount']), {
      target: { value: '160.5' },
    });
    pick(dialog, png());
    save(dialog);
    await waitFor(() => expect(api.attach).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(FIRST.id, { expectedVersion: 1, amountSatang: 16050 });
    expect(api.attach).toHaveBeenCalledWith(
      FIRST.id,
      expect.anything(),
      expect.objectContaining({ expectedVersion: 2 }),
    );
  });

  test('an expense with a photo shows it in the dialog and offers to replace or remove it', async () => {
    await open({ list: async () => WITH_LIST, receipt: receipt() });
    editRow();
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByAltText(th['exp.receipt.alt'])).toBeTruthy();
    expect(within(dialog).getByText(th['exp.receipt.has'])).toBeTruthy();
    expect(within(dialog).getByText(th['exp.receipt.replace'])).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: th['exp.receipt.remove'] })).toBeTruthy();
  });

  test('a WebP or oversized file is told at once and nothing is attached', async () => {
    const api = receipt();
    await open({ receipt: api });
    fireEvent.click(screen.getByRole('button', { name: th['exp.add'] }));
    const dialog = screen.getByRole('dialog');
    pick(dialog, png('x.webp', 'image/webp'));
    expect(await within(dialog).findByText(th['error.expenseReceiptType'])).toBeTruthy();
    expect(within(dialog).queryByText(/จะแนบรูป/)).toBeNull();
    const big = png('big.png');
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    pick(dialog, big);
    expect(await within(dialog).findByText(th['error.expenseReceiptTooLarge'])).toBeTruthy();
    expect(api.attach).not.toHaveBeenCalled();
  });

  test('a server 415 is told in words too', async () => {
    const attach = vi
      .fn()
      .mockRejectedValue(new ApiClientError('RECEIPT_TYPE_UNSUPPORTED', { status: 415 }));
    await open({ receipt: receipt({ attach }) });
    editRow();
    const dialog = screen.getByRole('dialog');
    pick(dialog, png());
    save(dialog);
    expect(
      await within(dialog).findByText(
        tr('exp.receipt.attachFailed', { reason: th['error.expenseReceiptType'] }),
      ),
    ).toBeTruthy();
  });

  test('removing asks first, and nothing is sent unless it is confirmed', async () => {
    const api = receipt();
    await open({ list: async () => WITH_LIST, receipt: api });
    editRow();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.remove'] }));
    expect(within(dialog).getByText(th['exp.receipt.removeAsk'])).toBeTruthy();
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.removeKeep'] }));
    expect(within(dialog).queryByText(th['exp.receipt.removeAsk'])).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
  });

  test('a confirmed removal sends the version, shows no photo, and the list is read again on close', async () => {
    const api = receipt();
    const env = await open({ list: async () => WITH_LIST, receipt: api });
    const before = env.api.expenses.list.mock.calls.length;
    editRow();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.remove'] }));
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.removeConfirm'] }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(WITH.id, 3));
    expect(await within(dialog).findByText(th['exp.receipt.none'])).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: th['common.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.api.expenses.list.mock.calls.length).toBeGreaterThan(before);
  });

  test('a removal that fails keeps the photo and tells why', async () => {
    const remove = vi
      .fn()
      .mockRejectedValue(new ApiClientError('VERSION_CONFLICT', { status: 409 }));
    await open({ list: async () => WITH_LIST, receipt: receipt({ remove }) });
    editRow();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.remove'] }));
    fireEvent.click(within(dialog).getByRole('button', { name: th['exp.receipt.removeConfirm'] }));
    expect(await within(dialog).findByText(th['error.versionConflict'])).toBeTruthy();
    expect(within(dialog).getByText(th['exp.receipt.has'])).toBeTruthy();
  });
});
