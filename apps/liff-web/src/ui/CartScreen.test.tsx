import type { CheckoutInfo, PublicMenuResponse } from '@sds/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { Api } from '../api/client.ts';
import type { Platform } from '../platform/liff.ts';
import { Ctx } from './app-context.tsx';
import { CheckoutScreen } from './CartScreen.tsx';

const DISH = '0191a8f0-0000-7000-8000-000000000001';
const menu = {
  channel: 'line',
  categories: [
    {
      id: '0191a8f0-0000-7000-8000-000000000100',
      nameTh: 'หมวด',
      nameEn: null,
      items: [
        {
          id: DISH,
          nameTh: 'ก๋วยเตี๋ยว',
          nameEn: null,
          descriptionTh: null,
          descriptionEn: null,
          priceSatang: 5000,
          imageUrl: null,
          modifierGroups: [],
        },
      ],
    },
  ],
} as unknown as PublicMenuResponse;

const info = {
  delivery: { open: true, window: { openMinute: 780, closeMinute: 1380 } },
  buildings: ['A1'],
  methods: ['cash', 'promptpay'],
  lastRecipient: null,
  privacyAcknowledged: true,
  privacyVersion: 'v',
  promptpayConfigured: true,
} as CheckoutInfo;

function render() {
  return renderToStaticMarkup(
    <Ctx.Provider value={{ api: {} as Api, platform: {} as Platform, locale: 'th', go: () => {} }}>
      <CheckoutScreen
        menu={menu}
        info={info}
        cart={[{ key: 'k', menuItemId: DISH, qty: 1, optionIds: [], note: '' }]}
        setCart={() => {}}
        clearCart={() => {}}
        refreshInfo={async () => {}}
      />
    </Ctx.Provider>,
  );
}

describe('checkout without the member form', () => {
  const html = render();

  test('no member fields; only recipient name and note inputs remain', () => {
    expect(html).not.toContain('ชื่อเล่น');
    expect(html).not.toContain('เบอร์โทร');
    expect(html).not.toContain('ข้อมูลสมาชิก (ไม่บังคับ)');
    expect(html.match(/<input(?![^>]*type="radio")/g)).toHaveLength(2);
  });

  test('the payment choice is back: cash and PromptPay radios, PromptPay first', () => {
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.indexOf('พร้อมเพย์')).toBeLessThan(html.indexOf('เงินสดตอนรับของ'));
  });

  test('a small link leads to the member page', () => {
    expect(html).toContain('กรอกข้อมูลสมาชิก');
  });
});
