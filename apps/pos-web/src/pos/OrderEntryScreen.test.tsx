// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderEntryScreen } from './OrderEntryScreen.tsx';

const th = catalogs.th;
const en = catalogs.en;

beforeEach(() => {
  window.location.hash = '#/new';
});
afterEach(cleanup);

const ALL_CHIP = /^ทั้งหมด \d+$/;
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const click = (element: HTMLElement) => fireEvent.click(element);

const radio = (scope: HTMLElement, name: RegExp) =>
  within(scope).getByRole('radio', { name }) as HTMLInputElement;

async function pickNoodleChoices(noodle = 'เส้นเล็ก', spice = 'เผ็ดน้อย') {
  const dialog = screen.getByRole('dialog');
  click(within(dialog).getByRole('radio', { name: new RegExp(noodle) }));
  click(within(dialog).getByRole('radio', { name: new RegExp(spice) }));
  return dialog;
}

describe('the menu', () => {
  test('shows the categories with their counts and the dishes with prices', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    expect(screen.getByRole('button', { name: ALL_CHIP })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^ก๋วยเตี๋ยว \d+$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^เครื่องดื่ม \d+$/ })).toBeTruthy();
    expect(tile('ก๋วยเตี๋ยวต้มยำ').textContent).toContain('฿50');
    expect(tile('ชาเย็น').textContent).toContain('฿25');
  });

  test('keeps sold-out dishes in place, labelled and not addable', () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    const seafood = tile('ต้มยำทะเล') as HTMLButtonElement;
    expect(seafood.disabled).toBe(true);
    expect(seafood.textContent).toContain(th['pos.orderEntry.soldOut']);
    click(seafood);
    expect(cart.getState().lines).toHaveLength(0);
    // A required group with nothing left to pick is sold out as well.
    expect((tile('ก๋วยเตี๋ยวเรือ') as HTMLButtonElement).disabled).toBe(true);
  });

  test('hides dishes of a deactivated category and dishes not sold at the counter', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    expect(screen.queryByText('เมนูลับ')).toBeNull();
    expect(screen.queryByText('เฉพาะไลน์')).toBeNull();
  });

  test('a category chip narrows the grid, "all" brings everything back', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    click(screen.getByRole('button', { name: /^เครื่องดื่ม \d+$/ }));
    expect(screen.queryByText('ก๋วยเตี๋ยวต้มยำ')).toBeNull();
    expect(screen.getByText('ชาเย็น')).toBeTruthy();
    click(screen.getByRole('button', { name: ALL_CHIP }));
    expect(screen.getByText('ก๋วยเตี๋ยวต้มยำ')).toBeTruthy();
  });

  test('search finds a dish by Thai or English name', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'tea' } });
    expect(screen.getByText('ชาเย็น')).toBeTruthy();
    expect(screen.queryByText('ก๋วยเตี๋ยวต้มยำ')).toBeNull();
    fireEvent.change(box, { target: { value: 'ไม่มีเมนูนี้' } });
    expect(screen.getByText(th['pos.orderEntry.noMatch'])).toBeTruthy();
  });

  test('says so while the menu has not arrived, and when there is none', () => {
    const loading = createTestServices({ menu: false, connection: { synced: false } });
    renderScreen(<OrderEntryScreen />, loading.services);
    expect(screen.getByText(th['pos.orderEntry.menuLoading'])).toBeTruthy();
    cleanup();
    const offline = createTestServices({
      menu: false,
      connection: { synced: false, status: 'offline' },
    });
    renderScreen(<OrderEntryScreen />, offline.services);
    expect(screen.getByText(th['pos.orderEntry.menuNotLoaded'])).toBeTruthy();
    cleanup();
    const empty = createTestServices({ menu: false });
    renderScreen(<OrderEntryScreen />, empty.services);
    expect(screen.getByText(th['pos.orderEntry.menuEmpty'])).toBeTruthy();
  });
});

