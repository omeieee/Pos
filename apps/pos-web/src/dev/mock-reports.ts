/**
 * A made-up `/v1/reports/*` for `pnpm dev` with the mock API (reached only through mock-shop.ts and
 * `enable.ts`, which is dev-only). It reads the mock shop's own orders, so the overview shows what
 * you just rang up. It is a rough double: every paid, not-cancelled order counts at its full
 * total (the mock has no refunds) and the payment method is always cash. The CSV export is not
 * mocked (the mock answers JSON only); the real API does it. Nothing here is persisted.
 */
import {
  type CustomersReport,
  type HeatmapReport,
  type ItemsReport,
  type OrderDto,
  type RevenueReport,
  ROLE_PERMISSIONS,
  revenueReportQuerySchema,
  type StaffRole,
  satang,
} from '@sds/shared';

interface Answer {
  status: number;
  body: unknown;
}
/** The slice of the mock caller this file needs. */
interface Caller {
  role: StaffRole;
  stepUpFresh?: boolean;
}

const error = (status: number, code: string): Answer => ({
  status,
  body: { code, message: 'mock server error', details: {} },
});

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok',
  hour: '2-digit',
  hourCycle: 'h23',
});

const DEMO_ITEMS = [
  { n: 201, name: 'ก๋วยเตี๋ยวต้มยำ', price: 6000 },
  { n: 202, name: 'เย็นตาโฟ', price: 6500 },
  { n: 203, name: 'บะหมี่แห้งหมูแดง', price: 5500 },
  { n: 204, name: 'ชาเย็น', price: 3000 },
  { n: 205, name: 'เรือหมูน้ำตก', price: 7000 },
  { n: 206, name: 'ไข่ต้ม', price: 1000 },
] as const;
const DEMO_CHANNELS = ['storefront', 'line', 'storefront', 'grab', 'line'] as const;
const DEMO_HOURS = [10, 11, 11, 12, 12, 12, 13, 13, 14, 17, 18, 19] as const;
const uuid = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function createMockReports(deps: {
  orders: Map<string, OrderDto>;
  /** The mock clock; defaults to the real one. */
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const counted = (from: string, to: string) =>
    [...deps.orders.values()].filter(
      (o) =>
        o.status !== 'cancelled' &&
        o.paymentStatus === 'paid' &&
        o.businessDate >= from &&
        o.businessDate <= to,
    );

  function revenue(from: string, to: string): RevenueReport {
    const days = new Map<string, RevenueReport['days'][number]>();
    for (const o of counted(from, to)) {
      const day = days.get(o.businessDate) ?? {
        businessDate: o.businessDate,
        revenueSatang: satang(0),
        orderCount: 0,
        averageTicketSatang: satang(0),
        commissionSatang: satang(0),
        byChannel: {},
        byMethod: {},
      };
      day.revenueSatang = satang(day.revenueSatang + o.totalSatang);
      day.orderCount += 1;
      day.byChannel[o.channel] = satang((day.byChannel[o.channel] ?? 0) + o.totalSatang);
      day.byMethod.cash = satang((day.byMethod.cash ?? 0) + o.totalSatang);
      days.set(o.businessDate, day);
    }
    const rows = [...days.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
    for (const d of rows) {
      d.averageTicketSatang = satang(
        Math.floor((2 * d.revenueSatang + d.orderCount) / (2 * d.orderCount)),
      );
    }
    return {
      from,
      to,
      excludedOrderIds: [],
      days: rows,
      totals: {
        revenueSatang: satang(rows.reduce((sum, d) => sum + d.revenueSatang, 0)),
        orderCount: rows.reduce((sum, d) => sum + d.orderCount, 0),
        commissionSatang: satang(0),
      },
      // the mock shop has no costs and no platform orders
      margin: {
        costedOrderCount: 0,
        costedRevenueSatang: satang(0),
        costSatang: satang(0),
        grossProfitSatang: null,
        marginBp: null,
        uncostedOrderIds: [],
        uncostedRevenueSatang: satang(0),
        uncostedMenuItemIds: [],
      },
      commission: {
        recordedSatang: satang(0),
        recordedOrderCount: 0,
        estimatedSatang: satang(0),
        estimatedOrderCount: 0,
        totalSatang: satang(0),
        rateNotSetOrderIds: [],
        ratesNotSet: [],
      },
    };
  }

  function items(from: string, to: string): ItemsReport {
    const byItem = new Map<string, { name: string; qty: number; revenue: number }>();
    for (const o of counted(from, to)) {
      for (const line of o.items) {
        const row = byItem.get(line.menuItemId) ?? { name: line.nameTh, qty: 0, revenue: 0 };
        row.qty += line.qty;
        row.revenue += line.lineTotalSatang;
        byItem.set(line.menuItemId, row);
      }
    }
    const total = [...byItem.values()].reduce((sum, r) => sum + r.qty, 0);
    const rows = [...byItem.entries()]
      .map(([menuItemId, r]) => ({
        menuItemId,
        name: r.name,
        qty: r.qty,
        revenueSatang: satang(r.revenue),
        unitShareBp: Math.floor((2 * r.qty * 10000 + total) / (2 * total)),
        popular: r.qty * byItem.size * 10 >= total * 7,
        costedQty: 0,
        costedRevenueSatang: satang(0),
        costSatang: null,
        grossProfitSatang: null,
        marginBp: null,
      }))
      .sort((a, b) => b.qty - a.qty || b.revenueSatang - a.revenueSatang);
    return {
      from,
      to,
      excludedOrderIds: [],
      items: rows,
      uncostedMenuItemIds: rows.map((r) => r.menuItemId),
    };
  }

  function heatmap(from: string, to: string): HeatmapReport {
    const cells = new Map<number, HeatmapReport['cells'][number]>();
    for (const o of counted(from, to)) {
      const day = new Date(`${o.businessDate}T00:00:00Z`).getUTCDay();
      const weekday = day === 0 ? 7 : day;
      const hour = Number(hourFormat.format(new Date(o.placedAt)));
      const cell = cells.get(weekday * 24 + hour) ?? {
        weekday,
        hour,
        orderCount: 0,
        revenueSatang: satang(0),
      };
      cell.orderCount += 1;
      cell.revenueSatang = satang(cell.revenueSatang + o.totalSatang);
      cells.set(weekday * 24 + hour, cell);
    }
    return {
      from,
      to,
      excludedOrderIds: [],
      cells: [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
    };
  }

  /**
   * Dev only (`__sdsMock.demoOrders()`): two weeks of paid orders across the channels and the
   * busy hours, so the overview has something to show. Made-up and repeatable. Returns how many.
   */
  function seedDemoOrders(): number {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now());
    let seq = 0;
    let made = 0;
    for (let back = 0; back < 14; back += 1) {
      const businessDate = addDays(today, -back);
      const count = 6 + ((back * 7) % 9);
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        const hour = DEMO_HOURS[(seq * 5) % DEMO_HOURS.length] ?? 12;
        const lines = [0, 1].slice(0, 1 + (seq % 2)).map((k) => {
          const dish = DEMO_ITEMS[(seq + k * 2) % DEMO_ITEMS.length] ?? DEMO_ITEMS[0];
          const qty = 1 + ((seq + k) % 3);
          return {
            id: uuid(5000 + seq * 3 + k),
            menuItemId: uuid(dish.n),
            nameTh: dish.name,
            nameEn: null,
            unitPriceSatang: satang(dish.price),
            qty,
            modifiers: [],
            note: null,
            lineTotalSatang: satang(dish.price * qty),
          };
        });
        const total = lines.reduce((sum, l) => sum + l.lineTotalSatang, 0);
        // 17:00Z of the day before is 00:00 in Bangkok; +hour -7 puts the order at `hour` local.
        const placedAt = new Date(Date.parse(`${businessDate}T00:00:00Z`) + (hour - 7) * 3_600_000);
        const id = uuid(9000 + seq);
        deps.orders.set(id, {
          id,
          orderNo: `D-${String(seq).padStart(3, '0')}`,
          businessDate,
          channel: DEMO_CHANNELS[seq % DEMO_CHANNELS.length] ?? 'storefront',
          fulfillment: 'entrance_delivery',
          roomNo: null,
          deliveryBuilding: 'B1',
          recipientName: 'ตัวอย่าง',
          deliveryNote: null,
          customerId: null,
          status: 'completed',
          paymentStatus: 'paid',
          subtotalSatang: satang(total),
          discountSatang: satang(0),
          totalSatang: satang(total),
          note: null,
          createdByStaffId: null,
          createdOnDeviceId: null,
          placedAt: placedAt.toISOString(),
          acceptedAt: null,
          readyAt: null,
          completedAt: placedAt.toISOString(),
          cancelledAt: null,
          cancelReason: null,
          version: 1,
          rev: 1,
          items: lines,
        });
        made += 1;
      }
    }
    return made;
  }

  /** Answers `/v1/reports/*`, or null for any other path. */
  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    caller: Caller,
  ): Answer | null {
    if (method !== 'GET' || !path.startsWith('/v1/reports/')) return null;
    const permissions = ROLE_PERMISSIONS[caller.role];
    if (path === '/v1/reports/customers') {
      if (!permissions.has('customer.report')) return error(403, 'FORBIDDEN');
      const empty: CustomersReport = {
        summary: { new: 0, regular: 0, lapsed: 0 },
        customers: [],
      };
      return { status: 200, body: empty };
    }
    const kind = /^\/v1\/reports\/(revenue|items|heatmap)$/.exec(path)?.[1];
    if (!kind) return null;
    if (!permissions.has('report.view')) return error(403, 'FORBIDDEN');
    const range = revenueReportQuerySchema.safeParse(Object.fromEntries(query));
    if (!range.success) return error(400, 'VALIDATION_ERROR');
    const { from, to } = range.data;
    const body =
      kind === 'revenue'
        ? revenue(from, to)
        : kind === 'items'
          ? items(from, to)
          : heatmap(from, to);
    return { status: 200, body };
  }

  return { handle, seedDemoOrders };
}
