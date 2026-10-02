// @vitest-environment jsdom
import { th, translator } from '@sds/i18n';
import { type StaffRole, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { categoryDto, groupDto, itemDto, optionDto } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { MenuEditorScreen } from './MenuEditorScreen.tsx';

afterEach(cleanup);

const tr = translator('th');
type Menu = Partial<ApiClient['menu']>;

/** The reads answer nothing new, so the seeded menu stays as the test sees it. */
const reads: Menu = {
  listCategories: async () => ({ categories: [] }),
  listItems: async () => ({ items: [] }),
  listGroups: async () => ({ groups: [] }),
};
const withCosts: Menu = {
  costs: async () => ({
    items: [{ id: MENU.tomYum, estCostSatang: satang(1800) }],
    options: [{ id: MENU.egg, costDeltaSatang: satang(300) }],
  }),
};

async function open(
  options: { role?: StaffRole; menuApi?: Menu; offline?: boolean; costs?: boolean } = {},
) {
  const { auth } = await createTestAuth(options.role ?? 'manager');
  const env = createTestServices({
    auth,
    ...(options.offline ? { offline: true } : {}),
    menuApi: {
      ...reads,
      ...(options.costs === false ? {} : withCosts),
      ...options.menuApi,
    },
  });
  renderScreen(<MenuEditorScreen />, env.services);
  return env;
}

const type = (label: string, value: string, within_?: HTMLElement) =>
  fireEvent.change((within_ ? within(within_) : screen).getByLabelText(label), {
    target: { value },
  });
const save = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: th['common.save'] }));
const created =
  <T,>(row: T): ((_: unknown, o?: { clientRequestId?: string }) => Promise<never>) =>
  async (_input, o) =>
    ({ row, replay: false, clientRequestId: o?.clientRequestId ?? '' }) as never;