describe('adding a dish', () => {
  test('a plain dish goes straight into the order, and tapping again adds another', () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(tile('ชาเย็น'));
    expect(cart.getState().lines).toMatchObject([{ itemId: MENU.tea, qty: 2 }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a dish with required choices opens the options sheet; "add" waits until they are made', () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    const dialog = screen.getByRole('dialog');
    const add = within(dialog).getByRole('button', { name: /^เพิ่ม ·/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(within(dialog).getByText(/ยังต้องเลือก/).textContent).toContain('เส้น');
    click(within(dialog).getByRole('radio', { name: /เส้นเล็ก/ }));
    expect(add.disabled).toBe(true);
    click(within(dialog).getByRole('radio', { name: /เผ็ดน้อย/ }));
    expect(add.disabled).toBe(false);
    expect(add.textContent).toContain('฿50.00');
    click(add);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cart.getState().lines[0]).toMatchObject({
      itemId: MENU.tomYum,
      optionIds: [MENU.thin, MENU.mild],
      qty: 1,
    });
  });

  test('the sheet shows what each option costs, a note field and a quantity', async () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    const dialog = await pickNoodleChoices();
    click(within(dialog).getByRole('checkbox', { name: /ไข่ต้ม/ }));
    expect(
      within(dialog).getByRole('checkbox', { name: /ไข่ต้ม/ }).closest('label')?.textContent,
    ).toContain('+฿10');
    fireEvent.change(within(dialog).getByLabelText(th['common.note']), {
      target: { value: 'ไม่ใส่ผัก' },
    });
    click(
      within(dialog).getByRole('button', {
        name: new RegExp(th['pos.orderEntry.increase'].replace('{name}', '')),
      }),
    );
    const add = within(dialog).getByRole('button', { name: /^เพิ่ม ·/ });
    expect(add.textContent).toContain('฿120.00');
    click(add);
    expect(cart.getState().lines[0]).toMatchObject({
      qty: 2,
      note: 'ไม่ใส่ผัก',
      optionIds: [MENU.thin, MENU.mild, MENU.egg],
    });
  });

  test('a choose-one group replaces its choice; a choose-several group stops at its maximum', async () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    const dialog = await pickNoodleChoices();
    click(within(dialog).getByRole('radio', { name: /เส้นใหญ่/ }));
    expect(radio(dialog, /เส้นใหญ่/).checked).toBe(true);
    expect(radio(dialog, /เส้นเล็ก/).checked).toBe(false);
    click(within(dialog).getByRole('checkbox', { name: /ไข่ต้ม/ }));
    click(within(dialog).getByRole('checkbox', { name: /ลูกชิ้น/ }));
    const third = within(dialog).getByRole('checkbox', { name: /พิเศษ/ }) as HTMLButtonElement;
    expect(third.disabled).toBe(true);
  });

  test('a sold-out option cannot be chosen', () => {
    const { services, entities } = createTestServices();
    entities.apply({
      type: 'menu.upserted',
      kind: 'option',
      id: MENU.wide,
      rev: 900,
      data: {
        id: MENU.wide,
        groupId: MENU.gNoodle,
        nameTh: 'เส้นใหญ่',
        nameEn: 'Wide',
        priceDeltaSatang: satang(0),
        isAvailable: false,
        sort: 2,
        archived: false,
        version: 1,
        rev: 900,
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    const wide = within(screen.getByRole('dialog')).getByRole('radio', {
      name: /เส้นใหญ่/,
    }) as HTMLButtonElement;
    expect(wide.disabled).toBe(true);
    expect(wide.closest('label')?.textContent).toContain(th['pos.orderEntry.soldOut']);
  });

  test('the second time, one tap repeats the last choices without the sheet', async () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    await pickNoodleChoices();
    click(within(screen.getByRole('dialog')).getByRole('button', { name: /^เพิ่ม ·/ }));
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cart.getState().lines[0]?.qty).toBe(2);
  });

  test('Escape closes the sheet and adds nothing', () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cart.getState().lines).toHaveLength(0);
  });

  test('the quantity badge on a tile shows what is already in the order', () => {
    const { services } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(tile('ชาเย็น'));
    expect(tile('ชาเย็น').textContent).toContain('2');
  });
});

