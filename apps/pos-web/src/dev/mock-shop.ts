/**
 * A made-up shop for `pnpm dev` with `VITE_MOCK_API=1` and for tests: a small menu, orders and the
 * sync and socket protocols, in the shapes apps/api sends (the shared schemas parse them). It is
 * reached through mock-server.ts (which checks the session first) and `enable.ts`, which is
 * guarded by `import.meta.env.DEV`, so production builds do not contain it.
 *
 * Orders are priced with the SAME shared function the real server uses, so the totals the screens
 * show after "create order" are real ones. Everything here is made up; nothing is persisted.
 */
import {
  allowedFulfillments,
  type CatalogGroup,
  type CatalogItem,
  type CategoryDto,
  createOrderInputSchema,
  DEFAULT_DELIVERY_SETTINGS,
  type GroupDto,
  type ItemDto,
  initialOrderStatus,
  type OptionDto,
  type OrderDto,
  orderIdParamSchema,
  type PricingError,
  priceOrder,
  type RealtimeFrame,
  type RecipientDto,
  recipientKey,
  recipientsQuerySchema,
  type SyncChange,
  satang,
  syncQuerySchema,
  ZERO,
} from '@sds/shared';
import type { SocketFactory, SocketHandlers } from '../platform/socket.ts';
import { createMockPayments, type MockCaller } from './mock-payments.ts';

export interface MockShopOptions {
  now?: () => number;
}

export interface MockAnswer {
  status: number;
  body: unknown;
}

// ---------- The menu ----------

let seed = 0;
/** Ids that are the same on every run, so a reload keeps the same dishes. */
const id = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const category = (
  n: number,
  nameTh: string,
  nameEn: string,
  sort: number,
): Omit<CategoryDto, 'rev'> => ({
  id: id(100 + n),
  nameTh,
  nameEn,
  sort,
  active: true,
  version: 1,
});

const option = (
  n: number,
  groupId: string,
  nameTh: string,
  nameEn: string,
  priceDelta = 0,
  extra: Partial<OptionDto> = {},
): Omit<OptionDto, 'rev'> => ({
  id: id(400 + n),
  groupId,
  nameTh,
  nameEn,
  priceDeltaSatang: satang(priceDelta),
  isAvailable: true,
  sort: n,
  archived: false,
  version: 1,
  ...extra,
});

const GROUP_NOODLE = id(301);
const GROUP_SPICE = id(302);
const GROUP_EXTRA = id(303);

const CATEGORIES = [
  category(1, 'ก๋วยเตี๋ยว', 'Noodles', 1),
  category(2, 'ของทานเล่น', 'Snacks', 2),
  category(3, 'เครื่องดื่ม', 'Drinks', 3),
];

const GROUPS: Omit<GroupDto, 'rev' | 'options'>[] = [
  {
    id: GROUP_NOODLE,
    nameTh: 'เส้น',
    nameEn: 'Noodle',
    minSelect: 1,
    maxSelect: 1,
    sort: 1,
    archived: false,
    version: 1,
  },
  {
    id: GROUP_SPICE,
    nameTh: 'ความเผ็ด',
    nameEn: 'Spice',
    minSelect: 1,
    maxSelect: 1,
    sort: 2,
    archived: false,
    version: 1,
  },
  {
    id: GROUP_EXTRA,
    nameTh: 'เพิ่มเติม',
    nameEn: 'Extras',
    minSelect: 0,
    maxSelect: 3,
    sort: 3,
    archived: false,
    version: 1,
  },
];

const OPTIONS = [
  option(1, GROUP_NOODLE, 'เส้นเล็ก', 'Thin'),
  option(2, GROUP_NOODLE, 'เส้นใหญ่', 'Wide'),
  option(3, GROUP_NOODLE, 'บะหมี่', 'Egg noodle'),
  option(4, GROUP_NOODLE, 'วุ้นเส้น', 'Glass noodle', 0, { isAvailable: false }),
  option(5, GROUP_SPICE, 'ไม่เผ็ด', 'Not spicy'),
  option(6, GROUP_SPICE, 'เผ็ดน้อย', 'Mild'),
  option(7, GROUP_SPICE, 'เผ็ดกลาง', 'Medium'),
  option(8, GROUP_SPICE, 'เผ็ดมาก', 'Hot'),
  option(9, GROUP_EXTRA, 'พิเศษ', 'Large', 1000),
  option(10, GROUP_EXTRA, 'ไข่ต้ม', 'Boiled egg', 1000),
  option(11, GROUP_EXTRA, 'ลูกชิ้น', 'Meatballs', 1500),
  option(12, GROUP_EXTRA, 'ไม่ใส่ผัก', 'No vegetables'),
];

