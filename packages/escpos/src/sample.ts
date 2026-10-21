import type { KitchenTicket } from '@sds/shared';

/** A made-up ticket (no real names or rooms) for the test print and the preview. */
export const SAMPLE_TICKET: KitchenTicket = {
  orderNo: 'L-012',
  channel: 'line',
  fulfillment: 'entrance_delivery',
  who: 'คุณสมชาย ทดสอบ',
  building: 'อาคาร A',
  roomNo: null,
  deliveryNote: 'ฝากไว้กับ รปภ. หน้าตึก ไม่ต้องโทร',
  orderNote: 'ขอช้อนส้อมเพิ่ม',
  lines: [
    { qty: 2, nameTh: 'ก๋วยเตี๋ยวต้มยำหมูสับ', modifiers: ['เส้นเล็ก', 'ไม่ใส่ผักชี'], note: null },
    {
      qty: 1,
      nameTh: 'ผัดไทยกุ้งสด ไข่ห่อ',
      modifiers: ['เผ็ดน้อย'],
      note: 'ไม่ใส่ถั่วงอก แพ้ถั่วลิสง',
    },
    { qty: 12, nameTh: 'เกี๊ยวทอด', modifiers: [], note: null },
  ],
  placedDate: '2026-10-22',
  placedTime: '14:05',
  reprint: false,
  copy: 0,
};
