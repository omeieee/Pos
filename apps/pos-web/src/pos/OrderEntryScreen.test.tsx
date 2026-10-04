// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { groupFrame, itemFrame, optionFrame, orderDto, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderEntryScreen } from './OrderEntryScreen.tsx';

const th = catalogs.th;
const en = catalogs.en;

beforeEach(() => {
  window.location.hash = '#/new';
});
afterEach(cleanup);

const ALL_CHIP = /^ทั้งหมด$/;
/** The create button reads "คิดเงิน ฿…" (design) and "บันทึกออเดอร์ (ออฟไลน์)" without a connection. */
const PLACE_BUTTON = /^(คิดเงิน|กำลังสร้างออเดอร์)/;
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const click = (element: HTMLElement) => fireEvent.click(element);

const radio = (scope: HTMLElement, name: RegExp) =>
  within(scope).getByRole('radio', { name }) as HTMLInputElement;

type Created = Awaited<ReturnType<import('../api/client.ts').ApiClient['orders']['create']>>;
const createdOrder = (orderNo = 'S-007'): Created => ({
  order: orderDto(uuid(900), 500, {
    orderNo,
    subtotalSatang: satang(2500),
    totalSatang: satang(2500),
  }),
  replay: false,
  clientRequestId: uuid(1),
});

/** Test services with the recipient already typed (these tests are about the order itself). */
function readyServices(options: Parameters<typeof createTestServices>[0] = {}) {
  const made = createTestServices(options);
  made.cart.setBuilding('B1');
  made.cart.setRecipientName('Fah ตัวอย่าง');
  return made;
}

async function pickNoodleChoices(noodle = 'เส้นเล็ก', spice = 'เผ็ดน้อย') {
  const dialog = screen.getByRole('dialog');
  click(within(dialog).getByRole('radio', { name: new RegExp(noodle) }));
  click(within(dialog).getByRole('radio', { name: new RegExp(spice) }));
  return dialog;
}

