/**
 * Design lab: UX/UI options for the staff app, drawn from the owner's "liquid glass" reference
 * (2026-10-25). A dev-only page (`/design-lab.html`, never part of the production build) that
 * shows four directions on the kitchen board, the day's overview, the sold-out switches and the
 * payment pop-up, with made-up sample orders, so the owner can choose before a real screen changes.
 *
 * Made to be folded into the app later: no new libraries (motion is CSS and the Web Animations
 * API, see `spring.ts`), every colour is a token in `design-lab.css` (a direction is one scope of
 * variables, like the kitchen's `.g-dk`), and the app's own icons, dish drawings, wait levels and
 * baht formatter are reused. Adopting a piece means: its tokens into `@sds/ui`, its words into
 * `@sds/i18n`, and the sample data below replaced by the store.
 */
import { formatBaht } from '@sds/i18n';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import { clockTime, weekdayDate } from '../design/format.ts';
import { Gi, type GiName } from '../design/icons.tsx';
import { dishArt, dishArtUrl } from '../pos/cart/dish-art.ts';
import { WAIT_LATE_MINUTES, waitLevel } from '../pos/kitchen/kitchen-model.ts';
import { SAMPLE_VAT } from '../pos/orders/dashboard-sample.ts';
import { POP, SMOOTH, type SpringEasing, springEasing } from './spring.ts';

// ---------------------------------------------------------------------------------------------
// Options the owner compares
// ---------------------------------------------------------------------------------------------

const DIRECTIONS = ['studio-dark', 'studio-light', 'ember', 'daylight'] as const;
const DEPTHS = ['flat', 'frost', 'liquid'] as const;
const CARDS = ['edge', 'tint', 'timer'] as const;
const FRAMES = ['full', 'ipad', 'iphone'] as const;
const SCREENS = ['kitchen', 'overview', 'menu'] as const;

type Direction = (typeof DIRECTIONS)[number];
type Depth = (typeof DEPTHS)[number];
type Card = (typeof CARDS)[number];
type Speed = 1 | 0.5 | 0.25;
type Frame = (typeof FRAMES)[number];
type Screen = (typeof SCREENS)[number];

/**
 * The options, each with its first-visit value (Studio dark, frosted glass, the time bar, full
 * speed). A missing or unknown saved value, such as a look that was removed, falls back to it.
 */
const optionsSchema = z.object({
  direction: z.enum(DIRECTIONS).catch('studio-dark'),
  depth: z.enum(DEPTHS).catch('frost'),
  refract: z.boolean().catch(true),
  card: z.enum(CARDS).catch('timer'),
  speed: z.union([z.literal(1), z.literal(0.5), z.literal(0.25)]).catch(1),
  frame: z.enum(FRAMES).catch('full'),
});
type Options = z.infer<typeof optionsSchema>;

const DEFAULT_OPTIONS: Options = optionsSchema.parse({});

const STORE_KEY = 'sds.design-lab.options';

/** The choices last made on this device; a private window or a bad value gives the defaults. */
function loadOptions(): Options {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? optionsSchema.parse(JSON.parse(raw)) : DEFAULT_OPTIONS;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function saveOptions(options: Options): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(options));
  } catch {
    // Storage is blocked (a private window): the choice lasts until the page closes.
  }
}

/** `#kitchen`, `#overview` or `#menu` in the link opens that screen. */
function screenFromHash(): Screen {
  const token = typeof location === 'undefined' ? '' : location.hash.slice(1);
  return SCREENS.find((s) => s === token) ?? 'kitchen';
}

interface Choice<T> {
  value: T;
  label: string;
  hint: string;
}

const DIRECTION_CHOICES: readonly Choice<Direction>[] = [
  {
    value: 'studio-dark',
    label: 'Studio dark',
    hint: 'Slate fading to black, frosted cards, white pills, thin numbers, a blue-violet line.',
  },
  {
    value: 'studio-light',
    label: 'Studio light',
    hint: 'Soft grey and white, frosted cards, a black main button. The kitchen uses Studio dark.',
  },
  {
    value: 'ember',
    label: 'Brand night',
    hint: 'The same glass in your chili red, amber and jade, dark on every screen.',
  },
  {
    value: 'daylight',
    label: 'Today+',
    hint: "Today's warm paper look with a dark kitchen. Only the finish changes.",
  },
];

const DEPTH_CHOICES: readonly Choice<Depth>[] = [
  { value: 'flat', label: 'Flat', hint: 'No blur. The fastest on older iPads.' },
  { value: 'frost', label: 'Frost', hint: "Today's frosted glass." },
  {
    value: 'liquid',
    label: 'Liquid',
    hint: 'Your first file: gradient edge, light that follows the pointer, deeper shadow.',
  },
];

const CARD_CHOICES: readonly Choice<Card>[] = [
  { value: 'edge', label: 'Stripe', hint: 'Today: a coloured stripe for each stage.' },
  { value: 'tint', label: 'Tint', hint: 'Your first file: the whole card takes the stage colour.' },
  {
    value: 'timer',
    label: 'Time bar',
    hint: `A bar fills toward the ${WAIT_LATE_MINUTES}-minute limit.`,
  },
];

const SPEED_CHOICES: readonly Choice<Speed>[] = [
  { value: 1, label: '1×', hint: "Your first file's spring: stiffness 280, damping 32, mass 1." },
  { value: 0.5, label: '0.5×', hint: 'Half speed, to watch the motion.' },
  { value: 0.25, label: '0.25×', hint: 'Quarter speed.' },
];

const FRAME_CHOICES: readonly Choice<Frame>[] = [
  { value: 'full', label: 'Window', hint: 'Fills this window.' },
  { value: 'ipad', label: 'iPad', hint: 'iPad landscape, 1180 × 820.' },
  { value: 'iphone', label: 'iPhone', hint: 'iPhone, 390 × 844.' },
];

// ---------------------------------------------------------------------------------------------
// Sample data: made up for the lab, no real customer. Money in satang, as everywhere in the app.
// ---------------------------------------------------------------------------------------------

/** The lab clock in minutes after midnight, Bangkok: Sunday 25 Oct 2026, 20:48. */
const START_CLOCK = 20 * 60 + 48;
/** The same moment as a timestamp (13:48 UTC), for the date and time lines. */
const START_MS = Date.UTC(2026, 9, 25, 13, 48);
const atClock = (clock: number) => START_MS + (clock - START_CLOCK) * 60_000;

const baht = (satang: number) => formatBaht(satang, 'th', { decimals: 'auto' });

type Stage = 'new' | 'cooking' | 'ready';
type Pay = 'paid' | 'claimed' | 'unpaid';

interface Line {
  qty: number;
  name: string;
  opts?: string;
  note?: string;
}

/** What a kitchen card shows besides its place on the board. Never a price: the kitchen reads none. */
interface TicketSeed {
  where: string;
  delivery: boolean;
  channel: string;
  pay: Pay;
  payVia?: string;
  lineName?: string;
  items: readonly Line[];
  note?: string;
}

interface Ticket extends TicketSeed {
  id: string;
  orderNo: string;
  stage: Stage;
  /** Lab-clock minute it was placed, or became ready: the wait counts from there. */
  since: number;
  /** Just arrived: the card pulses for a few seconds. */
  fresh?: boolean;
  /** Handed over: the card plays its exit, then leaves the board. */
  leaving?: boolean;
}

const TICKETS: readonly Ticket[] = [
  {
    id: 't24',
    orderNo: 'S-024',
    stage: 'new',
    since: START_CLOCK - 1,
    where: 'หน้าร้าน · กลับบ้าน',
    delivery: false,
    channel: 'หน้าร้าน',
    pay: 'unpaid',
    items: [
      { qty: 1, name: 'ก๋วยเตี๋ยวน้ำใส', opts: 'เส้นใหญ่ · ไม่ใส่ผักบุ้ง' },
      { qty: 1, name: 'น้ำเปล่า' },
    ],
  },
  {
    id: 't23',
    orderNo: 'L-023',
    stage: 'new',
    since: START_CLOCK - 3,
    where: 'ส่งที่ทางเข้าตึก · อาคาร B',
    delivery: true,
    lineName: 'คุณต้น',
    channel: 'LINE',
    pay: 'unpaid',
    payVia: 'ไทยช่วยไทย ต่อหน้า',
    items: [{ qty: 2, name: 'ก๋วยเตี๋ยวเรือ', opts: 'เส้นหมี่ · เผ็ดมาก' }],
    note: 'ขอช้อนส้อม 2 ชุด',
  },
  {
    id: 't22',
    orderNo: 'G-022',
    stage: 'new',
    since: START_CLOCK - 5,
    where: 'Grab · ไรเดอร์มารับ',
    delivery: false,
    channel: 'Grab',
    pay: 'paid',
    payVia: 'แพลตฟอร์ม',
    items: [
      { qty: 1, name: 'ก๋วยเตี๋ยวต้มยำ', opts: 'เส้นเล็ก · เผ็ดกลาง' },
      { qty: 1, name: 'ชาเย็น', opts: 'หวานน้อย' },
    ],
  },
  {
    id: 't20',
    orderNo: 'L-020',
    stage: 'cooking',
    since: START_CLOCK - 7,
    where: 'ส่งที่ทางเข้าตึก · อาคาร A',
    delivery: true,
    lineName: 'คุณแพร',
    channel: 'LINE',
    pay: 'paid',
    payVia: 'พร้อมเพย์',
    items: [
      { qty: 1, name: 'ก๋วยเตี๋ยวน้ำใส', opts: 'บะหมี่ · ไม่เผ็ด' },
      { qty: 2, name: 'เกี๊ยวทอด' },
    ],
  },
  {
    id: 't19',
    orderNo: 'S-019',
    stage: 'cooking',
    since: START_CLOCK - 10,
    where: 'หน้าร้าน · ทานที่ร้าน',
    delivery: false,
    channel: 'หน้าร้าน',
    pay: 'unpaid',
    items: [{ qty: 3, name: 'ก๋วยเตี๋ยวเรือ', opts: 'เส้นเล็ก', note: 'ชามหนึ่งไม่ใส่ถั่วงอก' }],
  },
  {
    id: 't18',
    orderNo: 'M-018',
    stage: 'cooking',
    since: START_CLOCK - 13,
    where: 'LINE MAN · ไรเดอร์มารับ',
    delivery: false,
    channel: 'LINE MAN',
    pay: 'paid',
    payVia: 'แพลตฟอร์ม',
    items: [{ qty: 2, name: 'ก๋วยเตี๋ยวต้มยำ', opts: 'เส้นใหญ่ · เผ็ดน้อย' }],
  },
  {
    id: 't17',
    orderNo: 'S-017',
    stage: 'ready',
    since: START_CLOCK - 2,
    where: 'หน้าร้าน · รับที่ร้าน',
    delivery: false,
    channel: 'หน้าร้าน',
    pay: 'paid',
    payVia: 'พร้อมเพย์',
    items: [
      { qty: 1, name: 'ก๋วยเตี๋ยวทะเล' },
      { qty: 1, name: 'น้ำเก๊กฮวย' },
    ],
  },
  {
    id: 't16',
    orderNo: 'L-016',
    stage: 'ready',
    since: START_CLOCK - 5,
    where: 'ส่งที่ทางเข้าตึก · อาคาร C',
    delivery: true,
    lineName: 'คุณบีม',
    channel: 'LINE',
    pay: 'paid',
    payVia: 'พร้อมเพย์',
    items: [{ qty: 2, name: 'เส้นเล็กแห้งต้มยำ', opts: 'ไม่ใส่ถั่ว' }],
  },
];

