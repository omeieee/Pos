import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import type { SlipProgressPhase } from '../model/slip-progress.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { SlipProgressPopup } from './OrderScreen.tsx';

function render(phase: SlipProgressPhase, locale: 'th' | 'en' = 'th', slowHint = false) {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale, go: () => {} }}>
      <SlipProgressPopup phase={phase} orderNo="A-001" slowHint={slowHint} onClose={() => {}} />
    </Ctx.Provider>,
  );
}

describe('SlipProgressPopup', () => {
  test('checking: a modal dialog with a moving bar and a close button', () => {
    const html = render('checking');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="slip-progress-title"');
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('กำลังตรวจสอบสลิป…');
    expect(html).toContain('ปิด');
  });

  test('paid: the existing success wording and the order number', () => {
    const html = render('paid');
    expect(html).toContain('ชำระเงินสำเร็จ ✓');
    expect(html).toContain('ร้านได้รับเงินแล้ว');
    expect(html).toContain('A-001');
    expect(html).not.toContain('role="progressbar"');
  });

  test('staff_review: neutral wording, closable, no failure or reason words', () => {
    const html = render('staff_review');
    expect(html).toContain('ได้รับสลิปแล้ว ร้านกำลังตรวจสอบ');
    expect(html).toContain('ปิด');
    expect(html).not.toContain('role="progressbar"');
    for (const word of ['ไม่สำเร็จ', 'ไม่ผ่าน', 'ปลอม', 'ผิดพลาด', 'ยอดไม่ตรง', 'ซ้ำ']) {
      expect(html).not.toContain(word);
    }
  });

  test('amount_mismatch names the one failure; waiting says the shop is confirming', () => {
    const mismatch = render('amount_mismatch');
    expect(mismatch).toContain('ยอดเงินไม่ตรง');
    expect(mismatch).not.toContain('ชำระเงินสำเร็จ');
    expect(mismatch).not.toContain('role="progressbar"');
    const waiting = render('verified_waiting');
    expect(waiting).toContain('สลิปถูกต้อง ร้านกำลังยืนยัน');
    expect(waiting).not.toContain('ชำระเงินสำเร็จ');
    expect(render('amount_mismatch', 'en')).toContain('Amount does not match');
    expect(render('verified_waiting', 'en')).toContain('Slip is valid');
  });

  test('slow hint: absent by default, shown in both languages when asked, only while checking', () => {
    const slow = 'บางธนาคารอัปเดตช้า การตรวจอาจใช้เวลาประมาณ 1 นาที ปิดหน้านี้ได้ ระบบจะยืนยันให้เอง';
    expect(render('checking')).not.toContain(slow);
    const html = render('checking', 'th', true);
    expect(html).toContain(slow);
    expect(html).toContain('aria-live="polite"');
    expect(render('checking', 'en', true)).toContain('this can take about a minute');
    expect(render('paid', 'th', true)).not.toContain(slow);
    expect(render('staff_review', 'th', true)).not.toContain(slow);
  });

  test('english text exists for every phase', () => {
    expect(render('checking', 'en')).toContain('Checking your slip…');
    expect(render('paid', 'en')).toContain('Payment successful');
    expect(render('staff_review', 'en')).toContain('Slip received. The shop is checking it.');
  });
});
