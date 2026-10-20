/** Thai catalog: back-office reports and their exports (P6). Params use `{name}` placeholders. */
export const thReports = {
  // CSV columns for the accountant (the payment and channel columns reuse payment.method.* and orders.channel.*)
  'report.export.date': 'วันที่ทำการ',
  'report.export.orders': 'จำนวนออเดอร์',
  'report.export.revenue': 'ยอดขาย (บาท)',
  'report.export.avgTicket': 'เฉลี่ยต่อออเดอร์ (บาท)',
  'report.export.commission': 'ค่าคอมมิชชันแพลตฟอร์ม (บาท)',
  'report.export.total': 'รวม',
  'report.export.itemName': 'เมนู',
  'report.export.itemUnits': 'จำนวนที่ขาย',
  'report.export.itemRevenue': 'ยอดขาย (บาท)',
  'report.export.itemShare': 'สัดส่วนจำนวน (%)',
  // Overview screen: states
  'dash.loading': 'กำลังโหลดรายงาน…',
  'dash.error': 'โหลดรายงานไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
  'dash.empty': 'ยังไม่มียอดขายในช่วงนี้',
  'dash.excluded': 'ไม่รวม {count} ออเดอร์ในตัวเลข เพราะยอดคืนเงินมากกว่ายอดที่ชำระ โปรดตรวจสอบข้อมูลออเดอร์',
  'dash.live': 'ตัวเลขจริงจากออเดอร์ที่ชำระเงินและยืนยันแล้ว หักคืนเงินแล้ว',
  // Overview screen: comparison with the period before
  'dash.vs.today': 'จากเมื่อวาน {value}',
  'dash.vs.week': 'จากสัปดาห์ก่อน {value}',
  'dash.vs.month': 'จากเดือนก่อน {value}',
  'dash.vs.year': 'จากปีก่อน {value}',
  'dash.vs.none': 'ยังไม่มีข้อมูลช่วงก่อนหน้า',
  'dash.delta.up': 'เพิ่มขึ้น {value}',
  'dash.delta.down': 'ลดลง {value}',
  'dash.delta.flat': 'เท่าเดิม',
  // Overview screen: channels
  'dash.channels.summary': 'สัดส่วนช่องทางขาย: {parts}',
  'dash.channels.part': '{name} {percent}%',
  'dash.table.show': 'ดูเป็นตาราง',
  'dash.table.channel': 'ช่องทาง',
  'dash.table.amount': 'ยอดขาย',
  'dash.table.share': 'สัดส่วน',
  // Overview screen: items
  'dash.items.bottom': 'เมนูขายน้อยที่สุด',
  'dash.items.none': 'ยังไม่มีเมนูที่ขายได้ในช่วงนี้',
  'dash.items.unit': '{count} ที่',
  // Overview screen: weekday x hour grid
  'dash.heat.title': 'ช่วงเวลาที่ลูกค้าสั่ง',
  'dash.heat.hint': 'จำนวนออเดอร์ตามวันทำการและชั่วโมงที่สั่ง',
  'dash.heat.cell': '{day} {hour}:00 น. · {count} ใบ',
  'dash.heat.less': 'น้อย',
  'dash.heat.more': 'มาก',
  'dash.heat.alt': 'ตารางจำนวนออเดอร์ตามวันในสัปดาห์และชั่วโมง คึกคักที่สุดคือ {day} {hour}:00 น. {count} ใบ',
  // Overview screen: customers (owner only)
  'dash.customers.title': 'ลูกค้า',
  'dash.customers.ownerOnly': 'เห็นเฉพาะเจ้าของร้าน',
  'dash.customers.new': 'ใหม่',
  'dash.customers.regular': 'ประจำ',
  'dash.customers.lapsed': 'หายไป',
  'dash.customers.rule': 'หายไป = ไม่สั่งเกิน 30 วัน · ประจำ = สั่งตั้งแต่ 2 ครั้ง',
  'dash.customers.col.name': 'ลูกค้า',
  'dash.customers.col.segment': 'กลุ่ม',
  'dash.customers.col.orders': 'ครั้ง',
  'dash.customers.col.spent': 'ใช้จ่ายรวม',
  'dash.customers.col.favourites': 'เมนูโปรด',
  'dash.customers.noName': 'ลูกค้า LINE (ไม่ระบุชื่อ)',
  'dash.customers.none': 'ยังไม่มีลูกค้า',
  // Overview screen: waiting list
  'dash.pending.none': 'ไม่มีออเดอร์ค้างชำระ',
  'dash.pending.unpaidDetail': '{amount} · {status}',
  // Overview screen: export
  'dash.export.revenue': 'ยอดขาย (CSV)',
  'dash.export.items': 'เมนู (CSV)',
  'dash.export.done': 'บันทึกไฟล์ {name} แล้ว',
  'dash.export.failed': 'ส่งออกไม่สำเร็จ ลองใหม่อีกครั้ง',
  // Tax estimate (P7, D-34): the notes an estimate can carry (keys are `TAX_NOTE_KEYS` in @sds/shared)
  'tax.disclaimer':
    'ตัวเลขนี้เป็นประมาณการเพื่อวางแผน ไม่ใช่การยื่นแบบหรือคำแนะนำทางภาษี สถานะ: ข้อเสนอ ยังไม่ได้ยืนยันกับกรมสรรพากร ใช้กฎของปีภาษี {year}',
  'tax.status.proposed': 'ข้อเสนอ — โปรดยืนยันกับกรมสรรพากร',
  'tax.note.pnlIncomplete':
    'งบกำไรขาดทุนยังไม่ครบ (มีออเดอร์ที่ไม่มีต้นทุน หรือยังไม่ได้ตั้งอัตราคอมมิชชัน) ค่าใช้จ่ายอาจต่ำกว่าจริง ภาษีที่ประมาณจึงอาจสูงเกินจริง',
  'tax.note.foodCostCostOfGoodsUsed':
    'มีทั้งต้นทุนต่อจานจากเมนูและรายจ่ายหมวด "วัตถุดิบ" ระบบหักเฉพาะรายการที่มากกว่า คือต้นทุนต่อจานจากเมนู (ไม่หักวัตถุดิบซ้ำ) ตรวจว่าตรงกับหลักฐานที่มี',
  'tax.note.foodCostIngredientsUsed':
    'มีทั้งต้นทุนต่อจานจากเมนูและรายจ่ายหมวด "วัตถุดิบ" ระบบหักเฉพาะรายการที่มากกว่า คือรายจ่ายหมวดวัตถุดิบ (ไม่หักต้นทุนต่อจานซ้ำ) ตรวจว่าตรงกับหลักฐานที่มี',
  'tax.note.platformFeesCommissionUsed':
    'มีทั้งค่าคอมมิชชันแพลตฟอร์มและรายจ่ายหมวด "ค่าธรรมเนียมแพลตฟอร์ม" ระบบหักเฉพาะรายการที่มากกว่า คือค่าคอมมิชชัน (ไม่หักรายจ่ายหมวดค่าธรรมเนียมซ้ำ)',
  'tax.note.platformFeesExpensesUsed':
    'มีทั้งค่าคอมมิชชันแพลตฟอร์มและรายจ่ายหมวด "ค่าธรรมเนียมแพลตฟอร์ม" ระบบหักเฉพาะรายการที่มากกว่า คือรายจ่ายหมวดค่าธรรมเนียม (ไม่หักค่าคอมมิชชันซ้ำ)',
  'tax.note.costOfGoodsEstimated': 'ต้นทุนสินค้ามาจากต้นทุนที่เจ้าของประมาณไว้ในเมนู ไม่ใช่ใบเสร็จจริง',
  'tax.note.expensesNeedRecords':
    'การหักค่าใช้จ่ายตามจริงต้องมีหลักฐาน (ใบเสร็จ ใบสำคัญจ่าย) และต้องเป็นค่าใช้จ่ายที่จำเป็นและสมควร',
  'tax.note.allowancesUnchecked': 'ค่าลดหย่อนที่กรอกเพิ่มไม่ได้ตรวจเพดานหรือสิทธิ์ โปรดตรวจกับกรมสรรพากร',
  'tax.note.halfYearAllowancesHalved':
    'ใน ภ.ง.ด.94 ใช้ค่าลดหย่อนได้กึ่งหนึ่ง ระบบหารสองให้ทุกรายการ แต่บางรายการ (เช่น ดอกเบี้ยบ้าน เบี้ยประกันชีวิต) นับตามที่จ่ายจริงเดือนม.ค.–มิ.ย. ซึ่งยังไม่ได้ตรวจ',
  'tax.note.halfPercentThresholdSources':
    'วิธีที่ 2 (0.5% ของเงินได้): หน้าเว็บกรมสรรพากรให้เกณฑ์ไม่ตรงกัน (60,000 และ 120,000 บาท) ระบบใช้ตามคำแนะนำการกรอกแบบปัจจุบัน (120,000 บาท) ผลเหมือนกันทั้งสองเกณฑ์ เพราะวิธีนี้มีผลเมื่อเงินได้เกิน 1,000,000 บาทเท่านั้น',
  'tax.note.halfPercentNotApplied':
    'วิธีที่ 2 (0.5% ของเงินได้) อาจมีผล แต่เกณฑ์ของกรมสรรพากรยังไม่ชัด ระบบจึงไม่นำมาคิดในยอดภาษี',
  'tax.note.yearNotFinished': 'ปีภาษียังไม่จบ ตัวเลขนับถึงวันที่ในผลลัพธ์เท่านั้น',
  'tax.note.halfYearCredit': 'ภาษีที่ชำระไว้ด้วย ภ.ง.ด.94 นำไปหักในการคำนวณ ภ.ง.ด.90 ได้ ระบบยังไม่ได้คิดส่วนนี้',
  'tax.note.filingLate':
    'พ้นกำหนดยื่นแล้ว หากยังไม่ได้ยื่นจะมีเงินเพิ่ม 1.5% ต่อเดือนของภาษี และค่าปรับไม่เกิน 2,000 บาท โปรดสอบถามกรมสรรพากร',
} as const;