/** Orders the "new order" button brings in, in turn. */
const ARRIVALS: readonly (TicketSeed & { prefix: string })[] = [
  {
    prefix: 'L',
    where: 'ส่งที่ทางเข้าตึก · อาคาร A',
    delivery: true,
    lineName: 'คุณนัท',
    channel: 'LINE',
    pay: 'unpaid',
    payVia: 'ไทยช่วยไทย ต่อหน้า',
    items: [
      { qty: 1, name: 'ก๋วยเตี๋ยวต้มยำ', opts: 'เส้นเล็ก · เผ็ดมาก' },
      { qty: 1, name: 'ชาเย็น' },
    ],
  },
  {
    prefix: 'S',
    where: 'หน้าร้าน · กลับบ้าน',
    delivery: false,
    channel: 'หน้าร้าน',
    pay: 'unpaid',
    items: [{ qty: 2, name: 'ก๋วยเตี๋ยวน้ำใส', opts: 'เส้นหมี่' }],
  },
  {
    prefix: 'G',
    where: 'Grab · ไรเดอร์มารับ',
    delivery: false,
    channel: 'Grab',
    pay: 'paid',
    payVia: 'แพลตฟอร์ม',
    items: [{ qty: 1, name: 'ก๋วยเตี๋ยวทะเล' }],
  },
];

/**
 * A customer's "โอนแล้ว" waiting for staff to check the bank app. A LINE PromptPay order reaches
 * the kitchen only once it is paid (D-38), so confirming one puts its card on the board.
 */
interface Claim {
  id: string;
  orderNo: string;
  amount: number;
  at: number;
  slip: string;
  seed: TicketSeed;
}

const lineOrder = (lineName: string, building: string, items: readonly Line[]): TicketSeed => ({
  where: `ส่งที่ทางเข้าตึก · อาคาร ${building}`,
  delivery: true,
  lineName,
  channel: 'LINE',
  pay: 'claimed',
  payVia: 'พร้อมเพย์',
  items,
});

const CLAIMS: readonly Claim[] = [
  {
    id: 'p25',
    orderNo: 'L-025',
    amount: 9500,
    at: START_CLOCK - 1,
    slip: 'รูปที่ส่งมาไม่มี QR ของธนาคาร ระบบตรวจให้ไม่ได้',
    seed: lineOrder('คุณมิ้นท์', 'A', [
      { qty: 1, name: 'ก๋วยเตี๋ยวต้มยำ', opts: 'เส้นเล็ก' },
      { qty: 1, name: 'เกี๊ยวทอด' },
      { qty: 1, name: 'น้ำเปล่า' },
    ]),
  },
  {
    id: 'p21',
    orderNo: 'L-021',
    amount: 9000,
    at: START_CLOCK - 3,
    slip: 'ลูกค้ากดโอนแล้ว แต่ยังไม่ส่งสลิป',
    seed: lineOrder('คุณฝน', 'C', [{ qty: 2, name: 'ก๋วยเตี๋ยวเรือ', opts: 'เส้นเล็ก · เผ็ดน้อย' }]),
  },
];

/** The claim the "customer pays" button brings in. */
const LATE_CLAIM: Omit<Claim, 'id' | 'orderNo' | 'at'> = {
  amount: 12000,
  slip: 'รูปที่ส่งมาไม่มี QR ของธนาคาร ระบบตรวจให้ไม่ได้',
  seed: lineOrder('คุณโอ๊ต', 'B', [
    { qty: 2, name: 'เย็นตาโฟ', opts: 'เส้นใหญ่' },
    { qty: 1, name: 'น้ำเก๊กฮวย' },
  ]),
};

type Category = 'noodle' | 'side' | 'drink';

interface Dish {
  id: string;
  nameTh: string;
  nameEn: string;
  category: Category;
  price: number;
  soldToday: number;
}

const MENU: readonly Dish[] = [
  {
    id: 'm1',
    nameTh: 'ก๋วยเตี๋ยวต้มยำ',
    nameEn: 'Tom yum noodles',
    category: 'noodle',
    price: 5000,
    soldToday: 18,
  },
  {
    id: 'm2',
    nameTh: 'ก๋วยเตี๋ยวเรือ',
    nameEn: 'Boat noodles',
    category: 'noodle',
    price: 4500,
    soldToday: 21,
  },
  {
    id: 'm3',
    nameTh: 'เย็นตาโฟ',
    nameEn: 'Yen ta fo',
    category: 'noodle',
    price: 5000,
    soldToday: 15,
  },
  {
    id: 'm4',
    nameTh: 'ก๋วยเตี๋ยวน้ำใส',
    nameEn: 'Clear soup noodles',
    category: 'noodle',
    price: 4500,
    soldToday: 12,
  },
  {
    id: 'm5',
    nameTh: 'เส้นเล็กแห้งต้มยำ',
    nameEn: 'Dry tom yum noodles',
    category: 'noodle',
    price: 5000,
    soldToday: 9,
  },
  {
    id: 'm6',
    nameTh: 'ก๋วยเตี๋ยวทะเล',
    nameEn: 'Seafood noodles',
    category: 'noodle',
    price: 7000,
    soldToday: 6,
  },
  {
    id: 'm7',
    nameTh: 'เกี๊ยวทอด',
    nameEn: 'Fried wontons',
    category: 'side',
    price: 3500,
    soldToday: 8,
  },
  {
    id: 'm8',
    nameTh: 'ชาเย็น',
    nameEn: 'Thai iced tea',
    category: 'drink',
    price: 2500,
    soldToday: 20,
  },
  {
    id: 'm9',
    nameTh: 'น้ำเก๊กฮวย',
    nameEn: 'Chrysanthemum',
    category: 'drink',
    price: 2000,
    soldToday: 7,
  },
  { id: 'm10', nameTh: 'น้ำเปล่า', nameEn: 'Water', category: 'drink', price: 1000, soldToday: 11 },
];

const CATEGORY_LABEL: Record<Category, string> = {
  noodle: 'ก๋วยเตี๋ยว',
  side: 'ของทานเล่น',
  drink: 'เครื่องดื่ม',
};

const HOURS = [
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
  '18:00',
  '19:00',
  '20:00',
  '21:00',
] as const;
/** Paid revenue per hour today, up to the hour that is running now (20:00). */
const TODAY_HOURLY: readonly number[] = [
  18000, 32000, 64000, 71000, 38000, 22000, 19000, 28000, 52000, 61000, 49000,
];
/** The same weekday a week ago, the whole day. */
const LAST_WEEK_HOURLY: readonly number[] = [
  15000, 30000, 56000, 65000, 36000, 21000, 17000, 25000, 47000, 54000, 43000, 25000,
];
const ORDERS_TODAY = 49;
const ORDERS_LAST_WEEK = 45;

const CHANNEL_SHARE: readonly { name: string; percent: number }[] = [
  { name: 'หน้าร้าน', percent: 44 },
  { name: 'LINE', percent: 38 },
  { name: 'Grab', percent: 11 },
  { name: 'LINE MAN', percent: 7 },
];

const HEAT_DAYS = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'] as const;
const HEAT_HOURS = ['10', '12', '14', '16', '18', '20'] as const;
/** Average orders per two hours over the last eight weeks, Monday first. */
const HEAT: readonly (readonly number[])[] = [
  [4, 9, 3, 2, 7, 5],
  [3, 8, 3, 2, 6, 5],
  [4, 10, 4, 3, 8, 6],
  [4, 9, 3, 3, 8, 6],
  [5, 11, 4, 3, 10, 8],
  [7, 12, 6, 5, 12, 9],
  [8, 13, 7, 5, 11, 7],
];
const heatLevel = (value: number) => (value < 4 ? 1 : value < 7 ? 2 : value < 10 ? 3 : 4);

type ActivityKind = 'paid' | 'auto' | 'claim' | 'ready' | 'done' | 'new';

interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  sub: string;
  at: number;
}