describe('the order panel', () => {
  test('is empty at first, with the create button off', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    expect(screen.getAllByText(th['pos.orderEntry.emptyCart']).length).toBeGreaterThan(0);
    const place = screen.getByRole('button', {
      name: new RegExp(th['pos.orderEntry.place']),
    }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
  });

  test('lists lines with their choices and note, and the running total is labelled an estimate', async () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    const dialog = await pickNoodleChoices('เส้นใหญ่', 'เผ็ดมาก');
    click(within(dialog).getByRole('checkbox', { name: /ไข่ต้ม/ }));
    fireEvent.change(within(dialog).getByLabelText(th['common.note']), {
      target: { value: 'แยกน้ำ' },
    });
    click(within(dialog).getByRole('button', { name: /^เพิ่ม ·/ }));
    click(tile('ชาเย็น'));
    const panel = screen.getByRole('region', { name: th['pos.orderEntry.newOrder'] });
    expect(panel.textContent).toContain('เส้นใหญ่');
    expect(panel.textContent).toContain('เผ็ดมาก');
    expect(panel.textContent).toContain('ไข่ต้ม');
    expect(panel.textContent).toContain('แยกน้ำ');
    expect(panel.textContent).toContain('฿60.00');
    expect(panel.textContent).toContain(th['pos.orderEntry.estimate']);
    expect(panel.textContent).toContain('฿85.00');
  });

  test('steppers change the quantity, and going below one removes the line', () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: 'เพิ่มจำนวน ชาเย็น' }));
    expect(cart.getState().lines[0]?.qty).toBe(2);
    click(screen.getByRole('button', { name: 'ลดจำนวน ชาเย็น' }));
    click(screen.getByRole('button', { name: 'ลดจำนวน ชาเย็น' }));
    expect(cart.getState().lines).toHaveLength(0);
  });

  test('tapping a line opens its options to change them', async () => {
    const { services, cart } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ก๋วยเตี๋ยวต้มยำ'));
    await pickNoodleChoices();
    click(within(screen.getByRole('dialog')).getByRole('button', { name: /^เพิ่ม ·/ }));
    click(screen.getByRole('button', { name: /^แก้ไข ก๋วยเตี๋ยวต้มยำ/ }));
    const dialog = screen.getByRole('dialog');
    expect(radio(dialog, /เส้นเล็ก/).checked).toBe(true);
    click(within(dialog).getByRole('radio', { name: /เส้นใหญ่/ }));
    click(within(dialog).getByRole('button', { name: /^บันทึก ·/ }));
    expect(cart.getState().lines[0]?.optionIds).toEqual([MENU.wide, MENU.mild]);
  });

  test('marks a line whose dish went sold out after it was added, and will not send the order', async () => {
    const { services, entities, create } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    const tea = entities.getState().items.get(MENU.tea);
    act(() => {
      entities.apply({
        type: 'menu.upserted',
        kind: 'item',
        id: MENU.tea,
        rev: 950,
        data: { ...(tea as NonNullable<typeof tea>), isAvailable: false, rev: 950 },
      });
    });
    expect(screen.getAllByText(th['pos.orderEntry.lineProblem']).length).toBeGreaterThan(0);
    const place = screen.getByRole('button', {
      name: new RegExp(th['pos.orderEntry.place']),
    }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  test('room delivery asks for the room number and will not send without it', async () => {
    const { services, create } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('radio', { name: th['pos.orderEntry.fulfilment.room_delivery'] }));
    const room = screen.getByLabelText(th['pos.orderEntry.roomNo']) as HTMLInputElement;
    expect(room).toBeTruthy();
    const place = screen.getByRole('button', {
      name: new RegExp(th['pos.orderEntry.place']),
    }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
    fireEvent.change(room, { target: { value: '1204' } });
    expect(place.disabled).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('creating the order', () => {
  const created = (orderNo = 'S-007') =>
    ({
      order: orderDto(uuid(900), 500, {
        orderNo,
        subtotalSatang: satang(2500),
        totalSatang: satang(2500),
      }),
      replay: false,
      clientRequestId: uuid(1),
    }) as Awaited<ReturnType<import('../api/client.ts').ApiClient['orders']['create']>>;

  test('sends the order once, and goes to the order page with the number from the server', async () => {
    const { services, create } = createTestServices({ create: async () => created() });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: new RegExp(th['pos.orderEntry.place']) }));
    await waitFor(() => expect(window.location.hash).toBe(`#/orders/${uuid(900)}`));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      channel: 'storefront',
      fulfillment: 'dine_in',
      items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
    });
  });

  test('a double tap creates one order; the button is off while the request runs', async () => {
    let release!: () => void;
    const { services, create } = createTestServices({
      create: () =>
        new Promise((resolve) => {
          release = () => resolve(created());
        }),
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    const place = () =>
      screen.getByRole('button', {
        name: new RegExp(th['pos.orderEntry.place']),
      }) as HTMLButtonElement;
    fireEvent.click(place());
    fireEvent.click(place());
    expect(create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(place().disabled).toBe(true));
    expect(screen.getAllByText(th['pos.orderEntry.placing']).length).toBeGreaterThan(0);
    await act(async () => release());
    await waitFor(() => expect(window.location.hash).toBe(`#/orders/${uuid(900)}`));
  });

  test('a refusal is explained in Thai, from our own text, and the order stays', async () => {
    const { services, cart } = createTestServices({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', {
          status: 422,
          lineErrors: [{ code: 'ITEM_UNAVAILABLE', lineIndex: 0 }],
        });
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: new RegExp(th['pos.orderEntry.place']) }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['error.itemUnavailable']);
    expect(cart.getState().lines).toHaveLength(1);
    expect(window.location.hash).toBe('#/new');
  });

  test('an unanswered request locks the order and says a retry will not create it twice', async () => {
    const { services, cart } = createTestServices({
      create: async () => {
        throw new ApiClientError('TIMEOUT');
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: new RegExp(th['pos.orderEntry.place']) }));
    await screen.findByText(th['pos.orderEntry.unsure']);
    expect(cart.getState().phase).toBe('unsure');
    expect(
      (screen.getByRole('button', { name: 'เพิ่มจำนวน ชาเย็น' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((tile('ชาเย็น') as HTMLButtonElement).disabled).toBe(true);
    // The order can still be discarded.
    click(screen.getByRole('button', { name: th['pos.orderEntry.clear'] }));
    expect(cart.getState().lines).toHaveLength(0);
  });
});

describe('language', () => {
  test('the same screen reads in English', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services, 'en');
    expect(screen.getByRole('button', { name: /Tom yum noodles/ })).toBeTruthy();
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe(
      en['pos.orderEntry.searchPlaceholder'],
    );
    expect(screen.getAllByText(en['pos.orderEntry.emptyCart']).length).toBeGreaterThan(0);
  });
});