describe('the lists', () => {
  test('shows the dishes of the first category with the sold-out switch, and reads archived rows too', async () => {
    const env = await open();
    expect(await screen.findByText('ก๋วยเตี๋ยวต้มยำ')).toBeTruthy();
    await waitFor(() =>
      expect(env.menuApi.listItems).toHaveBeenCalledWith({ includeArchived: true }),
    );
    const soldOut = screen.getByRole('switch', {
      name: tr('menuEditor.soldOut.for', { name: 'ต้มยำทะเล' }),
    });
    expect(soldOut.getAttribute('aria-checked')).toBe('true');
    expect(
      screen
        .getByRole('switch', { name: tr('menuEditor.soldOut.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }) })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  test('shows costs for a role that can see them, and not for one that cannot', async () => {
    const env = await open();
    expect(await screen.findByText(tr('menuEditor.costLabel', { amount: '฿18' }))).toBeTruthy();
    expect(env.menuApi.costs).toHaveBeenCalledTimes(1);
    cleanup();

    const blind = await open({
      menuApi: {
        costs: async () => {
          throw new ApiClientError('FORBIDDEN', { status: 403 });
        },
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    await waitFor(() => expect(blind.menuApi.costs).toHaveBeenCalled());
    expect(screen.queryByText(/ต้นทุน/)).toBeNull();
  });

  test('a failed first load says so and offers a retry', async () => {
    const { auth } = await createTestAuth('manager');
    let fail = true;
    const env = createTestServices({
      auth,
      menuApi: {
        ...reads,
        ...withCosts,
        listCategories: async () => {
          if (fail) throw new ApiClientError('NETWORK');
          return { categories: [] };
        },
      },
    });
    renderScreen(<MenuEditorScreen />, env.services);
    expect(await screen.findByText(tr('menuEditor.loadFailed'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: tr('common.retry') }));
    await waitFor(() => expect(screen.queryByText(tr('menuEditor.loadFailed'))).toBeNull());
  });
});

describe('offline', () => {
  test('says plainly that editing needs the internet, keeps the lists readable and turns every writing control off', async () => {
    const env = await open({ offline: true });
    expect(await screen.findByText(tr('menuEditor.offline'))).toBeTruthy();
    expect(screen.getByText('ก๋วยเตี๋ยวต้มยำ')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: tr('menuEditor.add.item') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('switch', {
          name: tr('menuEditor.soldOut.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(env.menuApi.listItems).not.toHaveBeenCalled();
  });
});

describe('dishes', () => {
  test('a new dish is sent with prices as integer satang, a request id, and last in its category', async () => {
    const env = await open({
      menuApi: {
        createItem: created(itemDto(MENU.tea, 2000, { nameTh: 'ผัดไทย', version: 1 })),
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByRole('button', { name: tr('menuEditor.add.item') }));
    const dialog = screen.getByRole('dialog');
    type(tr('menuEditor.field.nameTh'), 'ผัดไทย', dialog);
    type(tr('menuEditor.field.price'), '55.50', dialog);
    type(tr('menuEditor.field.channelPrice', { channel: 'LINE' }), '60', dialog);
    save(dialog);
    await waitFor(() => expect(env.menuApi.createItem).toHaveBeenCalledTimes(1));
    const [input, options] = env.menuApi.createItem.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      categoryId: MENU.catNoodle,
      nameTh: 'ผัดไทย',
      nameEn: null,
      priceSatang: 5550,
      channels: ['storefront', 'line'],
      channelPrices: { line: 6000 },
      sort: 4,
    });
    expect(input).not.toHaveProperty('estCostSatang');
    expect(options?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('a form with a bad price names the field and sends nothing', async () => {
    const env = await open();
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByRole('button', { name: tr('menuEditor.add.item') }));
    const dialog = screen.getByRole('dialog');
    type(tr('menuEditor.field.nameTh'), 'ผัดไทย', dialog);
    type(tr('menuEditor.field.price'), '5x', dialog);
    save(dialog);
    expect(await within(dialog).findByText(tr('menuEditor.error.price'))).toBeTruthy();
    expect(env.menuApi.createItem).not.toHaveBeenCalled();
  });

  test('editing the price sends the new price and the version, and nothing else', async () => {
    const env = await open({
      menuApi: {
        patchItem: async (id) => itemDto(id, 2100, { version: 2, priceSatang: satang(5550) }),
      },
    });
    await screen.findByText(tr('menuEditor.costLabel', { amount: '฿18' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('menuEditor.edit.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(
      (within(dialog).getByLabelText(tr('menuEditor.field.price')) as HTMLInputElement).value,
    ).toBe('50');
    type(tr('menuEditor.field.price'), '55.50', dialog);
    save(dialog);
    await waitFor(() => expect(env.menuApi.patchItem).toHaveBeenCalledTimes(1));
    expect(env.menuApi.patchItem).toHaveBeenCalledWith(MENU.tomYum, {
      expectedVersion: 1,
      priceSatang: 5550,
    });
  });

  test('a role that can see costs edits the cost, and it is sent only when changed', async () => {
    const env = await open({
      menuApi: { patchItem: async (id) => itemDto(id, 2101, { version: 2 }) },
    });
    await screen.findByText(tr('menuEditor.costLabel', { amount: '฿18' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('menuEditor.edit.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    const cost = within(dialog).getByLabelText(tr('menuEditor.field.cost')) as HTMLInputElement;
    expect(cost.value).toBe('18');
    type(tr('menuEditor.field.cost'), '20', dialog);
    save(dialog);
    await waitFor(() =>
      expect(env.menuApi.patchItem).toHaveBeenCalledWith(MENU.tomYum, {
        expectedVersion: 1,
        estCostSatang: 2000,
      }),
    );
  });

  test('a role without costs has no cost field at all', async () => {
    await open({
      menuApi: {
        costs: async () => {
          throw new ApiClientError('FORBIDDEN', { status: 403 });
        },
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('menuEditor.edit.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(tr('menuEditor.field.cost'))).toBeNull();
  });

  test('a save refused as changed elsewhere closes the form and says to look again', async () => {
    const env = await open({
      menuApi: {
        patchItem: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 5 });
        },
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('menuEditor.edit.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    type(tr('menuEditor.field.nameTh'), 'ชื่อใหม่', dialog);
    save(dialog);
    expect(await screen.findByText(new RegExp(tr('menuEditor.refreshed')))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(env.menuApi.patchItem).toHaveBeenCalledTimes(1);
  });

  test('the sold-out switch and archive send the version on screen', async () => {
    const env = await open({
      menuApi: {
        setItemAvailable: async (id) => itemDto(id, 2200, { version: 2, isAvailable: false }),
        patchItem: async (id) =>
          itemDto(id, 2201, {
            version: 2,
            archived: true,
            categoryId: MENU.catNoodle,
            nameTh: 'ก๋วยเตี๋ยวเรือ',
            sort: 3,
          }),
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('switch', {
        name: tr('menuEditor.soldOut.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    await waitFor(() =>
      expect(env.menuApi.setItemAvailable).toHaveBeenCalledWith(MENU.tomYum, {
        isAvailable: false,
        expectedVersion: 1,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: tr('menuEditor.archive.for', { name: 'ก๋วยเตี๋ยวเรือ' }) }),
    );
    await waitFor(() =>
      expect(env.menuApi.patchItem).toHaveBeenCalledWith(MENU.boat, {
        expectedVersion: 1,
        archived: true,
      }),
    );
    // The archived dish leaves the list and comes back under "archived" with a restore button.
    fireEvent.click(screen.getByLabelText(tr('menuEditor.showArchived')));
    expect(
      await screen.findByRole('button', {
        name: tr('menuEditor.restore.for', { name: 'ก๋วยเตี๋ยวเรือ' }),
      }),
    ).toBeTruthy();
  });

  test('moving a dish down sends the whole category in the new order with its versions', async () => {
    const env = await open({
      menuApi: {
        reorder: async () => ({
          kind: 'items',
          parentId: MENU.catNoodle,
          changed: 2,
          rows: [
            { id: MENU.seafood, sort: 0, version: 2, rev: 2300 },
            { id: MENU.tomYum, sort: 1, version: 2, rev: 2301 },
            { id: MENU.boat, sort: 2, version: 1, rev: 3 },
          ],
        }),
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('button', { name: tr('menuEditor.moveDown', { name: 'ก๋วยเตี๋ยวต้มยำ' }) }),
    );
    await waitFor(() =>
      expect(env.menuApi.reorder).toHaveBeenCalledWith({
        kind: 'items',
        parentId: MENU.catNoodle,
        order: [
          { id: MENU.seafood, expectedVersion: 1 },
          { id: MENU.tomYum, expectedVersion: 1 },
          { id: MENU.boat, expectedVersion: 1 },
        ],
      }),
    );
    // The list now shows the new order.
    await waitFor(() => {
      const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
      expect(rows.findIndex((t) => t.includes('ต้มยำทะเล'))).toBeLessThan(
        rows.findIndex((t) => t.includes('ก๋วยเตี๋ยวต้มยำ')),
      );
    });
  });

  test('a list that changed on another device is reloaded and the person is told', async () => {
    await open({
      menuApi: {
        reorder: async () => {
          throw new ApiClientError('REORDER_SET_MISMATCH', { status: 409 });
        },
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('button', { name: tr('menuEditor.moveDown', { name: 'ก๋วยเตี๋ยวต้มยำ' }) }),
    );
    expect(
      await screen.findByText(new RegExp(th['error.reorderMismatch'].slice(0, 20))),
    ).toBeTruthy();
  });
});

describe('photo', () => {
  test('a chosen file is re-encoded before it is uploaded, and the upload carries the new type', async () => {
    const env = await open({
      menuApi: { putPhoto: async (id) => itemDto(id, 2400, { version: 2, photoVersion: 2 }) },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('menuEditor.edit.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const original = new File([new Uint8Array(500_000)], 'IMG_0001.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [original] } });
    await waitFor(() => expect(env.menuApi.putPhoto).toHaveBeenCalledTimes(1));
    const [id, sent] = env.menuApi.putPhoto.mock.calls[0] ?? [];
    expect(id).toBe(MENU.tomYum);
    expect((sent as Blob).type).toBe('image/webp');
    expect((sent as Blob).size).toBeLessThan(original.size);
  });

  test('says that a photo change is saved at once, not with the Save button', async () => {
    await open();
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(
      screen.getByRole('button', {
        name: tr('menuEditor.edit.for', { name: 'ก๋วยเตี๋ยวต้มยำ' }),
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(tr('menuEditor.photo.savedNow'))).toBeTruthy();
  });

  test('a new dish says to save it before adding a photo', async () => {
    await open();
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByRole('button', { name: tr('menuEditor.add.item') }));
    expect(screen.getByText(tr('menuEditor.photo.saveFirst'))).toBeTruthy();
  });
});

describe('categories', () => {
  test('a new category goes last, with a request id', async () => {
    const env = await open({
      menuApi: { createCategory: created(categoryDto(MENU.catDrink, 2500, { nameTh: 'ของหวาน' })) },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByLabelText(tr('menuEditor.tab.categories')));
    fireEvent.click(screen.getByRole('button', { name: tr('menuEditor.add.category') }));
    const dialog = screen.getByRole('dialog');
    type(tr('menuEditor.field.nameTh'), 'ของหวาน', dialog);
    save(dialog);
    await waitFor(() => expect(env.menuApi.createCategory).toHaveBeenCalledTimes(1));
    const [input, options] = env.menuApi.createCategory.mock.calls[0] ?? [];
    expect(input).toEqual({ nameTh: 'ของหวาน', nameEn: null, sort: 4 });
    expect(options?.clientRequestId).toBeTruthy();
  });

  test('switching a category off sends active false with the version', async () => {
    const env = await open({
      menuApi: {
        patchCategory: async (id) => categoryDto(id, 2501, { version: 2, active: false }),
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByLabelText(tr('menuEditor.tab.categories')));
    fireEvent.click(
      screen.getByRole('button', { name: tr('menuEditor.archive.for', { name: 'เครื่องดื่ม' }) }),
    );
    await waitFor(() =>
      expect(env.menuApi.patchCategory).toHaveBeenCalledWith(MENU.catDrink, {
        expectedVersion: 1,
        active: false,
      }),
    );
  });
});

describe('option groups', () => {
  test('a new option takes a signed price in baht and sends integer satang', async () => {
    const env = await open({
      menuApi: {
        createOption: async (_group, _input, o) => ({
          row: optionDto(MENU.egg, MENU.gExtra, 2600, { nameTh: 'หมูกรอบ' }),
          replay: false,
          clientRequestId: o?.clientRequestId ?? '',
        }),
      },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByLabelText(tr('menuEditor.tab.groups')));
    const card = screen.getByText('เพิ่มเติม').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: tr('menuEditor.add.option') }));
    const dialog = screen.getByRole('dialog');
    type(tr('menuEditor.field.nameTh'), 'หมูกรอบ', dialog);
    type(tr('menuEditor.field.priceDelta'), '-5', dialog);
    type(tr('menuEditor.field.costDelta'), '3.25', dialog);
    save(dialog);
    await waitFor(() => expect(env.menuApi.createOption).toHaveBeenCalledTimes(1));
    const [groupId, input, options] = env.menuApi.createOption.mock.calls[0] ?? [];
    expect(groupId).toBe(MENU.gExtra);
    expect(input).toEqual({
      nameTh: 'หมูกรอบ',
      nameEn: null,
      priceDeltaSatang: -500,
      costDeltaSatang: 325,
      sort: 4,
    });
    expect(options?.clientRequestId).toBeTruthy();
  });

  test('a group is made with its pick range, and a range that cannot work is refused on the form', async () => {
    const env = await open({
      menuApi: { createGroup: created(groupDto(MENU.gBoat, 2700, { nameTh: 'ท็อปปิ้ง' })) },
    });
    await screen.findByText('ก๋วยเตี๋ยวต้มยำ');
    fireEvent.click(screen.getByLabelText(tr('menuEditor.tab.groups')));
    fireEvent.click(screen.getByRole('button', { name: tr('menuEditor.add.group') }));
    const dialog = screen.getByRole('dialog');
    type(tr('menuEditor.field.nameTh'), 'ท็อปปิ้ง', dialog);
    type(tr('menuEditor.field.minSelect'), '3', dialog);
    type(tr('menuEditor.field.maxSelect'), '2', dialog);
    save(dialog);
    expect(await within(dialog).findByText(tr('menuEditor.error.minSelect'))).toBeTruthy();
    expect(env.menuApi.createGroup).not.toHaveBeenCalled();
    type(tr('menuEditor.field.minSelect'), '0', dialog);
    save(dialog);
    await waitFor(() => expect(env.menuApi.createGroup).toHaveBeenCalledTimes(1));
    expect(env.menuApi.createGroup.mock.calls[0]?.[0]).toMatchObject({
      nameTh: 'ท็อปปิ้ง',
      minSelect: 0,
      maxSelect: 2,
    });
  });
});