type ItemSeed = Omit<
  ItemDto,
  'rev' | 'descriptionTh' | 'descriptionEn' | 'imageUrl' | 'archived' | 'version'
>;

const item = (
  n: number,
  cat: number,
  nameTh: string,
  nameEn: string,
  price: number,
  over: Partial<ItemSeed> = {},
): ItemSeed => ({
  id: id(200 + n),
  categoryId: id(100 + cat),
  nameTh,
  nameEn,
  priceSatang: satang(price),
  isAvailable: true,
  // Sold on both delivery platforms, each at its own price (฿5 and ฿7 more than in the shop).
  channels: ['storefront', 'line', 'grab', 'lineman'],
  channelPrices: { grab: satang(price + 500), lineman: satang(price + 700) },
  modifierGroupIds: [],
  sort: n,
  ...over,
});

const noodleGroups = [GROUP_NOODLE, GROUP_SPICE, GROUP_EXTRA];
const ITEMS: ItemSeed[] = [
  item(1, 1, 'ก๋วยเตี๋ยวต้มยำ', 'Tom yum noodles', 5000, { modifierGroupIds: noodleGroups }),
  item(2, 1, 'ก๋วยเตี๋ยวน้ำใส', 'Clear soup noodles', 4500, { modifierGroupIds: noodleGroups }),
  item(3, 1, 'เย็นตาโฟ', 'Yen ta fo', 5000, { modifierGroupIds: noodleGroups }),
  item(4, 1, 'ก๋วยเตี๋ยวเรือหมูน้ำตกสูตรเข้มข้นใส่เลือดหมู', 'Boat noodles with pork and blood', 5500, {
    modifierGroupIds: noodleGroups,
  }),
  item(5, 1, 'ต้มยำทะเลรวมมิตร', 'Mixed seafood tom yum', 7000, {
    isAvailable: false,
    modifierGroupIds: noodleGroups,
  }),
  item(6, 2, 'เกี๊ยวทอด', 'Fried wontons', 3500),
  item(7, 2, 'ลูกชิ้นทอด', 'Fried meatballs', 3000),
  item(8, 3, 'ชาเย็น', 'Thai iced tea', 2500),
  item(9, 3, 'น้ำเก๊กฮวย', 'Chrysanthemum tea', 2000),
  item(10, 3, 'น้ำเปล่า', 'Water', 1000),
];

// ---------- The shop ----------

const frameKey = (frame: SyncChange): string =>
  frame.type === 'menu.upserted'
    ? `${frame.type}:${frame.kind}:${frame.id}`
    : `${frame.type}:${frame.id}`;

const errorBody = (code: string, details: Record<string, unknown> = {}) => ({
  code,
  message: 'mock server error',
  details,
});

