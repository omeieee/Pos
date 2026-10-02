import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const orderEntry = read('order-entry.css');
const base = read('styles.css');
const pos = read('pos.css');
const orders = read('orders.css');
const payment = read('payment.css');

/** The icon rules carry SVG data URIs; everything else must be plain CSS. */
const withoutIcons = (css: string) => css.replace(/url\("data:[^"]*"\)/g, 'url()');

describe('the order screens follow the design tokens and the touch rules', () => {
  test('no colour is typed into the stylesheets', () => {
    for (const css of [orderEntry, pos, orders, payment].map(withoutIcons)) {
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    }
  });

  test('nothing depends on hover: every control works by touch alone', () => {
    expect(orderEntry).not.toContain(':hover');
    expect(pos).not.toContain(':hover');
    expect(orders).not.toContain(':hover');
    expect(payment).not.toContain(':hover');
  });

  test('an order card and a payment method tile are tap targets of at least 44 px', () => {
    expect(orders).toMatch(/\.ocard\s*{[^}]*var\(--tap\)/);
    expect(payment).toMatch(/\.method\s*{[^}]*var\(--tap\)/);
    expect(payment).toMatch(/\.change\s*{[^}]*var\(--tap\)/);
  });

  test('the cash keypad keys use the comfortable touch size', () => {
    expect(payment).toMatch(/\.keypad__key\s*{[^}]*var\(--sds-touch-comfortable\)/);
  });

  test('text fields are at least 16 px, so iOS Safari does not zoom the page on focus', () => {
    expect(base).toMatch(/\.input\s*{[^}]*font-size:\s*max\(16px/);
  });

  test('tap targets are at least 44 px: the tap floor is applied to the controls', () => {
    expect(base).toMatch(/--tap:\s*max\(44px/);
    for (const selector of ['.cat', '.pick', '.seg__item', '.line__main', '.stepper .btn']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(orderEntry, selector).toMatch(new RegExp(`${escaped}\\s*{[^}]*var\\(--tap\\)`));
    }
  });

  test('the phone layout respects the safe area at the bottom', () => {
    expect(orderEntry).toContain('var(--safe-bottom)');
  });

  test('a long press on a dish does not select text or open the iOS callout', () => {
    expect(orderEntry).toContain('-webkit-touch-callout: none');
  });

  test('the page has no 300 ms tap delay', () => {
    expect(base).toContain('touch-action: manipulation');
  });
});
