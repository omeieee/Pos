/**
 * Example numbers for the overview page. No report API exists yet, so the page shows these,
 * labelled as sample data, to match the design. Nothing here is read from or written to orders.
 */
export const SAMPLE_KPIS = {
  paid: { value: '฿4,860', delta: '4.3%', up: true, before: '฿4,660' },
  orders: { value: '38', delta: 3, up: true, before: '35' },
  average: { value: '฿128', delta: '1.1%', up: false, before: '฿133' },
  gross: { value: '฿2,970', margin: '61%' },
} as const;

export const SAMPLE_CHANNELS = [
  { key: 'store', color: '#1c1411', share: 46, amount: '฿2,236' },
  { key: 'line', color: '#c62828', share: 38, amount: '฿1,847' },
  { key: 'grab', color: '#f5a524', share: 16, amount: '฿777' },
] as const;

export const SAMPLE_TOP_ITEMS = [
  { name: 'ชาเย็น', qty: 17 },
  { name: 'ก๋วยเตี๋ยวต้มยำ', qty: 14 },
  { name: 'เย็นตาโฟ', qty: 11 },
  { name: 'บะหมี่แห้งหมูแดง', qty: 9 },
  { name: 'เรือหมูน้ำตก', qty: 7 },
] as const;

export const SAMPLE_PENDING = [
  { title: 'A-146 · LINE', detail: 'ลูกค้ากด “โอนแล้ว” 12:46', kind: 'review' },
  { title: 'A-139 · LINE', detail: 'ลูกค้ากด “โอนแล้ว” 12:21', kind: 'review' },
  { title: 'A-142 · หน้าร้าน', detail: '฿230.00 กำลังทำ', kind: 'unpaid' },
] as const;

export const SAMPLE_VAT = { percent: 62, limit: '฿1,800,000', year: '฿1,126,400' } as const;
