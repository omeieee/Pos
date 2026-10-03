import { describe, expect, test } from 'vitest';
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

  test('chat bar text is at most 14 characters', () => {
    expect(() =>
      loadRichMenu({ ...DEFAULT_RICH_MENU, chatBarText: 'x'.repeat(15) }, { liffUrl: LIFF }),
    ).toThrow();
  });
});
