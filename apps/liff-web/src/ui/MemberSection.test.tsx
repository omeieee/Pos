import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import { EMPTY_MEMBER_FORM } from '../model/member.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { MemberSection } from './MemberSection.tsx';

function render(value = EMPTY_MEMBER_FORM, showErrors = false, locale: 'th' | 'en' = 'th') {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale, go: () => {} }}>
      <MemberSection value={value} onChange={() => {}} showErrors={showErrors} />
    </Ctx.Provider>,
  );
}

describe('MemberSection', () => {
  test('has the four optional fields, none required, Thai first', () => {
    const html = render();
    for (const label of ['ชื่อ-นามสกุล', 'ชื่อเล่น', 'เบอร์โทร']) expect(html).toContain(label);
    expect(html.match(/<input/g)).toHaveLength(4);
    expect(html).not.toContain('required');
    expect(html).toContain('type="tel"');
    expect(html).toContain('ไม่บังคับ');
  });

  test('shows the saved values and the privacy notice behind the link', () => {
    const html = render({ fullName: 'สมชาย', nickname: 'ชาย', building: 'A', phone: '0812345678' });
    expect(html).toContain('value="0812345678"');
    expect(html).toContain('อ่านประกาศความเป็นส่วนตัว');
    expect(html).toContain('ร้านเก็บรหัสผู้ใช้ LINE');
  });

  test('a bad phone is flagged only after the first try to order', () => {
    const bad = { ...EMPTY_MEMBER_FORM, phone: '123' };
    expect(render(bad, false)).not.toContain('aria-invalid');
    const html = render(bad, true);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('เบอร์โทรไม่ถูกต้อง');
  });

  test('English', () => {
    expect(render(EMPTY_MEMBER_FORM, false, 'en')).toContain('Member details (optional)');
  });
});