export function createMockShop(options: MockShopOptions = {}) {
  const now = options.now ?? Date.now;
  let rev = 0;
  const latest = new Map<string, SyncChange>();
  const orders = new Map<string, OrderDto>();
  const byRequest = new Map<string, OrderDto>();
  /** What each request id carried, so a reused id with another body is refused like the server does. */
  const requestBodies = new Map<string, string>();
  let orderSeq = 0;
  /**
   * Dev only: changes the server's prices and availability WITHOUT telling any client (no frame), as
   * if the owner edited the menu while a counter was offline. The order the offline counter saved is
   * then refused, or its cash comes up short, when it syncs.
   */
  const silent = { priceBump: 0, soldOut: new Set<string>() };
  let offline = false;
  let uuidCounter = 5000 + seed++;
  const newUuid = () => id(++uuidCounter);

  interface OpenSocket {
    handlers: SocketHandlers;
    ready: boolean;
    timer: ReturnType<typeof setInterval> | undefined;
  }
  const sockets = new Set<OpenSocket>();

  function publish(frame: SyncChange) {
    latest.set(frameKey(frame), frame);
    const text = JSON.stringify(frame);
    for (const socket of sockets) if (socket.ready) socket.handlers.message(text);
  }

  function seedMenu() {
    for (const c of CATEGORIES) {
      const r = ++rev;
      publish({
        type: 'menu.upserted',
        kind: 'category',
        id: c.id,
        rev: r,
        data: { ...c, rev: r },
      });
    }
    for (const g of GROUPS) {
      const own = OPTIONS.filter((o) => o.groupId === g.id);
      const optionRows = own.map((o) => ({ ...o, rev: ++rev }));
      for (const o of optionRows) {
        publish({ type: 'menu.upserted', kind: 'option', id: o.id, rev: o.rev, data: o });
      }
      const r = ++rev;
      publish({
        type: 'menu.upserted',
        kind: 'group',
        id: g.id,
        rev: r,
        data: { ...g, rev: r, options: optionRows },
      });
    }
    for (const i of ITEMS) {
      const r = ++rev;
      publish({
        type: 'menu.upserted',
        kind: 'item',
        id: i.id,
        rev: r,
        data: {
          ...i,
          descriptionTh: null,
          descriptionEn: null,
          imageUrl: null,
          archived: false,
          version: 1,
          rev: r,
        },
      });
    }
  }
  seedMenu();

  // Order moves, payments and the payment settings (see mock-payments.ts).
  const payments = createMockPayments({
    now,
    orders,
    nextRev: () => ++rev,
    newUuid,
    publish: (frame) => publish(frame as SyncChange),
  });
  for (const frame of payments.settingsFrames()) publish(frame as SyncChange);

  /** The catalog the pricing function wants, from the made-up rows (costs are zero). */
  function catalog(): Map<string, CatalogItem> {
    const groups = new Map<string, CatalogGroup>(
      GROUPS.map((g) => [
        g.id,
        {
          id: g.id,
          nameTh: g.nameTh,
          nameEn: g.nameEn,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          archived: false,
          options: OPTIONS.filter((o) => o.groupId === g.id).map((o) => ({
            id: o.id,
            nameTh: o.nameTh,
            nameEn: o.nameEn,
            priceDeltaSatang: o.priceDeltaSatang,
            costDeltaSatang: ZERO,
            isAvailable: o.isAvailable,
            archived: false,
          })),
        },
      ]),
    );
    return new Map(
      ITEMS.map((i) => [
        i.id,
        {
          id: i.id,
          nameTh: i.nameTh,
          nameEn: i.nameEn,
          priceSatang: satang(i.priceSatang + silent.priceBump),
          estCostSatang: ZERO,
          isAvailable: i.isAvailable && !silent.soldOut.has(i.id),
          archived: false,
          categoryActive: true,
          channels: i.channels,
          channelPrices: Object.fromEntries(
            Object.entries(i.channelPrices).map(([channel, price]) => [
              channel,
              satang(Number(price) + silent.priceBump),
            ]),
          ),
          groups: i.modifierGroupIds.flatMap((gid) => {
            const group = groups.get(gid);
            return group ? [group] : [];
          }),
        },
      ]),
    );
  }

  // ---------- Remembered recipients (made up) ----------

  interface Remembered extends RecipientDto {
    nameKey: string;
  }
  const remembered = new Map<string, Remembered>();
  const BUILDINGS: readonly string[] = DEFAULT_DELIVERY_SETTINGS.buildings;
  const ago = (minutes: number) => new Date(now() - minutes * 60_000).toISOString();
  for (const [building, name, note, minutes] of [
    ['B1', 'Fah Example', 'ชั้น 3 เสื้อแดง', 20],
    ['A2', 'Nok Example', null, 90],
    ['C1', 'Mali Example', 'ฝากไว้กับ รปภ.', 1500],
  ] as const) {
    const row = {
      id: newUuid(),
      building,
      recipientName: name,
      nameKey: recipientKey(name),
      deliveryNote: note,
      lastOrderAt: ago(minutes),
    };
    remembered.set(row.id, row);
  }

  /** What the server does for an entrance order: find or create the recipient, keep the latest details. */
  function recordRecipient(
    building: string,
    name: string,
    note: string | null,
    customerId?: string,
  ): string {
    const nameKey = recipientKey(name);
    const stamp = new Date(now()).toISOString();
    const twin = [...remembered.values()].find(
      (r) => r.building === building && r.nameKey === nameKey,
    );
    // Given an id, the server renames that customer to what the order says (unless that is
    // somebody else already): which is why the screen sends it only for an unchanged recipient.
    const named = customerId ? remembered.get(customerId) : undefined;
    const row =
      named && (!twin || twin.id === named.id) ? named : (twin ?? { id: newUuid(), nameKey });
    const next: Remembered = {
      id: row.id,
      building,
      recipientName: name,
      nameKey,
      deliveryNote: note,
      lastOrderAt: stamp,
    };
    remembered.set(next.id, next);
    return next.id;
  }

  function listRecipients(query: URLSearchParams): MockAnswer {
    const parsed = recipientsQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) return { status: 400, body: errorBody('VALIDATION_ERROR') };
    const { q, building, limit } = parsed.data;
    const wanted = q ? recipientKey(q) : '';
    const rows = [...remembered.values()]
      .filter((r) => (!building || r.building === building) && r.nameKey.includes(wanted))
      .sort((a, b) => Date.parse(b.lastOrderAt ?? '') - Date.parse(a.lastOrderAt ?? ''))
      .slice(0, limit)
      .map(({ nameKey: _key, ...dto }) => dto);
    return { status: 200, body: { recipients: rows } };
  }

  function createOrder(body: unknown): MockAnswer {
    const input = createOrderInputSchema.safeParse(body);
    if (!input.success) return { status: 400, body: errorBody('VALIDATION_ERROR') };
    const { clientRequestId, ...content } = input.data;
    const fingerprint = JSON.stringify(content);
    const existing = byRequest.get(clientRequestId);
    if (existing) {
      // The same id with another body is a client bug, not a retry (the real server hashes it).
      return requestBodies.get(clientRequestId) === fingerprint
        ? { status: 200, body: existing }
        : { status: 409, body: errorBody('IDEMPOTENCY_KEY_REUSED') };
    }

    // Like the server: only entrance deliveries (and platform orders for their channels), and
    // only to a building on the list.
    if (!allowedFulfillments(input.data.channel).includes(input.data.fulfillment)) {
      return { status: 422, body: errorBody('FULFILLMENT_NOT_OFFERED') };
    }
    if (
      input.data.deliveryBuilding !== undefined &&
      !BUILDINGS.includes(input.data.deliveryBuilding)
    ) {
      return { status: 422, body: errorBody('UNKNOWN_BUILDING') };
    }

    const priced = priceOrder(input.data.channel, input.data.items, catalog());
    if (!priced.ok) {
      return {
        status: 422,
        body: errorBody('ORDER_INVALID', {
          errors: priced.errors.map((e: PricingError) => ({
            code: e.code,
            lineIndex: e.lineIndex,
            menuItemId: e.menuItemId,
          })),
        }),
      };
    }
    orderSeq += 1;
    const r = ++rev;
    const placedAt = new Date(now()).toISOString();
    const order: OrderDto = {
      id: newUuid(),
      orderNo: `S-${String(orderSeq).padStart(3, '0')}`,
      businessDate: placedAt.slice(0, 10),
      channel: input.data.channel,
      fulfillment: input.data.fulfillment,
      roomNo: input.data.roomNo ?? null,
      deliveryBuilding: input.data.deliveryBuilding ?? null,
      recipientName: input.data.recipientName ?? null,
      deliveryNote: input.data.deliveryNote || null,
      customerId:
        input.data.deliveryBuilding !== undefined && input.data.recipientName !== undefined
          ? recordRecipient(
              input.data.deliveryBuilding,
              input.data.recipientName,
              input.data.deliveryNote || null,
              input.data.customerId,
            )
          : (input.data.customerId ?? null),
      status: initialOrderStatus(input.data.channel),
      paymentStatus: 'unpaid',
      subtotalSatang: priced.totals.subtotal,
      discountSatang: priced.totals.discount,
      totalSatang: priced.totals.total,
      note: input.data.note ?? null,
      createdByStaffId: null,
      createdOnDeviceId: null,
      placedAt,
      acceptedAt: null,
      readyAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelReason: null,
      version: 1,
      rev: r,
      items: priced.lines.map((line) => ({
        id: newUuid(),
        menuItemId: line.menuItemId,
        nameTh: line.nameTh,
        nameEn: line.nameEn,
        unitPriceSatang: line.unitPriceSatang,
        qty: line.qty,
        modifiers: line.modifiers.map((m) => ({
          groupId: m.groupId,
          optionId: m.optionId,
          nameTh: m.nameTh,
          nameEn: m.nameEn,
          priceDeltaSatang: m.priceDeltaSatang,
        })),
        note: line.note,
        lineTotalSatang: line.lineTotalSatang,
      })),
    };
    orders.set(order.id, order);
    byRequest.set(clientRequestId, order);
    requestBodies.set(clientRequestId, fingerprint);
    publish({ type: 'order.upserted', id: order.id, rev: r, data: order });
    const alert: RealtimeFrame = {
      type: 'alert.new_order',
      id: order.id,
      data: {
        orderNo: order.orderNo,
        channel: order.channel,
        status: order.status,
        createdOnDeviceId: null,
      },
    };
    for (const socket of sockets) if (socket.ready) socket.handlers.message(JSON.stringify(alert));
    return { status: 201, body: order };
  }

  /**
   * A LINE order that arrives by itself, as `new` (it waits for staff to start it), with its
   * `alert.new_order`. Dev only: this is how the kitchen view and the sound are tried without a
   * second device. Dishes rotate so the tickets differ.
   */
  let incomingSeq = 0;
  function simulateIncomingOrder(): OrderDto {
    const samples = [
      {
        building: 'D1',
        name: 'Pim Example',
        details: 'ชั้น 5 ใส่เสื้อสีเขียว',
        note: 'ไม่ใส่ผักชี',
        items: [
          {
            menuItemId: id(201),
            qty: 2,
            modifierOptionIds: [id(401), id(407), id(410)],
            note: 'ไม่ใส่ถั่วงอก',
          },
          { menuItemId: id(208), qty: 1, modifierOptionIds: [] },
        ],
      },
      {
        building: 'A1',
        name: 'Ton Example',
        details: undefined,
        note: undefined,
        items: [
          { menuItemId: id(204), qty: 1, modifierOptionIds: [id(402), id(408)] },
          { menuItemId: id(206), qty: 2, modifierOptionIds: [] },
        ],
      },
    ];
    const sample = samples[incomingSeq++ % samples.length] ?? samples[0];
    if (!sample) throw new Error('no sample order');
    const answer = createOrder({
      clientRequestId: newUuid(),
      channel: 'line',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: sample.building,
      recipientName: sample.name,
      ...(sample.details ? { deliveryNote: sample.details } : {}),
      ...(sample.note ? { note: sample.note } : {}),
      items: sample.items,
    });
    return answer.body as OrderDto;
  }

  function sync(query: URLSearchParams): MockAnswer {
    const parsed = syncQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) return { status: 400, body: errorBody('VALIDATION_ERROR') };
    const { since, limit } = parsed.data;
    const newer = [...latest.values()].filter((f) => f.rev > since).sort((a, b) => a.rev - b.rev);
    const changes = newer.slice(0, limit);
    const last = changes[changes.length - 1];
    return {
      status: 200,
      body: {
        changes,
        nextSince: last ? last.rev : since,
        hasMore: newer.length > changes.length,
        serverRev: rev,
      },
    };
  }

  function publicMenu(): MockAnswer {
    const rows = catalog();
    return {
      status: 200,
      body: {
        channel: 'storefront',
        categories: CATEGORIES.map((c) => ({
          id: c.id,
          nameTh: c.nameTh,
          nameEn: c.nameEn,
          items: ITEMS.filter((i) => i.categoryId === c.id && i.isAvailable).map((i) => ({
            id: i.id,
            nameTh: i.nameTh,
            nameEn: i.nameEn,
            descriptionTh: null,
            descriptionEn: null,
            priceSatang: i.priceSatang,
            imageUrl: null,
            modifierGroups: (rows.get(i.id)?.groups ?? []).map((g) => ({
              id: g.id,
              nameTh: g.nameTh,
              nameEn: g.nameEn,
              minSelect: g.minSelect,
              maxSelect: g.maxSelect,
              options: g.options
                .filter((o) => o.isAvailable)
                .map((o) => ({
                  id: o.id,
                  nameTh: o.nameTh,
                  nameEn: o.nameEn,
                  priceDeltaSatang: o.priceDeltaSatang,
                })),
            })),
          })),
        })),
      },
    };
  }

  /**
   * Answers the routes of this shop (null: not one of them). The caller has checked the session
   * for everything except the public menu.
   */
  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    caller: MockCaller = { role: 'owner', stepUpFresh: true },
  ): MockAnswer | null {
    if (method === 'GET' && path === '/v1/menu') return publicMenu();
    const paid = payments.handle(method, path, body, caller);
    if (paid) return paid;
    if (method === 'GET' && path === '/v1/sync') return sync(query);
    if (method === 'GET' && path === '/v1/recipients') return listRecipients(query);
    if (method === 'GET' && path === '/v1/settings/delivery') {
      // Never saved: the default list, version 0 (so it is not in the sync feed either).
      return {
        status: 200,
        body: { value: DEFAULT_DELIVERY_SETTINGS, version: 0, rev: 0, updatedAt: null },
      };
    }
    if (method === 'POST' && path === '/v1/orders') return createOrder(body);
    const one = /^\/v1\/orders\/([^/]+)$/.exec(path);
    if (method === 'GET' && one) {
      const params = orderIdParamSchema.safeParse({ id: one[1] });
      const found = params.success ? orders.get(params.data.id) : undefined;
      return found ? { status: 200, body: found } : { status: 404, body: errorBody('NOT_FOUND') };
    }
    return null;
  }

  /** A WebSocket that behaves like `/v1/ws`: auth first, `ready`, pushes, a ping every 25 s. */
  const createSocket: SocketFactory = (_url, handlers) => {
    const socket: OpenSocket = { handlers, ready: false, timer: undefined };
    // No network: the socket never opens (the client sees an abnormal close and backs off).
    if (offline) {
      queueMicrotask(() => handlers.close(1006));
      return { send: () => undefined, close: () => undefined };
    }
    sockets.add(socket);
    queueMicrotask(() => handlers.open());
    const end = (code: number) => {
      clearInterval(socket.timer);
      sockets.delete(socket);
      handlers.close(code);
    };
    return {
      send(text) {
        let message: { type?: string; sessionToken?: unknown };
        try {
          message = JSON.parse(text);
        } catch {
          return end(4400);
        }
        if (!socket.ready) {
          if (message.type !== 'auth' || typeof message.sessionToken !== 'string') return end(4400);
          socket.ready = true;
          handlers.message(JSON.stringify({ type: 'ready', serverRev: rev, heartbeatSeconds: 25 }));
          socket.timer = setInterval(
            () => handlers.message(JSON.stringify({ type: 'ping', serverRev: rev })),
            25_000,
          );
        }
      },
      close() {
        clearInterval(socket.timer);
        sockets.delete(socket);
      },
    };
  };

  /** Dev: the network goes away (every open socket drops, new ones never open) or comes back. */
  function setOffline(on: boolean) {
    offline = on;
    if (!on) return;
    for (const socket of [...sockets]) {
      clearInterval(socket.timer);
      sockets.delete(socket);
      socket.handlers.close(1006);
    }
  }

  return {
    handle,
    createSocket,
    simulateIncomingOrder,
    setOffline,
    isOffline: () => offline,
    /** Dev: the owner changes the PromptPay ID (the feed gets a masked notice with a newer rev). */
    setPromptpayId: payments.setPromptpayId,
    /** Dev: every price rises by this many satang on the server only. */
    bumpPrices(satangMore: number) {
      silent.priceBump = satangMore;
    },
    /** Dev: a dish sells out on the server only (by its position in the menu, 1 to 10). */
    soldOut(itemNumber: number, on = true) {
      const itemId = ITEMS[itemNumber - 1]?.id;
      if (!itemId) return;
      if (on) silent.soldOut.add(itemId);
      else silent.soldOut.delete(itemId);
    },
  };
}

export type MockShop = ReturnType<typeof createMockShop>;
