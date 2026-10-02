/**
 * Rendering helpers for component tests (jsdom + Testing Library). A screen gets the real cart and
 * entity stores and a fake API, so the tests exercise the same code paths as the app.
 */
import type { Locale } from '@sds/i18n';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { createActivity } from '../lib/activity.ts';
import { createStore } from '../lib/store.ts';
import { createCartStore } from '../pos/cart-store.ts';
import type { ConnectionState } from '../realtime/connection.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import type { Services } from '../services.ts';
import { LocaleContext, ServicesContext } from '../ui/hooks.ts';
import { seedMenu } from './menu-fixtures.ts';

export function createTestServices(
  options: {
    menu?: boolean;
    connection?: Partial<ConnectionState>;
    create?: ApiClient['orders']['create'];
    getOrder?: ApiClient['orders']['get'];
  } = {},
) {
  const entities = createEntityStore();
  if (options.menu !== false) seedMenu(entities);
  const activity = createActivity();
  const create = vi.fn<ApiClient['orders']['create']>(
    options.create ??
      (async () => {
        throw new Error('create was not expected');
      }),
  );
  const getOrder = vi.fn<ApiClient['orders']['get']>(
    options.getOrder ??
      (async () => {
        throw new Error('get was not expected');
      }),
  );
  const cart = createCartStore({ api: { orders: { create } }, entities, activity });
  const connection = createStore<ConnectionState>({
    status: 'online',
    synced: true,
    ...options.connection,
  });
  const services = {
    api: { orders: { create, get: getOrder } },
    entities,
    activity,
    cart,
    connection: { ...connection, start: vi.fn(), stop: vi.fn() },
  } as unknown as Services;
  return { services, entities, cart, activity, create, getOrder, connection };
}

export function renderScreen(
  ui: ReactElement,
  services: Services,
  locale: Locale = 'th',
): ReturnType<typeof render> {
  return render(
    <LocaleContext.Provider value={locale}>
      <ServicesContext.Provider value={services}>{ui}</ServicesContext.Provider>
    </LocaleContext.Provider>,
  );
}
