import type { MemberProfile } from '@sds/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import { EMPTY_MEMBER_FORM, type MemberForm } from '../model/member.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { MemberView } from './MemberScreen.tsx';

const base = {
  form: EMPTY_MEMBER_FORM as MemberForm | null,
  saved: { fullName: null, nickname: null, building: null, phone: null } as MemberProfile | null,
  busy: false,
  tried: false,
  done: false,
  error: null as string | null,
  onChange: () => {},
  onSave: () => {},
  onRetry: () => {},
  onBack: () => {},
};

function render(over: Partial<typeof base> = {}, locale: 'th' | 'en' = 'th') {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale, go: () => {} }}>
      <MemberView {...base} {...over} />
    </Ctx.Provider>,
  );
}

describe('MemberView', () => {
  test('titled ข้อมูลสมาชิก with the four fields, the privacy line and a disabled save', () => {
    const html = render();
    expect(html).toContain('ข้อมูลสมาชิก');
    expect(html.match(/<input/g)).toHaveLength(4);
    expect(html).toContain('อ่านประกาศความเป็นส่วนตัว');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>บันทึก/);
  });

  test('save is enabled once something changed', () => {
    const html = render({ form: { ...EMPTY_MEMBER_FORM, nickname: 'ชาย' } });
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>บันทึก/);
  });

  test('prefilled values, success message and a bad phone', () => {
    const saved = { fullName: 'สมชาย', nickname: null, building: null, phone: '0812345678' };
    const form = { fullName: 'สมชาย', nickname: '', building: '', phone: '0812345678' };
    const html = render({ form, saved, done: true });
    expect(html).toContain('value="0812345678"');
    expect(html).toContain('บันทึกข้อมูลสมาชิกแล้ว');
    const bad = render({ form: { ...form, phone: '123' }, saved, tried: true });
    expect(bad).toContain('เบอร์โทรไม่ถูกต้อง');
  });

  test('loading, load failure with retry, and English', () => {
    expect(render({ form: null })).toContain('กำลังโหลด');
    const failed = render({ form: null, error: 'เชื่อมต่อไม่ได้' });
    expect(failed).toContain('เชื่อมต่อไม่ได้');
    expect(failed).toContain('ลองใหม่');
    expect(render({}, 'en')).toContain('Member details');
  });
});
