import { catalogs } from '@sds/i18n';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { LocaleContext } from './hooks.ts';
import { UpdateBannerView } from './UpdateBanner.tsx';

const render = (needRefresh: boolean, locale: 'th' | 'en' = 'th') =>
  renderToString(
    <LocaleContext.Provider value={locale}>
      <UpdateBannerView needRefresh={needRefresh} onApply={() => undefined} />
    </LocaleContext.Provider>,
  );

describe('the app update banner', () => {
  test('shows nothing while the app is up to date', () => {
    expect(render(false)).toBe('');
  });

  test('says a new version is ready and offers to update now, in both languages', () => {
    const page = render(true);
    expect(page).toContain(catalogs.th['app.update.ready']);
    expect(page).toContain(catalogs.th['app.update.apply']);
    expect(page).toContain('<button');
    expect(render(true, 'en')).toContain(catalogs.en['app.update.apply']);
  });
});
