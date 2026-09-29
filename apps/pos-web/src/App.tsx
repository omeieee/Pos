import { translator } from '@sds/i18n';
import { useEffect, useState } from 'react';
import { apiUrl } from './platform/config.ts';

const tr = translator('th');

/** Shop name (a brand, not a translatable message). */
const APP_NAME = 'แซ่บโดนเส้น POS';

type Health = { state: 'loading' } | { state: 'ok'; version: string } | { state: 'error' };

export function App() {
  const [health, setHealth] = useState<Health>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl('/healthz'), { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { version?: unknown };
        setHealth({ state: 'ok', version: String(body.version ?? '') });
      })
      .catch(() => {
        if (!controller.signal.aborted) setHealth({ state: 'error' });
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>
        API:{' '}
        {health.state === 'loading'
          ? tr('common.loading')
          : health.state === 'ok'
            ? `ok (${health.version})`
            : tr('common.error')}
      </p>
    </main>
  );
}