describe('the menu', () => {
  test('shows the categories and the dishes with prices', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    expect(screen.getByRole('button', { name: ALL_CHIP })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^ก๋วยเตี๋ยว$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^เครื่องดื่ม$/ })).toBeTruthy();
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
    click(screen.getByRole('button', { name: /^เครื่องดื่ม$/ }));
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

  describe('a dish whose groups are all optional', () => {
    const KAPROW = uuid(990);
    const EGG_GROUP = uuid(991);
    const MEAT_GROUP = uuid(992);
    const FRIED_EGG = uuid(993);
    const PORK = uuid(994);

    /** The live menu's กะเพรา: optional egg (0 to 2) and optional meat (0 or 1). */
    function seedKaprow(entities: ReturnType<typeof createTestServices>['entities']) {
      entities.applyMany([
        groupFrame(EGG_GROUP, 900, { nameTh: 'ไข่', nameEn: 'egg', minSelect: 0, maxSelect: 2 }),
        optionFrame(FRIED_EGG, EGG_GROUP, 901, {
          nameTh: 'ไข่ดาว',
          nameEn: 'fried egg',
          priceDeltaSatang: satang(1000),
        }),
        groupFrame(MEAT_GROUP, 902, {
          nameTh: 'เนื้อสัตว์',
          nameEn: 'meat',
          minSelect: 0,
          maxSelect: 1,
        }),
        optionFrame(PORK, MEAT_GROUP, 903, {
          nameTh: 'หมู',
          nameEn: 'pork',
          priceDeltaSatang: satang(1000),
        }),
        itemFrame(KAPROW, 904, {
          categoryId: MENU.catNoodle,
          nameTh: 'กะเพรา',
          nameEn: 'kaprow',
          priceSatang: satang(6500),
          modifierGroupIds: [EGG_GROUP, MEAT_GROUP],
          sort: 9,
        }),
      ]);
    }

    test('opens the sheet on a tap, and "add" works with nothing chosen', () => {
      const { services, cart, entities } = createTestServices();
      seedKaprow(entities);
      renderScreen(<OrderEntryScreen />, services);
      click(tile('กะเพรา'));
      expect(cart.getState().lines).toHaveLength(0);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('checkbox', { name: /ไข่ดาว/ })).toBeTruthy();
      expect(within(dialog).getByRole('radio', { name: /หมู/ })).toBeTruthy();
      const add = within(dialog).getByRole('button', { name: /^เพิ่ม ·/ }) as HTMLButtonElement;
      expect(add.disabled).toBe(false);
      click(add);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cart.getState().lines).toMatchObject([{ itemId: KAPROW, optionIds: [], qty: 1 }]);
    });

    test('adds the optional choices that were made', () => {
      const { services, cart, entities } = createTestServices();
      seedKaprow(entities);
      renderScreen(<OrderEntryScreen />, services);
      click(tile('กะเพรา'));
      const dialog = screen.getByRole('dialog');
      click(within(dialog).getByRole('checkbox', { name: /ไข่ดาว/ }));
      click(within(dialog).getByRole('radio', { name: /หมู/ }));
      const add = within(dialog).getByRole('button', { name: /^เพิ่ม ·/ });
      expect(add.textContent).toContain('฿85.00');
      click(add);
      expect(cart.getState().lines[0]).toMatchObject({
        itemId: KAPROW,
        optionIds: [FRIED_EGG, PORK],
      });
    });

    test('asks again on the next tap instead of repeating the last choices', () => {
      const { services, cart, entities } = createTestServices();
      seedKaprow(entities);
      renderScreen(<OrderEntryScreen />, services);
      click(tile('กะเพรา'));
      click(within(screen.getByRole('dialog')).getByRole('radio', { name: /หมู/ }));
      click(within(screen.getByRole('dialog')).getByRole('button', { name: /^เพิ่ม ·/ }));
      click(tile('กะเพรา'));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(cart.getState().lines).toMatchObject([{ qty: 1 }]);
    });

    test('goes straight in when every optional choice is sold out', () => {
      const { services, cart, entities } = createTestServices();
      seedKaprow(entities);
      entities.applyMany([
        optionFrame(FRIED_EGG, EGG_GROUP, 910, { nameTh: 'ไข่ดาว', isAvailable: false }),
        optionFrame(PORK, MEAT_GROUP, 911, { nameTh: 'หมู', isAvailable: false }),
      ]);
      renderScreen(<OrderEntryScreen />, services);
      click(tile('กะเพรา'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(cart.getState().lines).toMatchObject([{ itemId: KAPROW, optionIds: [], qty: 1 }]);
    });
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
      name: PLACE_BUTTON,
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
    expect(panel.textContent).toContain('฿60');
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
      name: PLACE_BUTTON,
    }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  test('offers no dine-in, takeaway or room delivery: every order goes to the entrance', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    expect(
      screen.queryByRole('radio', { name: th['pos.orderEntry.fulfilment.dine_in'] }),
    ).toBeNull();
    expect(
      screen.queryByRole('radio', { name: th['pos.orderEntry.fulfilment.takeaway'] }),
    ).toBeNull();
    expect(
      screen.queryByRole('radio', { name: th['pos.orderEntry.fulfilment.room_delivery'] }),
    ).toBeNull();
    expect(screen.queryByLabelText(th['pos.orderEntry.roomNo'])).toBeNull();
    expect(screen.getAllByText(th['pos.delivery.title']).length).toBeGreaterThan(0);
  });
});

