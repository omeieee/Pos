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
  type CatalogGroup,
  type CatalogItem,
  type CategoryDto,
  createOrderInputSchema,
  type GroupDto,
  type ItemDto,
  initialOrderStatus,
  type OptionDto,
  type OrderDto,
  orderIdParamSchema,
  type PricingError,
  priceOrder,
  type RealtimeFrame,
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
  'rev' | 'channelPrices' | 'descriptionTh' | 'descriptionEn' | 'imageUrl' | 'archived' | 'version'
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
  channels: ['storefront', 'line'],
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
  let orderSeq = 0;
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
          channelPrices: {},
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
          priceSatang: i.priceSatang,
          estCostSatang: ZERO,
          isAvailable: i.isAvailable,
          archived: false,
          categoryActive: true,
          channels: i.channels,
          channelPrices: {},
          groups: i.modifierGroupIds.flatMap((gid) => {
            const group = groups.get(gid);
            return group ? [group] : [];
          }),
        },
      ]),
    );
  }

  function createOrder(body: unknown): MockAnswer {
    const input = createOrderInputSchema.safeParse(body);
    if (!input.success) return { status: 400, body: errorBody('VALIDATION_ERROR') };
    const existing = byRequest.get(input.data.clientRequestId);
    if (existing) return { status: 200, body: existing };

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
      customerId: null,
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
    byRequest.set(input.data.clientRequestId, order);
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

  return { handle, createSocket };
}

export type MockShop = ReturnType<typeof createMockShop>;