const ACTIVITY: readonly Activity[] = [
  {
    id: 'a5',
    kind: 'claim',
    title: `L-025 ลูกค้ากด “โอนแล้ว” ${baht(9500)}`,
    sub: 'รอพนักงานตรวจยอด',
    at: START_CLOCK - 1,
  },
  {
    id: 'a4',
    kind: 'auto',
    title: `L-024 ชำระแล้ว ${baht(12000)}`,
    sub: 'พร้อมเพย์ · ระบบยืนยันจากสลิป (Slip2Go)',
    at: START_CLOCK - 2,
  },
  {
    id: 'a3',
    kind: 'claim',
    title: `L-021 ลูกค้ากด “โอนแล้ว” ${baht(9000)}`,
    sub: 'รอพนักงานตรวจยอด',
    at: START_CLOCK - 3,
  },
  {
    id: 'a2',
    kind: 'done',
    title: 'S-015 ส่งมอบแล้ว',
    sub: 'หน้าร้าน · ใช้เวลา 9 นาที',
    at: START_CLOCK - 4,
  },
  {
    id: 'a1',
    kind: 'new',
    title: 'G-022 ออเดอร์ใหม่จาก Grab',
    sub: 'เข้าคิวครัวแล้ว',
    at: START_CLOCK - 5,
  },
];

const ACTIVITY_ICON: Record<ActivityKind, GiName> = {
  paid: 'check',
  auto: 'check',
  claim: 'clock',
  ready: 'bell',
  done: 'bag',
  new: 'receipt',
};

const STAGE_LABEL: Record<Stage, string> = { new: 'ใหม่', cooking: 'กำลังทำ', ready: 'พร้อมส่ง' };
const STAGE_EMPTY: Record<Stage, string> = {
  new: 'ไม่มีออเดอร์ใหม่',
  cooking: 'ไม่มีออเดอร์ที่กำลังทำ',
  ready: 'ไม่มีออเดอร์ที่รอส่งมอบ',
};
const MOVE_LABEL: Record<Stage, string> = { new: 'เริ่มทำ', cooking: 'ทำเสร็จ', ready: 'ส่งมอบแล้ว' };
const PAY_WORDS: Record<Pay, string> = {
  paid: 'ชำระแล้ว',
  claimed: 'ลูกค้ากด “โอนแล้ว”',
  unpaid: 'ยังไม่ชำระ',
};

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);
const agoText = (minutes: number) => (minutes <= 0 ? 'เมื่อสักครู่' : `${minutes} นาทีที่แล้ว`);

// ---------------------------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------------------------

interface Motion {
  reduced: boolean;
  smooth: SpringEasing;
  pop: SpringEasing;
  /** The same springs as CSS variables, for transitions and keyframes. */
  vars: Record<string, string>;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
  );
  useEffect(() => {
    const list = matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** The reference's springs at the chosen speed, as `linear()` easings (bezier stand-ins where unsupported). */
function useMotion(speed: Speed): Motion {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  return useMemo(() => {
    const linear =
      typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)');
    const smoothSpring = springEasing(SMOOTH, speed);
    const popSpring = springEasing(POP, speed);
    const smooth = linear
      ? smoothSpring
      : { easing: 'cubic-bezier(0.32, 0.72, 0, 1)', durationMs: smoothSpring.durationMs };
    const pop = linear
      ? popSpring
      : {
          easing: 'cubic-bezier(0.34, 1.5, 0.64, 1)',
          durationMs: Math.round(popSpring.durationMs * 0.75),
        };
    return {
      reduced,
      smooth,
      pop,
      vars: {
        '--dl-smooth': smooth.easing,
        // A device set to reduce motion gets the end state at once.
        '--dl-smooth-ms': reduced ? '1ms' : `${smooth.durationMs}ms`,
        '--dl-pop': pop.easing,
        '--dl-pop-ms': reduced ? '1ms' : `${pop.durationMs}ms`,
        '--dl-speed': String(speed),
      },
    };
  }, [speed, reduced]);
}

/** Position of an element inside its container, without any transform it is animating with. */
function layoutPoint(el: HTMLElement, origin: DOMRect): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  const moving = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: box.left - origin.left - moving.m41, y: box.top - origin.top - moving.m42 };
}

/**
 * Cards that glide to their new place (the reference's shared layout), done by hand: `capture`
 * notes where every `[data-flip]` element is, the change renders, and `play` moves each card
 * from its old place to its new one. A card with no old place pops in.
 */
function useFlip(container: RefObject<HTMLElement | null>, motion: Motion) {
  const before = useRef<Map<string, { x: number; y: number }> | null>(null);
  const capture = useCallback(() => {
    const box = container.current;
    if (!box) return;
    const origin = box.getBoundingClientRect();
    const points = new Map<string, { x: number; y: number }>();
    for (const el of box.querySelectorAll<HTMLElement>('[data-flip]')) {
      points.set(el.dataset.flip ?? '', layoutPoint(el, origin));
    }
    before.current = points;
  }, [container]);
  const play = useCallback(() => {
    const box = container.current;
    const points = before.current;
    before.current = null;
    if (!box || !points || motion.reduced) return;
    const origin = box.getBoundingClientRect();
    for (const el of box.querySelectorAll<HTMLElement>('[data-flip]')) {
      const was = points.get(el.dataset.flip ?? '');
      if (!was) {
        el.animate(
          [
            { opacity: 0, transform: 'scale(0.9)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: motion.pop.durationMs,
            easing: motion.pop.easing,
          },
        );
        continue;
      }
      const now = layoutPoint(el, origin);
      const dx = was.x - now.x;
      const dy = was.y - now.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: motion.smooth.durationMs,
        easing: motion.smooth.easing,
      });
    }
  }, [container, motion]);
  return { capture, play };
}

/**
 * The light that follows the pointer across liquid glass (mouse and trackpad only; a finger has no
 * hover). One listener on the lab sets `--mx`/`--my` on the glass under the pointer.
 */
function useSheen(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!el || !enabled || !matchMedia('(pointer: fine)').matches) return;
    let lit: HTMLElement | null = null;
    const clear = () => {
      lit?.style.removeProperty('--mx');
      lit?.style.removeProperty('--my');
      lit = null;
    };
    const move = (event: PointerEvent) => {
      const glass =
        event.target instanceof Element ? event.target.closest<HTMLElement>('.dl-glass') : null;
      if (glass !== lit) clear();
      if (!glass) return;
      lit = glass;
      const box = glass.getBoundingClientRect();
      glass.style.setProperty('--mx', `${event.clientX - box.left}px`);
      glass.style.setProperty('--my', `${event.clientY - box.top}px`);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', clear);
    return () => {
      clear();
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', clear);
    };
  }, [root, enabled]);
}

