import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parsePostback } from './postback.ts';
import { DEFAULT_RICH_MENU, loadRichMenu } from './richmenu.ts';
import { KEYWORDS } from './router.ts';

const LIFF = 'https://liff.example.test/app';

describe('rich menu', () => {
  test('every message button of the default menu is a keyword the router answers', () => {
    const keywords: string[] = Object.values(KEYWORDS);
    for (const area of DEFAULT_RICH_MENU.areas) {
      if (area.action.type === 'message') expect(keywords).toContain(area.action.text);
    }
  });

  test('the default loads, fills the app URL and has six areas', () => {
    const menu = loadRichMenu(DEFAULT_RICH_MENU, { liffUrl: LIFF });
    expect(menu.areas).toHaveLength(6);
    expect(menu.areas[0]?.action).toMatchObject({ type: 'uri', uri: LIFF });
    expect(JSON.stringify(menu)).not.toContain('{{');
  });

  test('rejects a wrong size, an area outside the image and a non-https link', () => {
    expect(() =>
      loadRichMenu({ ...DEFAULT_RICH_MENU, size: { width: 800, height: 600 } }, { liffUrl: LIFF }),
    ).toThrow();
    const outside = {
      ...DEFAULT_RICH_MENU,
      areas: [
        {
          bounds: { x: 2000, y: 0, width: 600, height: 100 },
          action: { type: 'message', text: 'x' },
        },
      ],
    };
    expect(() => loadRichMenu(outside, { liffUrl: LIFF })).toThrow();
    expect(() => loadRichMenu(DEFAULT_RICH_MENU, { liffUrl: 'http://x.test' })).toThrow();
  });

  test('the real design files load, fill {{LIFF_BASE_URL}}, and every postback is one the router answers', () => {
    for (const file of ['rich-menu-full.json', 'rich-menu-compact.json']) {
      const raw = JSON.parse(
        readFileSync(new URL(`../../../design/rich-menu/${file}`, import.meta.url), 'utf8'),
      ) as unknown;
      const menu = loadRichMenu(raw, { liffUrl: 'https://liff.line.me/1234567890-abcdefgh' });
      expect(JSON.stringify(menu)).not.toContain('{{');
      for (const area of menu.areas) {
        if (area.action.type === 'uri') {
          expect(area.action.uri).toMatch(
            /^https:\/\/liff\.line\.me\/1234567890-abcdefgh\/(menu|orders)$/,
          );
        }
        if (area.action.type === 'postback') {
          expect(parsePostback(area.action.data), area.action.data).not.toBeNull();
        }
      }
    }
  });

  test('chat bar text is at most 14 characters', () => {
    expect(() =>
      loadRichMenu({ ...DEFAULT_RICH_MENU, chatBarText: 'x'.repeat(15) }, { liffUrl: LIFF }),
    ).toThrow();
  });
});