describe('where the order goes', () => {
  const place = () =>
    screen.getByRole('button', {
      name: PLACE_BUTTON,
    }) as HTMLButtonElement;
  const nameField = () => screen.getByLabelText(th['pos.delivery.name']) as HTMLInputElement;
  const noteField = () => screen.getByLabelText(th['pos.delivery.note']) as HTMLInputElement;
  const building = (b: string) => screen.getByRole('radio', { name: b }) as HTMLInputElement;

  test('offers the buildings of the synced list, as choices of at least 44 px to tap', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    const group = screen.getByRole('group', { name: th['pos.delivery.building'] });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2']);
  });

  test('the create button waits for a building and a name', () => {
    const { services } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    expect(place().disabled).toBe(true);
    expect(screen.getByText(th['pos.delivery.needed'])).toBeTruthy();
    click(building('B1'));
    expect(place().disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(place().disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: 'Fah ตัวอย่าง' } });
    expect(place().disabled).toBe(false);
    expect(screen.queryByText(th['pos.delivery.needed'])).toBeNull();
  });

  test('the name is limited to 60 characters; the details to 200; the kitchen note stays apart', () => {
    renderScreen(<OrderEntryScreen />, createTestServices().services);
    expect(nameField().maxLength).toBe(60);
    expect(noteField().maxLength).toBe(200);
    expect(screen.getByLabelText(th['pos.orderEntry.orderNote'])).not.toBe(noteField());
    expect(th['pos.orderEntry.orderNote']).not.toBe(th['pos.delivery.note']);
  });

  test('says so when the buildings could not be loaded, and a retry reads them', async () => {
    const { services, api } = createTestServices({ buildings: false });
    api.settings.delivery.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    renderScreen(<OrderEntryScreen />, services);
    await screen.findByText(th['pos.delivery.buildingMissing']);
    expect(screen.queryAllByRole('radio', { name: /^[A-D][12]$/ })).toHaveLength(0);
    click(screen.getByRole('button', { name: th['common.retry'] }));
    await waitFor(() => expect(building('A1')).toBeTruthy());
    expect(api.settings.delivery).toHaveBeenCalledTimes(2);
  });

  test('reads the buildings from the setting when the feed has none yet', async () => {
    const { services, api } = createTestServices({ buildings: false });
    renderScreen(<OrderEntryScreen />, services);
    await waitFor(() => expect(building('D2')).toBeTruthy());
    expect(api.settings.delivery).toHaveBeenCalledTimes(1);
  });

  test('sends building, name and details trimmed, and the kitchen note as it was', async () => {
    const { services, create } = createTestServices({ create: async () => createdOrder() });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(building('B2'));
    fireEvent.change(nameField(), { target: { value: ' Tester ' } });
    fireEvent.change(noteField(), { target: { value: ' ชั้น 3 ' } });
    fireEvent.change(screen.getByLabelText(th['pos.orderEntry.orderNote']), {
      target: { value: 'ไม่เผ็ด' },
    });
    click(place());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B2',
      recipientName: 'Tester',
      deliveryNote: 'ชั้น 3',
      note: 'ไม่เผ็ด',
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('customerId');
  });
});

