/** Thai catalog: common actions, statuses, app and network notices, roles, devices, durations. Params use `{name}` placeholders. */
export const thCommon = {
  // Common actions
  'common.save': 'บันทึก',
  'common.cancel': 'ยกเลิก',
  'common.back': 'ย้อนกลับ',
  'common.close': 'ปิด',
  'common.confirm': 'ยืนยัน',
  'common.edit': 'แก้ไข',
  'common.delete': 'ลบ',
  'common.retry': 'ลองอีกครั้ง',
  'common.search': 'ค้นหา',
  'common.loading': 'กำลังโหลด…',
  'common.total': 'ยอดรวม',
  'common.subtotal': 'รวมรายการ',
  'common.qty': 'จำนวน',
  'common.note': 'หมายเหตุ',
  'common.offline': 'ออฟไลน์ · บันทึกไว้ในเครื่อง รอซิงก์',
  'common.pendingSync': 'รอซิงก์ {count} รายการ',
  'common.error': 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง',

  // Order and payment status (always shown with colour + icon + text)
  'status.payment.unpaid': 'ยังไม่ชำระ',
  'status.payment.awaiting_confirmation': 'รอตรวจสอบ',
  'status.payment.partially_paid': 'ชำระบางส่วน',
  'status.payment.paid': 'ชำระแล้ว',
  'status.payment.refunded': 'คืนเงินแล้ว',
  'status.order.new': 'ใหม่',
  'status.order.preparing': 'กำลังทำ',
  'status.order.ready': 'พร้อมรับ',
  'status.order.completed': 'เสร็จสิ้น',
  'status.order.cancelled': 'ยกเลิกแล้ว',

  // Connection status
  'net.online': 'ซิงก์แล้ว',
  'net.connecting': 'กำลังเชื่อมต่อ…',
  'net.reconnecting': 'กำลังเชื่อมต่อใหม่…',
  'net.offline': 'ออฟไลน์',

  // App updates (service worker)
  'app.update.ready': 'มีเวอร์ชันใหม่ของแอป',
  'app.update.apply': 'อัปเดตเลย',
  'receipt.taxId': 'เลขประจำตัวผู้เสียภาษี {taxId}',
  'comingSoon.title': 'กำลังเตรียมหน้านี้',
  'comingSoon.body': 'หน้า “{page}” จะเปิดให้ใช้เร็ว ๆ นี้',
  'role.owner': 'เจ้าของร้าน',
  'role.manager': 'ผู้จัดการ',
  'role.cashier': 'แคชเชียร์',
  'role.kitchen': 'ครัว',
  'device.kind.ipad': 'iPad',
  'device.kind.iphone': 'iPhone',
  'device.kind.laptop': 'คอมพิวเตอร์',
  'device.kind.print_agent': 'เครื่องพิมพ์',
  'device.kind.display': 'จอแสดงผล',
  'duration.minutes': '{count} นาที',
  'duration.hours': '{count} ชั่วโมง',
  'catalogue.offline':
    'ใช้เมนูที่บันทึกไว้ในเครื่อง (ออฟไลน์) บันทึกเมื่อ {time} ราคาเป็นราคาโดยประมาณ ระบบจะคิดราคาจริงตอนส่งออเดอร์',
} as const;
