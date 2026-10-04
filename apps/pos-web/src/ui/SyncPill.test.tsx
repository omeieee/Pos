import { catalogs } from '@sds/i18n';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { LocaleContext } from './hooks.ts';
import { SyncPillView } from './SyncPill.tsx';

const th = catalogs.th;
const en = catalogs.en;

const render = (status: Parameters<typeof SyncPillView>[0]['status'], locale: 'th' | 'en' = 'th') =>
  renderToString(
    <LocaleContext.Provider value={locale}>
      <SyncPillView status={status} />
    </LocaleContext.Provider>,
  );

describe('the sync pill', () => {
  test('says online, reconnecting and offline in words, never by colour alone', () => {
    expect(render('online')).toContain(th['net.online']);
    expect(render('reconnecting')).toContain(th['net.reconnecting']);
    expect(render('connecting')).toContain(th['net.connecting']);
    expect(render('offline')).toContain(th['net.offline']);
  });

  test('is a polite live region so a screen reader hears the change', () => {
    const page = render('offline');
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-live="polite"');
  });

  test('carries the state as a class, for the colour and the icon', () => {
    expect(render('online')).toContain('net--online');
    expect(render('reconnecting')).toContain('net--reconnecting');
    expect(render('offline')).toContain('net--offline');
  });

  test('is translated', () => {
    expect(render('offline', 'en')).toContain(en['net.offline']);
  });

  test('shows nothing before sign-in starts the connection', () => {
    expect(render('idle')).toBe('');
  });
});