/** Width of an element in CSS pixels, kept up to date (charts draw at real size, so text stays 12 px). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// ---------------------------------------------------------------------------------------------
// Sample state: orders, payments and sold-out dishes, shared by the screens
// ---------------------------------------------------------------------------------------------

interface ToastAction {
  label: string;
  run: () => void;
}

interface Toast {
  id: number;
  text: string;
  icon: GiName;
  action?: ToastAction;
}

function useSample(motion: Motion) {
  const [clock, setClock] = useState(START_CLOCK);
  const [tickets, setTickets] = useState<readonly Ticket[]>(TICKETS);
  const [claims, setClaims] = useState<readonly Claim[]>(CLAIMS);
  const [soldOut, setSoldOut] = useState<ReadonlySet<string>>(() => new Set(['m3']));
  const [today, setToday] = useState<readonly number[]>(TODAY_HOURLY);
  const [paidOrders, setPaidOrders] = useState(ORDERS_TODAY);
  const [handedOver, setHandedOver] = useState(23);
  const [activity, setActivity] = useState<readonly Activity[]>(ACTIVITY);
  const [toast, setToast] = useState<Toast | null>(null);
  const [rang, setRang] = useState<string | null>(null);
  const [paying, setPaying] = useState<Claim | null>(null);
  /** Set by the kitchen board while it is on screen, so every move can glide. */
  const beforeMove = useRef<(() => void) | null>(null);
  const counter = useRef({ orderNo: 26, arrival: 0, toast: 0, activity: 10 });

  useEffect(() => {
    if (!rang) return;
    const timer = window.setTimeout(() => setRang(null), 2600);
    return () => window.clearTimeout(timer);
  }, [rang]);

  const hasFresh = tickets.some((t) => t.fresh);
  useEffect(() => {
    if (!hasFresh) return;
    const timer = window.setTimeout(
      () => setTickets((list) => list.map((t): Ticket => (t.fresh ? { ...t, fresh: false } : t))),
      6000,
    );
    return () => window.clearTimeout(timer);
  }, [hasFresh]);

  const notify = (text: string, icon: GiName, action?: ToastAction) => {
    counter.current.toast += 1;
    setToast({ id: counter.current.toast, text, icon, ...(action ? { action } : {}) });
  };
  const log = (kind: ActivityKind, title: string, sub: string) => {
    counter.current.activity += 1;
    const id = `a${counter.current.activity}`;
    setActivity((list) => [{ id, kind, title, sub, at: clock }, ...list].slice(0, 6));
  };
  const changeTickets = (update: (list: readonly Ticket[]) => readonly Ticket[]) => {
    beforeMove.current?.();
    setTickets(update);
  };
  const patch = (id: string, change: Partial<Ticket>) => (list: readonly Ticket[]) =>
    list.map((t): Ticket => (t.id === id ? { ...t, ...change } : t));

  const advance = (id: string) => {
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket || ticket.leaving) return;
    if (ticket.stage === 'new') {
      changeTickets(patch(id, { stage: 'cooking', fresh: false }));
      return;
    }
    if (ticket.stage === 'cooking') {
      changeTickets(patch(id, { stage: 'ready', since: clock, fresh: false }));
      setRang(id);
      notify(`${ticket.orderNo} พร้อมส่งแล้ว`, 'bell');
      log('ready', `${ticket.orderNo} ทำเสร็จ รอส่งมอบ`, ticket.where);
      return;
    }
    changeTickets(patch(id, { leaving: true }));
    setHandedOver((n) => n + 1);
    notify(`${ticket.orderNo} ส่งมอบแล้ว`, 'check');
    log('done', `${ticket.orderNo} ส่งมอบแล้ว`, ticket.where);
    window.setTimeout(
      () => changeTickets((list) => list.filter((t) => t.id !== id)),
      motion.reduced ? 0 : motion.smooth.durationMs,
    );
  };

  const arrive = () => {
    const seed = ARRIVALS[counter.current.arrival % ARRIVALS.length];
    if (!seed) return;
    counter.current.arrival += 1;
    const number = counter.current.orderNo;
    counter.current.orderNo += 1;
    const { prefix, ...rest } = seed;
    const orderNo = `${prefix}-${String(number).padStart(3, '0')}`;
    changeTickets((list) => [
      ...list,
      { ...rest, id: `t${number}`, orderNo, stage: 'new', since: clock, fresh: true },
    ]);
    notify(`ออเดอร์ใหม่ ${orderNo} · ${rest.channel}`, 'bell');
    log('new', `${orderNo} ออเดอร์ใหม่จาก ${rest.channel}`, rest.where);
  };

  const claimArrives = () => {
    const number = counter.current.orderNo;
    counter.current.orderNo += 1;
    const claim: Claim = { ...LATE_CLAIM, id: `p${number}`, orderNo: `L-0${number}`, at: clock };
    setClaims((list) => [claim, ...list]);
    notify(`${claim.orderNo} ลูกค้ากด “โอนแล้ว” ${baht(claim.amount)}`, 'bell', {
      label: 'ตรวจ',
      run: () => setPaying(claim),
    });
    log('claim', `${claim.orderNo} ลูกค้ากด “โอนแล้ว” ${baht(claim.amount)}`, 'รอพนักงานตรวจยอด');
  };

  const confirm = (claim: Claim) => {
    setClaims((list) => list.filter((c) => c.id !== claim.id));
    setToday((hours) => hours.map((v, i) => (i === hours.length - 1 ? v + claim.amount : v)));
    setPaidOrders((n) => n + 1);
    changeTickets((list) => [
      ...list,
      {
        ...claim.seed,
        pay: 'paid',
        id: claim.id,
        orderNo: claim.orderNo,
        stage: 'cooking',
        since: clock,
        fresh: true,
      },
    ]);
    notify(`รับเงิน ${claim.orderNo} ${baht(claim.amount)} แล้ว · ส่งเข้าครัว`, 'check');
    log('paid', `${claim.orderNo} ชำระแล้ว ${baht(claim.amount)}`, 'พร้อมเพย์ · พนักงานยืนยัน');
  };

  const toggleDish = (id: string) => {
    const dish = MENU.find((d) => d.id === id);
    if (!dish) return;
    const off = !soldOut.has(id);
    setSoldOut((set) => {
      const next = new Set(set);
      if (off) next.add(id);
      else next.delete(id);
      return next;
    });
    notify(
      off ? `${dish.nameTh} หมดแล้ว · ลูกค้าสั่งไม่ได้` : `${dish.nameTh} กลับมาขาย`,
      off ? 'x' : 'check',
    );
  };

  const reset = () => {
    setClock(START_CLOCK);
    setTickets(TICKETS);
    setClaims(CLAIMS);
    setSoldOut(new Set(['m3']));
    setToday(TODAY_HOURLY);
    setPaidOrders(ORDERS_TODAY);
    setHandedOver(23);
    setActivity(ACTIVITY);
    setPaying(null);
    setRang(null);
    counter.current = { orderNo: 26, arrival: 0, toast: 0, activity: 10 };
    notify('เริ่มตัวอย่างใหม่แล้ว', 'check');
  };

  return {
    clock,
    tickets,
    claims,
    soldOut,
    today,
    paidOrders,
    handedOver,
    activity,
    toast,
    rang,
    paying,
    beforeMove,
    setPaying,
    dismissToast: () => setToast(null),
    advance,
    arrive,
    claimArrives,
    confirm,
    toggleDish,
    warp: (minutes: number) => setClock((c) => c + minutes),
    reset,
  };
}

type Sample = ReturnType<typeof useSample>;

// ---------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------

interface SegOption<T> {
  value: T;
  label: string;
  icon?: GiName;
  badge?: number;
}

/**
 * A segmented control whose highlight slides to the chosen option (the reference's pill tabs).
 * It is a radio group, so it works by keyboard and screen reader; the highlight is decoration.
 */