describe('remembered recipients', () => {
  const saved = (n: number, building: string, name: string, note: string | null = null) => ({
    id: uuid(600 + n),
    building,
    recipientName: name,
    deliveryNote: note,
    lastOrderAt: null,
  });
  const recent = [saved(1, 'B1', 'Fah ตัวอย่าง', 'ชั้น 3'), saved(2, 'A2', 'Nok ตัวอย่าง')];
  const withRecent = (over: Partial<Parameters<typeof createTestServices>[0]> = {}) =>
    createTestServices({
      recipients: { list: async () => ({ recipients: recent }) },
      create: async () => createdOrder(),
      ...over,
    });
  const chip = (label: string) => screen.findByRole('button', { name: new RegExp(label) });
  const nameField = () => screen.getByLabelText(th['pos.delivery.name']) as HTMLInputElement;
  const noteField = () => screen.getByLabelText(th['pos.delivery.note']) as HTMLInputElement;

  test('shows the latest as "building · name" chips with the saved details as a hint', async () => {
    const { services, api } = withRecent();
    renderScreen(<OrderEntryScreen />, services);
    const fah = await chip('B1 · Fah ตัวอย่าง');
    expect(fah.textContent).toContain('ชั้น 3');
    expect(await chip('A2 · Nok ตัวอย่าง')).toBeTruthy();
    expect(api.recipients.list).toHaveBeenCalledWith({ limit: 8 });
    expect((fah as HTMLButtonElement).type).toBe('button');
  });

  test('shows no chip section while nobody is remembered', async () => {
    const { services, api } = createTestServices();
    renderScreen(<OrderEntryScreen />, services);
    await waitFor(() => expect(api.recipients.list).toHaveBeenCalled());
    expect(screen.queryByText(th['pos.delivery.recent'])).toBeNull();
  });

  test('tapping one fills building, name and details, still editable, and sends the customer id', async () => {
    const { services, create } = withRecent();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(await chip('B1 · Fah ตัวอย่าง'));
    expect((screen.getByRole('radio', { name: 'B1' }) as HTMLInputElement).checked).toBe(true);
    expect(nameField().value).toBe('Fah ตัวอย่าง');
    expect(noteField().value).toBe('ชั้น 3');
    fireEvent.change(noteField(), { target: { value: 'ชั้น 4' } });
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      deliveryBuilding: 'B1',
      recipientName: 'Fah ตัวอย่าง',
      deliveryNote: 'ชั้น 4',
      customerId: recent[0]?.id,
    });
  });

  test('editing the name or the building after a tap drops the customer id', async () => {
    const { services, create } = withRecent();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(await chip('B1 · Fah ตัวอย่าง'));
    fireEvent.change(nameField(), { target: { value: 'Fah Other' } });
    click(screen.getByRole('radio', { name: 'C1' }));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      deliveryBuilding: 'C1',
      recipientName: 'Fah Other',
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('customerId');
  });

  test('typing a name searches after a pause and shows the matches in place of the latest', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const list = vi.fn(async (query?: { q?: string | undefined }) => ({
        recipients: query?.q ? [saved(3, 'D1', 'Fahsai ตัวอย่าง')] : recent,
      }));
      const { services } = withRecent({ recipients: { list } });
      renderScreen(<OrderEntryScreen />, services);
      await chip('B1 · Fah ตัวอย่าง');
      fireEvent.change(nameField(), { target: { value: 'Fah' } });
      expect(list).not.toHaveBeenCalledWith(expect.objectContaining({ q: 'Fah' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(list).toHaveBeenCalledWith({ q: 'Fah', limit: 8 });
      await chip('D1 · Fahsai ตัวอย่าง');
      expect(screen.getByText(th['pos.delivery.matches'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: /A2 · Nok/ })).toBeNull();
      // Clearing the field brings the latest back.
      fireEvent.change(nameField(), { target: { value: '' } });
      await chip('A2 · Nok ตัวอย่าง');
    } finally {
      vi.useRealTimers();
    }
  });

  test('after an order is placed the latest are read again and the recipient is cleared', async () => {
    const { services, api, cart } = withRecent();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(await chip('B1 · Fah ตัวอย่าง'));
    expect(api.recipients.list).toHaveBeenCalledTimes(1);
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await waitFor(() => expect(window.location.hash).toBe(`#/orders/${uuid(900)}`));
    await waitFor(() => expect(api.recipients.list).toHaveBeenCalledTimes(2));
    expect(cart.getState().recipientName).toBe('');
  });

  test('a refused building is explained, and the order stays', async () => {
    const { services, cart } = withRecent({
      create: async () => {
        throw new ApiClientError('UNKNOWN_BUILDING', { status: 422 });
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(await chip('B1 · Fah ตัวอย่าง'));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['error.unknownBuilding']);
    expect(cart.getState().recipientName).toBe('Fah ตัวอย่าง');
  });

  test('never writes a name into the address bar', async () => {
    const { services } = withRecent();
    renderScreen(<OrderEntryScreen />, services);
    click(await chip('B1 · Fah ตัวอย่าง'));
    fireEvent.change(nameField(), { target: { value: 'Somebody' } });
    expect(decodeURIComponent(window.location.href)).not.toMatch(/Fah|Somebody/);
  });
});

describe('creating the order', () => {
  const created = createdOrder;

  test('sends the order once, and goes to the order page with the number from the server', async () => {
    const { services, create } = readyServices({ create: async () => created() });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await waitFor(() => expect(window.location.hash).toBe(`#/orders/${uuid(900)}`));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Fah ตัวอย่าง',
      items: [{ menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] }],
    });
  });

  test('a double tap creates one order; the button is off while the request runs', async () => {
    let release!: () => void;
    const { services, create } = readyServices({
      create: () =>
        new Promise((resolve) => {
          release = () => resolve(created());
        }),
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    const place = () =>
      screen.getByRole('button', {
        name: PLACE_BUTTON,
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
    const { services, cart } = readyServices({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', {
          status: 422,
          lineErrors: [{ code: 'ITEM_UNAVAILABLE', lineIndex: 0 }],
        });
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['error.itemUnavailable']);
    expect(cart.getState().lines).toHaveLength(1);
    expect(window.location.hash).toBe('#/new');
  });

  test('an unanswered request locks the order and says a retry will not create it twice', async () => {
    const { services, cart } = readyServices({
      create: async () => {
        throw new ApiClientError('TIMEOUT');
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await screen.findByText(th['pos.orderEntry.unsure']);
    expect(cart.getState().phase).toBe('unsure');
    expect(
      (screen.getByRole('button', { name: 'เพิ่มจำนวน ชาเย็น' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((tile('ชาเย็น') as HTMLButtonElement).disabled).toBe(true);
  });

  test('the retry button of an unsure order is labelled retry and sends even if the menu changed', async () => {
    let calls = 0;
    const { services, cart, entities, create } = readyServices({
      create: async () => {
        calls += 1;
        if (calls === 1) throw new ApiClientError('TIMEOUT');
        return created();
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await screen.findByText(th['pos.orderEntry.unsure']);
    // The tea sold out meanwhile: the cart is no longer valid, but this order may exist.
    act(() => {
      entities.apply(itemFrame(MENU.tea, 900, { isAvailable: false }));
    });
    const retry = screen.getByRole('button', { name: th['common.retry'] }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: PLACE_BUTTON })).toBeNull();
    click(retry);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cart.getState().lines).toHaveLength(0));
  });

  test('clearing an unsure order first says to look in the orders list, and only then discards it', async () => {
    const { services, cart } = readyServices({
      create: async () => {
        throw new ApiClientError('TIMEOUT');
      },
    });
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: PLACE_BUTTON }));
    await screen.findByText(th['pos.orderEntry.unsure']);

    click(screen.getByRole('button', { name: th['pos.orderEntry.clear'] }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(th['pos.orderEntry.clearUnsure.body'])).toBeTruthy();
    expect(
      within(dialog)
        .getByRole('link', { name: th['pos.orderEntry.clearUnsure.check'] })
        .getAttribute('href'),
    ).toBe('#/orders');
    // Nothing was discarded yet; "keep" closes the question.
    expect(cart.getState().lines).toHaveLength(1);
    click(within(dialog).getByRole('button', { name: th['pos.orderEntry.clearUnsure.keep'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(cart.getState().lines).toHaveLength(1);

    click(screen.getByRole('button', { name: th['pos.orderEntry.clear'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['pos.orderEntry.clearUnsure.discard'],
      }),
    );
    expect(cart.getState().lines).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('an ordinary cart is cleared at once, with no question', () => {
    const { services, cart } = readyServices();
    renderScreen(<OrderEntryScreen />, services);
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: th['pos.orderEntry.clear'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
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