function Seg<T extends string | number>({
  name,
  label,
  value,
  options,
  onChange,
  small,
}: {
  name: string;
  label: string;
  value: T;
  options: readonly SegOption<T>[];
  onChange: (value: T) => void;
  small?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const chosen = options.findIndex((option) => option.value === value);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const on = el.querySelectorAll<HTMLElement>('label')[chosen];
      if (on) setThumb({ x: on.offsetLeft, w: on.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [chosen]);
  return (
    <div
      ref={track}
      role="radiogroup"
      aria-label={label}
      className={`dl-seg${small ? ' dl-seg-sm' : ''}`}
    >
      {thumb ? (
        <span
          className="dl-seg-thumb"
          aria-hidden="true"
          style={{ '--x': `${thumb.x}px`, '--w': `${thumb.w}px` } as CSSProperties}
        />
      ) : null}
      {options.map((option) => {
        const on = option.value === value;
        return (
          <label key={String(option.value)} data-on={on ? '' : undefined}>
            <input type="radio" name={name} checked={on} onChange={() => onChange(option.value)} />
            {option.icon ? <Gi n={option.icon} size="sm" /> : null}
            <span>{option.label}</span>
            {option.badge ? <span className="dl-seg-badge dl-num">{option.badge}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

function Backdrop() {
  return (
    <div className="dl-backdrop" aria-hidden="true">
      <span className="dl-orb dl-orb-1" />
      <span className="dl-orb dl-orb-2" />
      <span className="dl-orb dl-orb-3" />
      <span className="dl-orb dl-orb-4" />
      <span className="dl-dots" />
    </div>
  );
}

/** The reference's refraction: noise that bends the light inside liquid glass (an SVG filter). */
function RefractionFilter() {
  return (
    <svg className="dl-defs" aria-hidden="true" focusable="false">
      <filter
        id="dl-refract"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.014 0.018"
          numOctaves={3}
          seed={7}
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale={14}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

function AppBar({
  screen,
  onScreen,
  clock,
  toMake,
  claims,
}: {
  screen: Screen;
  onScreen: (screen: Screen) => void;
  clock: number;
  toMake: number;
  claims: number;
}) {
  return (
    <header className="dl-glass dl-strong dl-bar">
      <div className="dl-brand">
        <span className="dl-mark" aria-hidden="true">
          <Gi n="bowl" />
        </span>
        <span className="dl-brand-name">แซ่บโดนเส้น</span>
      </div>
      <nav className="dl-bar-nav" aria-label="หน้าจอ">
        <Seg
          name="dl-screen"
          label="หน้าจอ"
          value={screen}
          onChange={onScreen}
          options={[
            { value: 'kitchen', label: 'ครัว', icon: 'flame', badge: toMake },
            {
              value: 'overview',
              label: 'ภาพรวม',
              icon: 'dashboard',
              ...(claims > 0 ? { badge: claims } : {}),
            },
            { value: 'menu', label: 'เมนู', icon: 'bowl' },
          ]}
        />
      </nav>
      <span className="dl-live">
        <span className="dl-live-dot" aria-hidden="true" />
        <span>ออนไลน์ · {clockTime(atClock(clock))}</span>
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------------------------
// Kitchen board
// ---------------------------------------------------------------------------------------------

function TicketCard({
  ticket,
  clock,
  rang,
  onMove,
}: {
  ticket: Ticket;
  clock: number;
  rang: boolean;
  onMove: () => void;
}) {
  const minutes = Math.max(0, clock - ticket.since);
  const level = waitLevel(minutes);
  const share = Math.min(100, Math.round((minutes / WAIT_LATE_MINUTES) * 100));
  return (
    <article
      className={`dl-glass dl-ticket${ticket.leaving ? ' dl-leave' : ''}`}
      data-stage={ticket.stage}
      data-level={level}
      aria-labelledby={`dl-t-${ticket.id}`}
    >
      <span className="dl-stripe" aria-hidden="true" />
      {ticket.fresh ? <span className="dl-pulse" aria-hidden="true" /> : null}
      {rang ? (
        <span className="dl-bell" aria-hidden="true">
          <Gi n="bell" />
        </span>
      ) : null}
      <div className="dl-tk-top">
        <h3 id={`dl-t-${ticket.id}`} className="dl-tk-no dl-num dl-tight">
          {ticket.orderNo}
        </h3>
        <span className="dl-wait dl-num" data-level={level}>
          {level === 'ok' ? null : <Gi n="warn" size="sm" />}
          {minutes} นาที
          {level === 'ok' ? null : (
            <span className="dl-wait-word">{level === 'late' ? 'ช้ามาก' : 'เกินเวลา'}</span>
          )}
        </span>
      </div>
      <div className="dl-timebar" data-level={level} aria-hidden="true">
        <span className="dl-timebar-fill" style={{ width: `${share}%` }} />
      </div>
      <span className="dl-stagechip">
        <span className="dl-dot" aria-hidden="true" />
        {STAGE_LABEL[ticket.stage]}
      </span>
      <div className="dl-where">
        <Gi n={ticket.delivery ? 'building' : 'store'} />
        <span>{ticket.where}</span>
      </div>
      {ticket.lineName ? (
        <div className="dl-who">
          <Gi n="user" size="sm" />
          <span>{ticket.lineName}</span>
        </div>
      ) : null}
      <ul className="dl-items">
        {ticket.items.map((line) => (
          <li key={`${line.name}-${line.opts ?? ''}`} className="dl-item">
            <span className="dl-q dl-num">
              {line.qty}
              <span className="dl-sr">×</span>
            </span>
            <span className="dl-item-text">
              <span className="dl-nm">{line.name}</span>
              {line.opts ? <span className="dl-opt">{line.opts}</span> : null}
              {line.note ? <span className="dl-opt dl-opt-note">{line.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {ticket.note ? (
        <div className="dl-note">
          <Gi n="note" size="sm" />
          <span>{ticket.note}</span>
        </div>
      ) : null}
      <div className="dl-meta">
        <span>{ticket.channel}</span>
        <span className="dl-pay" data-pay={ticket.pay}>
          <Gi n={ticket.pay === 'paid' ? 'check' : 'pending'} size="sm" />
          {PAY_WORDS[ticket.pay]}
          {ticket.payVia ? ` · ${ticket.payVia}` : ''}
        </span>
      </div>
      <button
        type="button"
        className={`dl-btn dl-btn-lg dl-btn-block dl-move dl-move-${ticket.stage}`}
        disabled={ticket.leaving}
        onClick={onMove}
      >
        {ticket.stage === 'cooking' ? <Gi n="check" /> : null}
        {MOVE_LABEL[ticket.stage]}
      </button>
    </article>
  );
}

const STAGES: readonly Stage[] = ['new', 'cooking', 'ready'];

function KitchenScreen({ sample, motion }: { sample: Sample; motion: Motion }) {
  const board = useRef<HTMLDivElement>(null);
  const flip = useFlip(board, motion);
  const { beforeMove } = sample;
  useLayoutEffect(() => {
    beforeMove.current = flip.capture;
    return () => {
      beforeMove.current = null;
    };
  }, [beforeMove, flip.capture]);
  // After every render: cards whose place changed since the last capture glide there.
  useLayoutEffect(() => flip.play());
  const bySince = (a: Ticket, b: Ticket) => a.since - b.since || a.orderNo.localeCompare(b.orderNo);
  return (
    <section className="dl-screen" aria-labelledby="dl-kitchen-title">
      <div className="dl-head">
        <div className="dl-head-text">
          <p className="dl-eyebrow">ครัว · {weekdayDate(atClock(sample.clock), 'th')}</p>
          <h1 id="dl-kitchen-title" className="dl-h1">
            คิวออเดอร์
          </h1>
          <p className="dl-sub">
            ส่งมอบแล้ววันนี้ <span className="dl-num">{sample.handedOver}</span> ใบ · เฉลี่ย 9 นาที
          </p>
        </div>
        <div className="dl-head-tools">
          <button type="button" className="dl-btn dl-labtool" onClick={sample.arrive}>
            <Gi n="plus" size="sm" />
            จำลองออเดอร์ใหม่
          </button>
          <button type="button" className="dl-btn dl-labtool" onClick={() => sample.warp(4)}>
            <Gi n="clock" size="sm" />
            เวลา +4 นาที
          </button>
        </div>
      </div>
      <div ref={board} className="dl-board">
        {STAGES.map((stage) => {
          const list = sample.tickets.filter((t) => t.stage === stage).sort(bySince);
          return (
            <section
              key={stage}
              className="dl-glass dl-col"
              data-stage={stage}
              aria-labelledby={`dl-col-${stage}`}
            >
              <header className="dl-col-head">
                <h2 id={`dl-col-${stage}`} className="dl-col-title">
                  <span className="dl-dot" aria-hidden="true" />
                  {STAGE_LABEL[stage]}
                </h2>
                <span className="dl-count dl-num">{list.length} ใบ</span>
              </header>
              {list.length === 0 ? (
                <p className="dl-empty">{STAGE_EMPTY[stage]}</p>
              ) : (
                <ul className="dl-col-list">
                  {list.map((ticket) => (
                    <li key={ticket.id} data-flip={ticket.id}>
                      <TicketCard
                        ticket={ticket}
                        clock={sample.clock}
                        rang={sample.rang === ticket.id}
                        onMove={() => sample.advance(ticket.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

function Delta({ text, down }: { text: string; down?: boolean }) {
  return (
    <span className="dl-delta dl-num" data-down={down ? '' : undefined}>
      <Gi n="trend" size="sm" className="dl-delta-icon" />
      {text}
    </span>
  );
}

/** A baht amount with its satang dimmed, so the whole baht reads first (Studio: "฿92.65"). */
function Money({ satang, auto }: { satang: number; auto?: boolean }) {
  const text = formatBaht(satang, 'th', auto ? { decimals: 'auto' } : {});
  const dot = text.lastIndexOf('.');
  if (dot < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, dot)}
      <span className="dl-frac">{text.slice(dot)}</span>
    </>
  );
}

function Kpi({
  label,
  value,
  note,
  extra,
  onOpen,
  attention,
}: {
  label: string;
  value: ReactNode;
  note: string;
  extra?: ReactNode;
  onOpen?: () => void;
  attention?: boolean;
}) {
  const body = (
    <>
      <span className="dl-kpi-top">
        <span className="dl-kpi-num dl-num dl-tight">{value}</span>
        {extra}
      </span>
      <span className="dl-kpi-label">{label}</span>
      <span className="dl-kpi-note">{note}</span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="dl-glass dl-kpi"
      data-attention={attention ? '' : undefined}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div className="dl-glass dl-kpi">{body}</div>
  );
}

/** A smooth line through the points (Catmull-Rom as cubic Béziers). */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))] ?? [0, 0];
  let d = '';
  for (let i = 0; i < points.length; i += 1) {
    const [x, y] = at(i);
    if (i === 0) {
      d = `M ${x} ${y}`;
      continue;
    }
    const [x0, y0] = at(i - 2);
    const [x1, y1] = at(i - 1);
    const [x3, y3] = at(i + 1);
    const c1 = [x1 + (x - x0) / 6, y1 + (y - y0) / 6];
    const c2 = [x - (x3 - x1) / 6, y - (y3 - y1) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${x} ${y}`;
  }
  return d;
}

/** Today against the same weekday last week, hour by hour; tap or hover an hour to read it. */
function SalesChart({
  today,
  revenue,
  change,
}: {
  today: readonly number[];
  revenue: number;
  change: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const width = useWidth(holder);
  const [picked, setPicked] = useState(today.length - 1);
  const height = 210;
  const pad = { left: 46, right: 14, top: 14, bottom: 28 };
  const top = Math.ceil(Math.max(...today, ...LAST_WEEK_HOURLY) / 20000) * 20000;
  const plotW = Math.max(0, width - pad.left - pad.right);
  const x = (i: number) => pad.left + (i * plotW) / (HOURS.length - 1);
  const y = (v: number) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom);
  const todayPoints = today.map((v, i) => [x(i), y(v)] as const);
  const lastPoints = LAST_WEEK_HOURLY.map((v, i) => [x(i), y(v)] as const);
  const line = smoothPath(todayPoints);
  const end = todayPoints[todayPoints.length - 1] ?? [0, 0];
  const area = `${line} L ${end[0]} ${y(0)} L ${x(0)} ${y(0)} Z`;
  const every = width < 560 ? 2 : 1;
  const pickedToday = today[picked];
  const pickedLast = LAST_WEEK_HOURLY[picked] ?? 0;
  const tipLeft = Math.min(Math.max(x(picked), 90), Math.max(90, width - 90));
  return (
    <>
      <div className="dl-card-head">
        <div>
          <p className="dl-eyebrow">ยอดรับเงินรายชั่วโมง</p>
          <p className="dl-big dl-num dl-tight">
            <Money satang={revenue} auto />
          </p>
          <p className="dl-sub">
            <strong className="dl-up">{change >= 0 ? `+${change}%` : `${change}%`}</strong>{' '}
            เทียบอาทิตย์ที่แล้ว เวลาเดียวกัน
          </p>
        </div>
        <ul className="dl-legend" aria-label="คำอธิบายเส้น">
          <li>
            <span className="dl-swatch dl-swatch-today" aria-hidden="true" />
            วันนี้
          </li>
          <li>
            <span className="dl-swatch dl-swatch-last" aria-hidden="true" />
            อาทิตย์ที่แล้ว
          </li>
        </ul>
      </div>
      <div ref={holder} className="dl-chart">
        {width > 0 ? (
          <svg width={width} height={height} role="img" aria-labelledby="dl-chart-title">
            <title id="dl-chart-title">ยอดรับเงินรายชั่วโมงวันนี้ {baht(revenue)} เทียบอาทิตย์ที่แล้ว</title>
            <defs>
              <linearGradient id="dl-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="dl-area-top" />
                <stop offset="100%" className="dl-area-bottom" />
              </linearGradient>
              <linearGradient id="dl-line-paint" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" className="dl-line-a" />
                <stop offset="100%" className="dl-line-b" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((share) => (
              <g key={share}>
                <line
                  className="dl-grid"
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={y(top * share)}
                  y2={y(top * share)}
                />
                <text className="dl-axis" x={0} y={y(top * share) + 4}>
                  {baht(top * share)}
                </text>
              </g>
            ))}
            {HOURS.map((hour, i) =>
              i % every === 0 ? (
                <text
                  key={hour}
                  className="dl-axis"
                  data-on={i === picked ? '' : undefined}
                  x={x(i)}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {hour}
                </text>
              ) : null,
            )}
            <path className="dl-last" d={smoothPath(lastPoints)} />
            <path className="dl-area" d={area} />
            <path className="dl-line" d={line} pathLength={1} />
            <line className="dl-guide" x1={x(picked)} x2={x(picked)} y1={pad.top} y2={y(0)} />
            <circle className="dl-pt-last" cx={x(picked)} cy={y(pickedLast)} r={4.5} />
            {pickedToday === undefined ? null : (
              <circle className="dl-pt" cx={x(picked)} cy={y(pickedToday)} r={6} />
            )}
            <circle className="dl-now" cx={end[0]} cy={end[1]} r={4} />
          </svg>
        ) : null}
        <div className="dl-chart-hit" style={{ left: pad.left - 16, right: pad.right - 16 }}>
          {HOURS.map((hour, i) => (
            <button
              key={hour}
              type="button"
              aria-label={`${hour} วันนี้ ${today[i] === undefined ? 'ยังไม่ถึง' : baht(today[i] ?? 0)}`}
              aria-pressed={i === picked}
              onPointerEnter={() => setPicked(i)}
              onFocus={() => setPicked(i)}
              onClick={() => setPicked(i)}
            />
          ))}
        </div>
        <div className="dl-glass dl-strong dl-tip" style={{ left: tipLeft }} aria-hidden="true">
          <span className="dl-tip-hour dl-num">{HOURS[picked]} น.</span>
          <span className="dl-tip-row">
            <span className="dl-swatch dl-swatch-today" />
            วันนี้
            <strong className="dl-num">
              {pickedToday === undefined ? 'ยังไม่ถึง' : baht(pickedToday)}
            </strong>
          </span>
          <span className="dl-tip-row dl-tip-muted">
            <span className="dl-swatch dl-swatch-last" />
            อาทิตย์ที่แล้ว
            <strong className="dl-num">{baht(pickedLast)}</strong>
          </span>
        </div>
      </div>
    </>
  );
}

const TICK_COUNT = 38;
const TICKS = Array.from({ length: TICK_COUNT }, (_, i) => {
  const angle = ((-165 + (i / (TICK_COUNT - 1)) * 150) * Math.PI) / 180;
  return { id: `tick-${i}`, i, cos: Math.cos(angle), sin: Math.sin(angle) };
});

/** The reference's tick dial, here for the VAT threshold card the overview already has. */
function TickGauge({ percent, label }: { percent: number; label: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(percent));
    return () => cancelAnimationFrame(frame);
  }, [percent]);
  const active = Math.round((shown / 100) * TICK_COUNT);
  return (
    <svg className="dl-gauge" viewBox="0 0 220 120" role="img" aria-labelledby="dl-gauge-title">
      <title id="dl-gauge-title">{label}</title>
      <defs>
        <radialGradient id="dl-gauge-glow" cx="50%" cy="72%" r="55%">
          <stop offset="0%" className="dl-glow-0" />
          <stop offset="70%" className="dl-glow-1" />
          <stop offset="100%" className="dl-glow-2" />
        </radialGradient>
      </defs>
      <ellipse cx={110} cy={98} rx={70} ry={42} fill="url(#dl-gauge-glow)" />
      {TICKS.map((tick) => {
        const on = tick.i < active;
        const outer = on ? 84 : 78;
        return (
          <line
            key={tick.id}
            className="dl-tick"
            data-on={on ? '' : undefined}
            style={{ '--i': tick.i } as CSSProperties}
            x1={110 + 68 * tick.cos}
            y1={106 + 68 * tick.sin}
            x2={110 + outer * tick.cos}
            y2={106 + outer * tick.sin}
          />
        );
      })}
    </svg>
  );
}

function OverviewScreen({ sample }: { sample: Sample }) {
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'year'>('today');
  const revenue = sum(sample.today);
  const before = sum(LAST_WEEK_HOURLY.slice(0, sample.today.length));
  const change = Math.round(((revenue - before) * 100) / before);
  const average = Math.round(revenue / sample.paidOrders);
  const averageBefore = Math.round(before / ORDERS_LAST_WEEK);
  const averageChange = average - averageBefore;
  const open = sample.tickets.filter((t) => !t.leaving).length;
  const first = sample.claims[0];
  const best = [...MENU].sort((a, b) => b.soldToday - a.soldToday).slice(0, 4);
  const bestTop = best[0]?.soldToday ?? 1;
  return (
    <section className="dl-screen" aria-labelledby="dl-overview-title">
      <div className="dl-head">
        <div className="dl-head-text">
          <p className="dl-eyebrow">
            หลังร้าน · {weekdayDate(atClock(sample.clock), 'th')} · อัปเดต{' '}
            {clockTime(atClock(sample.clock))} น.
          </p>
          <h1 id="dl-overview-title" className="dl-h1">
            ภาพรวม
          </h1>
        </div>
        <div className="dl-head-tools">
          <Seg
            name="dl-period"
            label="ช่วงเวลา"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today', label: 'วันนี้' },
              { value: 'week', label: 'สัปดาห์' },
              { value: 'month', label: 'เดือน' },
              { value: 'year', label: 'ปี' },
            ]}
          />
          <button type="button" className="dl-btn dl-labtool" onClick={sample.claimArrives}>
            <Gi n="bell" size="sm" />
            จำลองลูกค้าแจ้งโอน
          </button>
        </div>
      </div>
      {period === 'today' ? null : (
        <p className="dl-labnote">ตัวอย่างนี้มีข้อมูลแค่วันนี้ แถบเลือกช่วงเวลาโชว์แค่การเคลื่อนไหว</p>
      )}
      <div className="dl-kpis">
        <Kpi
          label="ยอดรับเงินแล้ว"
          value={<Money satang={revenue} auto />}
          note="เทียบอาทิตย์ที่แล้ว เวลาเดียวกัน"
          extra={<Delta text={`${change >= 0 ? '+' : ''}${change}%`} down={change < 0} />}
        />
        <Kpi
          label="ออเดอร์ที่ชำระแล้ว"
          value={String(sample.paidOrders)}
          note={`อยู่ในครัวตอนนี้ ${open} ใบ`}
          extra={<Delta text={`+${sample.paidOrders - ORDERS_LAST_WEEK}`} />}
        />
        <Kpi
          label="เฉลี่ยต่อบิล"
          value={<Money satang={average} auto />}
          note={`อาทิตย์ที่แล้ว ${baht(averageBefore)}`}
          extra={
            <Delta
              text={`${averageChange >= 0 ? '+' : '−'}${baht(Math.abs(averageChange))}`}
              down={averageChange < 0}
            />
          }
        />
        {first ? (
          <Kpi
            label="รอตรวจสลิป"
            value={String(sample.claims.length)}
            note={`แตะเพื่อตรวจ ${first.orderNo}`}
            attention
            extra={<span className="dl-attn-dot" aria-hidden="true" />}
            onOpen={() => sample.setPaying(first)}
          />
        ) : (
          <Kpi label="รอตรวจสลิป" value="0" note="ตรวจครบแล้ว" />
        )}
      </div>
      <div className="dl-bento">
        <div className="dl-glass dl-card dl-span-8">
          <SalesChart today={sample.today} revenue={revenue} change={change} />
        </div>
        <div className="dl-glass dl-card dl-span-4 dl-gauge-card">
          <div className="dl-card-head">
            <p className="dl-eyebrow">เกณฑ์จด VAT ปีนี้</p>
            <span className="dl-tag">ตัวอย่าง</span>
          </div>
          <div className="dl-gauge-wrap">
            <TickGauge
              percent={SAMPLE_VAT.percent}
              label={`ถึงเกณฑ์จด VAT แล้ว ${SAMPLE_VAT.percent}%`}
            />
            <div className="dl-gauge-read">
              <span className="dl-gauge-num dl-num dl-tight">
                {SAMPLE_VAT.percent}
                <span className="dl-unit">%</span>
              </span>
              <span className="dl-gauge-label">ของ {SAMPLE_VAT.limit}</span>
            </div>
          </div>
          <p className="dl-sub">
            รายได้สะสมปี 2569 ประมาณ {SAMPLE_VAT.year} · ถึงเกณฑ์ราว ธ.ค. ที่อัตราปัจจุบัน
          </p>
          <p className="dl-fine">ประมาณการเพื่อวางแผน ไม่ใช่คำปรึกษาด้านภาษี</p>
        </div>
      </div>
      <div className="dl-trio">
        <div className="dl-glass dl-card">
          <p className="dl-eyebrow">ช่องทาง · สัดส่วนยอดขายวันนี้</p>
          <div className="dl-stack" role="img" aria-label="สัดส่วนยอดขายตามช่องทาง">
            {CHANNEL_SHARE.map((c, i) => (
              <span key={c.name} data-s={i + 1} style={{ width: `${c.percent}%` }} />
            ))}
          </div>
          <ul className="dl-shares">
            {CHANNEL_SHARE.map((c, i) => (
              <li key={c.name}>
                <span className="dl-swatch" data-s={i + 1} aria-hidden="true" />
                <span className="dl-share-name">{c.name}</span>
                <span className="dl-num dl-share-pct">{c.percent}%</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="dl-glass dl-card">
          <p className="dl-eyebrow">ขายดีวันนี้</p>
          <ul className="dl-bars">
            {best.map((dish) => (
              <li key={dish.id}>
                <span className="dl-bar-row">
                  <span>{dish.nameTh}</span>
                  <span className="dl-num dl-bar-count">{dish.soldToday} ชาม</span>
                </span>
                <span className="dl-bar-track" aria-hidden="true">
                  <span
                    className="dl-bar-fill"
                    style={{ width: `${Math.round((dish.soldToday * 100) / bestTop)}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="dl-glass dl-card">
          <p className="dl-eyebrow">ความเคลื่อนไหว</p>
          <ul className="dl-feed">
            {sample.activity.map((entry) => (
              <li key={entry.id} data-kind={entry.kind}>
                <span className="dl-feed-icon" aria-hidden="true">
                  <Gi n={ACTIVITY_ICON[entry.kind]} size="sm" />
                </span>
                <span className="dl-feed-text">
                  <span className="dl-feed-title">{entry.title}</span>
                  <span className="dl-feed-sub">
                    {entry.sub} · {agoText(sample.clock - entry.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="dl-glass dl-card">
        <div className="dl-card-head">
          <div>
            <p className="dl-eyebrow">ช่วงเวลาที่ขายดี</p>
            <p className="dl-sub">ออเดอร์เฉลี่ยต่อ 2 ชั่วโมง · 8 สัปดาห์ล่าสุด · สูงสุด อา. 12:00 (13)</p>
          </div>
        </div>
        <div className="dl-heat-wrap">
          <table className="dl-heat">
            <caption className="dl-sr">ออเดอร์เฉลี่ยต่อ 2 ชั่วโมง แยกตามวันและเวลา</caption>
            <thead>
              <tr>
                <td />
                {HEAT_HOURS.map((hour) => (
                  <th key={hour} scope="col" className="dl-num">
                    {hour}:00
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HEAT_DAYS.map((day, d) => (
                <tr key={day}>
                  <th scope="row">{day}</th>
                  {HEAT_HOURS.map((hour, h) => {
                    const value = HEAT[d]?.[h] ?? 0;
                    return (
                      <td key={hour}>
                        <span className="dl-heat-cell dl-num" data-l={heatLevel(value)}>
                          {value}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Menu: sold-out switches
// ---------------------------------------------------------------------------------------------

function DishCard({ dish, off, onToggle }: { dish: Dish; off: boolean; onToggle: () => void }) {
  const art = dishArt(dish.nameTh, dish.nameEn);
  return (
    <article className="dl-glass dl-dish" data-off={off ? '' : undefined}>
      <div className={`dl-plate dl-tint-${art.tint}`}>
        <img className="dl-plate-art" src={dishArtUrl(art)} alt="" width={160} height={160} />
        {off ? (
          <span className="dl-stamp" aria-hidden="true">
            หมด
          </span>
        ) : null}
      </div>
      <div className="dl-dish-body">
        <p className="dl-cap">
          {CATEGORY_LABEL[dish.category]} · ขายวันนี้ <span className="dl-num">{dish.soldToday}</span>
        </p>
        <h3 className="dl-dish-name">{dish.nameTh}</h3>
        <div className="dl-dish-foot">
          <span className="dl-price dl-num">{baht(dish.price)}</span>
          <label className="dl-switch">
            <input
              className="dl-sr"
              type="checkbox"
              role="switch"
              aria-checked={!off}
              checked={!off}
              onChange={onToggle}
            />
            <span className="dl-track" aria-hidden="true" />
            <span className="dl-sr">{dish.nameTh}: </span>
            <span className="dl-switch-text">{off ? 'หมด' : 'ขายอยู่'}</span>
          </label>
        </div>
      </div>
    </article>
  );
}

function MenuScreen({ sample }: { sample: Sample }) {
  const [category, setCategory] = useState<'all' | Category>('all');
  const shown = MENU.filter((d) => category === 'all' || d.category === category);
  const soldOut = MENU.filter((d) => sample.soldOut.has(d.id));
  return (
    <section className="dl-screen" aria-labelledby="dl-menu-title">
      <div className="dl-head">
        <div className="dl-head-text">
          <p className="dl-eyebrow">เมนู · ของหมดวันนี้</p>
          <h1 id="dl-menu-title" className="dl-h1">
            เปิด-ปิดเมนู
          </h1>
          <p className="dl-sub">แตะสวิตช์เมื่อของหมด ลูกค้าจะสั่งเมนูนั้นไม่ได้จนกว่าจะเปิดอีกครั้ง</p>
        </div>
        <div className="dl-head-tools">
          <span className="dl-glass dl-pill">
            <strong className="dl-num">
              {MENU.length - soldOut.length}/{MENU.length}
            </strong>
            ขายอยู่
          </span>
          {soldOut.length > 0 ? (
            <span className="dl-glass dl-pill dl-pill-off">
              <Gi n="x" size="sm" />
              หมด: {soldOut.map((d) => d.nameTh).join(', ')}
            </span>
          ) : (
            <span className="dl-glass dl-pill">
              <Gi n="check" size="sm" />
              ทุกเมนูขายอยู่
            </span>
          )}
        </div>
      </div>
      <Seg
        name="dl-category"
        label="หมวด"
        value={category}
        onChange={setCategory}
        options={[
          { value: 'all', label: 'ทั้งหมด' },
          { value: 'noodle', label: CATEGORY_LABEL.noodle },
          { value: 'side', label: CATEGORY_LABEL.side },
          { value: 'drink', label: CATEGORY_LABEL.drink },
        ]}
      />
      <ul className="dl-menu-grid">
        {shown.map((dish) => (
          <li key={dish.id}>
            <DishCard
              dish={dish}
              off={sample.soldOut.has(dish.id)}
              onToggle={() => sample.toggleDish(dish.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Payment pop-up and toast
// ---------------------------------------------------------------------------------------------

/**
 * The staff payment pop-up (D-42) in the new look: the amount is the biggest thing on it, staff
 * check the bank app and confirm by hand (domain rule 2), and nothing is confirmed for them.
 */
function PaySheet({
  claim,
  speed,
  onConfirm,
  onClose,
}: {
  claim: Claim;
  speed: Speed;
  onConfirm: (claim: Claim) => void;
  onClose: () => void;
}) {
  const [done, setDone] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheet.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(onClose, 1600 / speed);
    return () => window.clearTimeout(timer);
  }, [done, onClose, speed]);
  const amount = formatBaht(claim.amount, 'th');
  return (
    <>
      <button type="button" className="dl-scrim" aria-label="ปิด" tabIndex={-1} onClick={onClose} />
      <div
        ref={sheet}
        className="dl-glass dl-strong dl-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dl-pay-title"
        tabIndex={-1}
      >
        {done ? (
          <div className="dl-paid" role="status">
            <svg className="dl-paid-mark" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx={32} cy={32} r={28} pathLength={1} />
              <path d="M19 33.5 L28 42 L45 23" pathLength={1} />
            </svg>
            <p className="dl-amount dl-num dl-tight">
              <Money satang={claim.amount} />
            </p>
            <p id="dl-pay-title" className="dl-paid-text">
              รับเงินแล้ว · {claim.orderNo} ส่งเข้าครัวแล้ว
            </p>
          </div>
        ) : (
          <>
            <div className="dl-sheet-head">
              <p className="dl-eyebrow">
                <Gi n="bell" size="sm" />
                ลูกค้ากด “โอนแล้ว” · {clockTime(atClock(claim.at))} น.
              </p>
              <button
                type="button"
                className="dl-btn dl-btn-icon"
                aria-label="ปิด"
                onClick={onClose}
              >
                <Gi n="x" />
              </button>
            </div>
            <h2 id="dl-pay-title" className="dl-sheet-title">
              <span className="dl-num">{claim.orderNo}</span> · {claim.seed.lineName} · LINE
            </h2>
            <p className="dl-amount dl-num dl-tight">
              <Money satang={claim.amount} />
            </p>
            <dl className="dl-rows">
              <div>
                <dt>วิธีชำระ</dt>
                <dd>พร้อมเพย์</dd>
              </div>
              <div>
                <dt>สลิป</dt>
                <dd>
                  <span className="dl-info">
                    <Gi n="info" size="sm" className="dl-info-icon" />
                    {claim.slip}
                  </span>
                </dd>
              </div>
              <div>
                <dt>รายการ</dt>
                <dd>{claim.seed.items.map((line) => `${line.qty}× ${line.name}`).join(' · ')}</dd>
              </div>
              <div>
                <dt>ส่งที่</dt>
                <dd>{claim.seed.where}</dd>
              </div>
            </dl>
            <p className="dl-hint">
              <Gi n="warn" size="sm" />
              ตรวจยอดเข้าบัญชีก่อนกดยืนยันทุกครั้ง
            </p>
            <div className="dl-sheet-actions">
              <button
                type="button"
                className="dl-btn dl-btn-money dl-btn-lg dl-btn-block"
                onClick={() => {
                  setDone(true);
                  onConfirm(claim);
                }}
              >
                <Gi n="check" />
                ยืนยันรับเงิน {amount}
              </button>
              <button type="button" className="dl-btn dl-btn-block" onClick={onClose}>
                ไว้ทีหลัง
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ToastView({ toast, onDone }: { toast: Toast | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDone, toast.action ? 5200 : 3200);
    return () => window.clearTimeout(timer);
  }, [toast, onDone]);
  const content = toast ? (
    <>
      <span className="dl-toast-icon" aria-hidden="true">
        <Gi n={toast.icon} size="sm" />
      </span>
      <span>{toast.text}</span>
      {toast.action ? <span className="dl-toast-go">{toast.action.label}</span> : null}
    </>
  ) : null;
  return (
    <div className="dl-toast-slot" role="status" aria-live="polite">
      {toast?.action ? (
        <button
          key={toast.id}
          type="button"
          className="dl-glass dl-strong dl-toast"
          onClick={() => {
            toast.action?.run();
            onDone();
          }}
        >
          {content}
        </button>
      ) : toast ? (
        <div key={toast.id} className="dl-glass dl-strong dl-toast">
          {content}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Options panel and notes
// ---------------------------------------------------------------------------------------------

function Field<T extends string | number>({
  id,
  label,
  choices,
  value,
  onChange,
}: {
  id: string;
  label: string;
  choices: readonly Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const hint = choices.find((c) => c.value === value)?.hint ?? '';
  return (
    <div className="dl-field">
      <span className="dl-field-label" id={`${id}-label`}>
        {label}
      </span>
      <Seg name={id} label={label} value={value} onChange={onChange} options={choices} small />
      <span className="dl-field-hint">{hint}</span>
    </div>
  );
}

function Inspector({
  options,
  set,
  open,
  onToggle,
  onReset,
  onNotes,
}: {
  options: Options;
  set: <K extends keyof Options>(key: K, value: Options[K]) => void;
  open: boolean;
  onToggle: () => void;
  onReset: () => void;
  onNotes: () => void;
}) {
  return (
    <aside className="dl-glass dl-strong dl-inspector" aria-label="Design options" lang="en">
      <div className="dl-insp-head">
        <button
          type="button"
          className="dl-insp-toggle"
          aria-expanded={open}
          aria-controls="dl-insp-body"
          onClick={onToggle}
        >
          <Gi n="sliders" size="sm" />
          <span>Design options</span>
          <Gi n={open ? 'minus' : 'plus'} size="sm" />
        </button>
        <button type="button" className="dl-btn dl-btn-sm" onClick={onNotes}>
          <Gi n="info" size="sm" />
          Read me
        </button>
      </div>
      {open ? (
        <div id="dl-insp-body" className="dl-insp-body">
          <Field
            id="dl-o-direction"
            label="Direction"
            choices={DIRECTION_CHOICES}
            value={options.direction}
            onChange={(v) => set('direction', v)}
          />
          <Field
            id="dl-o-depth"
            label="Glass"
            choices={DEPTH_CHOICES}
            value={options.depth}
            onChange={(v) => set('depth', v)}
          />
          <label
            className="dl-switch dl-switch-sm"
            data-disabled={options.depth === 'liquid' ? undefined : ''}
          >
            <input
              className="dl-sr"
              type="checkbox"
              role="switch"
              aria-checked={options.refract}
              checked={options.refract}
              disabled={options.depth !== 'liquid'}
              onChange={(e) => set('refract', e.currentTarget.checked)}
            />
            <span className="dl-track" aria-hidden="true" />
            <span className="dl-switch-text">Refraction (Liquid only, heavier)</span>
          </label>
          <Field
            id="dl-o-card"
            label="Kitchen card"
            choices={CARD_CHOICES}
            value={options.card}
            onChange={(v) => set('card', v)}
          />
          <Field
            id="dl-o-speed"
            label="Motion"
            choices={SPEED_CHOICES}
            value={options.speed}
            onChange={(v) => set('speed', v)}
          />
          <Field
            id="dl-o-frame"
            label="Screen"
            choices={FRAME_CHOICES}
            value={options.frame}
            onChange={(v) => set('frame', v)}
          />
          <button type="button" className="dl-btn dl-btn-sm dl-btn-quiet" onClick={onReset}>
            <Gi n="clock" size="sm" />
            Reset the sample orders
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function Notes({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dl-glass dl-strong dl-notes"
      aria-labelledby="dl-notes-title"
      lang="en"
      onClose={onClose}
    >
      <div className="dl-notes-head">
        <h2 id="dl-notes-title">How to read this page</h2>
        <button type="button" className="dl-btn dl-btn-icon" aria-label="Close" onClick={onClose}>
          <Gi n="x" />
        </button>
      </div>
      <p>
        Four looks on the same staff screens, with made-up orders. Nothing here touches real data or
        the live app. Change the options in the panel; your choice is kept on this device.
      </p>
      <h3>The four looks</h3>
      <ul>
        <li>
          <strong>Studio dark.</strong> From your Iconly references: slate at the top fading to
          black, frosted cards with big rounded corners, a white pill for the active tab, thin large
          numbers with the decimals dimmed, a blue-to-violet chart line, and colour only in small
          status chips (green done and paid, orange cooking, red late).
        </li>
        <li>
          <strong>Studio light.</strong> The same layout on soft grey and white, with a black main
          button; the kitchen stays on Studio dark, as it stays dark today. Both Studio looks
          replace the chili-red main button (white or black), which changes the approved brand
          (decision D-22), so either would need a new decision.
        </li>
        <li>
          <strong>Brand night.</strong> The same liquid glass in your chili red, amber and jade on
          warm dark glass, on every screen. It is today's kitchen look, extended. It keeps the D-22
          colour rules.
        </li>
        <li>
          <strong>Today+.</strong> Today's warm paper look, with the kitchen still dark. It borrows
          only the finish: the glass edge, sliding tabs, spring motion, the dial and the stamp.
        </li>
      </ul>
      <h3>The other options</h3>
      <ul>
        <li>
          <strong>Glass.</strong> Flat has no blur and is the fastest on older iPads. Frost is
          today's glass. Liquid is your first file's look; it costs the most to draw, so try it on
          the shop's iPad before choosing it.
        </li>
        <li>
          <strong>Kitchen card.</strong> Stripe is today's card. Tint colours the whole card by
          stage. Time bar shows the wait against the 12-minute limit.
        </li>
        <li>
          <strong>Motion.</strong> Your first file's spring, which can be slowed to 0.5× or 0.25× to
          inspect it. A device set to reduce motion gets no movement.
        </li>
        <li>
          <strong>Screen.</strong> Preview at iPad or iPhone size inside this window.
        </li>
      </ul>
      <h3>Things to try</h3>
      <ul>
        <li>
          On <strong>ครัว</strong>, tap เริ่มทำ, ทำเสร็จ and ส่งมอบแล้ว to watch a card move. The dashed
          buttons are lab tools: a new order arrives, or the clock jumps 4 minutes so the wait
          colours change.
        </li>
        <li>
          On <strong>ภาพรวม</strong>, tap รอตรวจสลิป to check a transfer. Confirming it adds the
          order to the kitchen, as pay-first LINE orders do today.
        </li>
        <li>
          On <strong>เมนู</strong>, switch a dish off to see the sold-out stamp.
        </li>
      </ul>
      <h3>Taken from your files</h3>
      <p>
        Liquid glass surfaces, slow orbs and the dot grid, sliding pill tabs, cards that glide to
        the next column with a bell when ready, toast pills, the tick dial, the sold-out stamp, the
        today-against-last-week chart and the busy-hours grid (first file); thin numbers with dimmed
        decimals (second file); the slate-to-black and soft-white grounds, white active pills, black
        main button and blue-violet chart line (Iconly references).
      </p>
      <h3>Left out, and why</h3>
      <ul>
        <li>The floor plan, tables, waitlist and bookings: the shop has no tables.</li>
        <li>Prices and totals on kitchen cards: the kitchen view never shows money.</li>
        <li>
          Wide-spaced capital labels: Thai has no capitals, and letter spacing pulls tone marks away
          from their letters.
        </li>
        <li>
          Framer Motion, Tailwind and Lucide: the app does not use them. The same motion is done
          with CSS and the browser's animation API, so no new library is needed.
        </li>
        <li>SF Pro: Anuphan stays, because it is built for Thai.</li>
      </ul>
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// The lab
// ---------------------------------------------------------------------------------------------

export function DesignLab() {
  const [options, setOptions] = useState(loadOptions);
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [notesOpen, setNotesOpen] = useState(false);
  // Below laptop width the open panel would cover the board, so it starts folded there.
  const narrow = useMediaQuery('(max-width: 1279px)');
  const [inspectorOpen, setInspectorOpen] = useState(
    () => typeof matchMedia !== 'function' || !matchMedia('(max-width: 1279px)').matches,
  );
  useEffect(() => {
    const follow = () => setScreen(screenFromHash());
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const motion = useMotion(options.speed);
  const sample = useSample(motion);
  const root = useRef<HTMLDivElement>(null);
  useSheen(root, options.depth === 'liquid');

  const set = useCallback(<K extends keyof Options>(key: K, value: Options[K]) => {
    setOptions((current) => {
      const next = { ...current, [key]: value };
      saveOptions(next);
      return next;
    });
  }, []);
  const { setPaying, dismissToast: rawDismiss } = sample;
  const closePay = useCallback(() => setPaying(null), [setPaying]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sample's dismiss only clears the toast; a stable callback keeps the toast timer from restarting on every render
  const dismissToast = useCallback(rawDismiss, []);

  const toMake = sample.tickets.filter((t) => t.stage !== 'ready' && !t.leaving).length;
  const classes = [
    'dl',
    `dl-dir-${options.direction}`,
    `dl-depth-${options.depth}`,
    `dl-card-${options.card}`,
    options.refract && options.depth === 'liquid' ? 'dl-refract' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={root}
      className={classes}
      data-frame={options.frame}
      style={motion.vars as CSSProperties}
    >
      <RefractionFilter />
      <main className="dl-frame" data-screen={screen} lang="th">
        <Backdrop />
        <div className="dl-scroll">
          <div className="dl-app">
            <AppBar
              screen={screen}
              onScreen={setScreen}
              clock={sample.clock}
              toMake={toMake}
              claims={sample.claims.length}
            />
            <div key={screen} className="dl-enter">
              {screen === 'kitchen' ? (
                <KitchenScreen sample={sample} motion={motion} />
              ) : screen === 'overview' ? (
                <OverviewScreen sample={sample} />
              ) : (
                <MenuScreen sample={sample} />
              )}
            </div>
          </div>
        </div>
        <ToastView toast={sample.toast} onDone={dismissToast} />
        {sample.paying ? (
          <PaySheet
            key={sample.paying.id}
            claim={sample.paying}
            speed={options.speed}
            onConfirm={sample.confirm}
            onClose={closePay}
          />
        ) : null}
      </main>
      <Inspector
        options={options}
        set={set}
        open={inspectorOpen}
        onToggle={() => setInspectorOpen((o) => !o)}
        onReset={sample.reset}
        onNotes={() => {
          setNotesOpen(true);
          if (narrow) setInspectorOpen(false);
        }}
      />
      {notesOpen ? <Notes onClose={() => setNotesOpen(false)} /> : null}
    </div>
  );
}
