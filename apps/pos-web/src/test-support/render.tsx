/**
 * Rendering helpers for component tests (jsdom + Testing Library). A screen gets the real cart,
 * payment and entity stores and a fake API, so the tests exercise the same code paths as the app.
 *
 * Signing in: `createTestAuth(role)` builds the REAL auth store (with the shared permissions of
 * that role and a step-up that accepts the PIN `STEP_UP_PIN`) and signs it in. Pass it to
 * `createTestServices({ auth })`; `renderScreen` then provides it to the screen and mounts the
 * step-up dialog next to it, as App does.
 */
import type { Locale } from '@sds/i18n';
import { DEFAULT_DELIVERY_SETTINGS, ROLE_PERMISSIONS, type StaffRole } from '@sds/shared';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { ApiClient, createApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { type AuthStore, createAuthStore } from '../auth/auth-store.ts';
import { createActivity } from '../lib/activity.ts';
import { createStore } from '../lib/store.ts';
import { createMenuEditorStore } from '../menu-editor/menu-editor-store.ts';
import type { PhotoEngine } from '../menu-editor/photo-plan.ts';
import { createMemoryLocalStore, type LocalStore } from '../platform/localStore.ts';
import { createSound } from '../platform/sound.ts';
import { createMemoryTokenStore } from '../platform/tokenStore.ts';
import { createCartStore } from '../pos/cart-store.ts';
import type { CatalogueState } from '../pos/catalogue-cache.ts';
import { PROMPTPAY_CACHE_KEY, type SavedPromptpay } from '../pos/offline-promptpay-model.ts';
import { createOrderMovesStore } from '../pos/order-moves-store.ts';
import { createOutboxStore } from '../pos/outbox-store.ts';
import { createPaymentStore } from '../pos/payment-store.ts';
import { createPromptpayCache } from '../pos/promptpay-cache.ts';
import { createRecipientStore } from '../pos/recipient-store.ts';
import type { ConnectionState } from '../realtime/connection.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import type { Services } from '../services.ts';
import { createAdminStore } from '../settings/admin-store.ts';
import { createSettingsStore } from '../settings/settings-store.ts';
import { AuthContext, LocaleContext, ServicesContext } from '../ui/hooks.ts';
import { StepUpDialog } from '../ui/StepUpDialog.tsx';
import { createFakeEngine, createFakePrefs, createFakeWakeLock } from './fake-audio.ts';
import { createFakeLifecycle } from './fake-realtime.ts';
import { FAKE_DEVICE_TOKEN, IDS, sessionBody } from './fixtures.ts';
import { deliveryFrame } from './frames.ts';
import { cleanEngine, createFakeMenuApi } from './menu-editor-env.ts';
import { seedMenu } from './menu-fixtures.ts';
import {
  createFakeAdminApi,
  createFakeSettingsApi,
  type SettingsOverrides,
} from './settings-env.ts';

/** The PIN the fake step-up accepts. */
export const STEP_UP_PIN = '4321';

/** A signed-in auth store for a role, over a fake auth API. */
export async function createTestAuth(role: StaffRole = 'cashier') {
  const tokens = createMemoryTokenStore();
  await tokens.saveDevice({
    device: { id: IDS.device, name: 'iPad ตัวอย่าง', kind: 'ipad' },
    deviceToken: FAKE_DEVICE_TOKEN,
  });
  const stepUp = vi.fn(async ({ pin }: { pin: string }) => {
    if (pin !== STEP_UP_PIN) throw new ApiClientError('INVALID_CREDENTIALS', { status: 401 });
    return { stepUpUntil: new Date(Date.now() + 5 * 60_000).toISOString() };
  });
  // The owner's step-up (password plus a code): the fake accepts any factors.
  const stepUpOwner = vi.fn(async () => ({
    stepUpUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
  }));
  const api = {
    auth: {
      listStaff: async () => ({ staff: [] }),
      pinLogin: async () => ({
        ...sessionBody(role === 'owner' ? 'owner' : 'cashier'),
        staff: {
          id: role === 'owner' ? IDS.owner : IDS.cashier,
          displayName: 'พนักงานตัวอย่าง',
          role,
        },
        permissions: [...ROLE_PERMISSIONS[role]],
      }),
      stepUpStaff: stepUp,
      stepUpOwner,
      logout: async () => undefined,
    },
  } as unknown as ReturnType<typeof createApiClient>;
  const auth = createAuthStore({ api, tokens });
  await auth.boot();
  const result = await auth.signInWithPin(IDS.cashier, '1234');
  if (!result.ok) throw new Error('the test sign-in failed');
  return { auth, stepUp, stepUpOwner };
}

type Orders = ApiClient['orders'];
type Payments = ApiClient['payments'];

const unexpected = (name: string) => async () => {
  throw new Error(`${name} was not expected`);
};

export interface TestPromptpay {
  record?: SavedPromptpay;
  fetch?: () => ReturnType<ApiClient['settings']['promptpay']>;
}

/** An API whose every call fails the test unless the test gave it an answer. */
export function createFakeApi(
  overrides: {
    orders?: Partial<Orders>;
    payments?: Partial<Payments>;
    recipients?: Partial<ApiClient['recipients']>;
    settings?: Partial<ApiClient['settings']>;
    devices?: Partial<ApiClient['devices']>;
  } = {},
) {
  const orders = {
    create: vi.fn<Orders['create']>(overrides.orders?.create ?? unexpected('orders.create')),
    get: vi.fn<Orders['get']>(overrides.orders?.get ?? unexpected('orders.get')),
    list: vi.fn<Orders['list']>(overrides.orders?.list ?? unexpected('orders.list')),
    patch: vi.fn<Orders['patch']>(overrides.orders?.patch ?? unexpected('orders.patch')),
    transition: vi.fn<Orders['transition']>(
      overrides.orders?.transition ?? unexpected('orders.transition'),
    ),
    cancel: vi.fn<Orders['cancel']>(overrides.orders?.cancel ?? unexpected('orders.cancel')),
    correct: vi.fn<Orders['correct']>(overrides.orders?.correct ?? unexpected('orders.correct')),
    void: vi.fn<Orders['void']>(overrides.orders?.void ?? unexpected('orders.void')),
    receipt: vi.fn<Orders['receipt']>(overrides.orders?.receipt ?? unexpected('orders.receipt')),
  };
  const payments = {
    create: vi.fn<Payments['create']>(overrides.payments?.create ?? unexpected('payments.create')),
    list: vi.fn<Payments['list']>(overrides.payments?.list ?? (async () => ({ payments: [] }))),
    claim: vi.fn<Payments['claim']>(overrides.payments?.claim ?? unexpected('payments.claim')),
    confirm: vi.fn<Payments['confirm']>(
      overrides.payments?.confirm ?? unexpected('payments.confirm'),
    ),
    cancelClaimed: vi.fn<Payments['cancelClaimed']>(
      overrides.payments?.cancelClaimed ?? unexpected('payments.cancelClaimed'),
    ),
    void: vi.fn<Payments['void']>(overrides.payments?.void ?? unexpected('payments.void')),
    refund: vi.fn<Payments['refund']>(overrides.payments?.refund ?? unexpected('payments.refund')),
    changeMethod: vi.fn<Payments['changeMethod']>(
      overrides.payments?.changeMethod ?? unexpected('payments.changeMethod'),
    ),
    qrUrl: vi.fn<Payments['qrUrl']>(overrides.payments?.qrUrl ?? unexpected('payments.qrUrl')),
    slip: vi.fn<Payments['slip']>(overrides.payments?.slip ?? unexpected('payments.slip')),
  };
  // The keepalive of a kitchen display calls this; it answers like a live session.
  const auth = { me: vi.fn(async () => ({}) as never) };
  // The order screen reads these when it opens: by default nobody is remembered and the shared
  // default buildings are on offer.
  const recipients = {
    list: vi.fn<ApiClient['recipients']['list']>(
      overrides.recipients?.list ?? (async () => ({ recipients: [] })),
    ),
  };
  const settings = {
    delivery: vi.fn<ApiClient['settings']['delivery']>(
      overrides.settings?.delivery ??
        (async () => ({
          value: DEFAULT_DELIVERY_SETTINGS,
          version: 0,
          rev: 0,
          updatedAt: null,
        })),
    ),
  };
  // The owner's take-over reports here (default: the server accepts it).
  const devices = {
    outboxRecovery: vi.fn<ApiClient['devices']['outboxRecovery']>(
      overrides.devices?.outboxRecovery ??
        (async (deviceId, input, options) => ({
          result: { deviceId, ...input },
          replay: false,
          clientRequestId: options?.clientRequestId ?? '',
        })),
    ),
  };
  return { orders, payments, auth, recipients, settings, devices };
}

export function createTestServices(
  options: {
    menu?: boolean;
    connection?: Partial<ConnectionState>;
    create?: ApiClient['orders']['create'];
    getOrder?: ApiClient['orders']['get'];
    orders?: Partial<Orders>;
    payments?: Partial<Payments>;
    /** What the owner's take-over reports to (default: the server accepts it). */
    devices?: Partial<ApiClient['devices']>;
    /** What the order screen's chips read (default: nobody remembered). */
    recipients?: Partial<ApiClient['recipients']>;
    /** Put the delivery buildings in the store as the feed would (default: the shared list). */
    buildings?: boolean;
    /** Signed-in auth from `createTestAuth`. Without one, screens that need a person cannot render. */
    auth?: AuthStore;
    /** The carts save to the outbox when the device is offline or gets no answer (default: no). */
    queue?: boolean;
    /** The device starts offline. */
    offline?: boolean;
    /** The local store behind the outbox; default a persistent in-memory one. */
    localStore?: LocalStore;
    /** The saved-menu notice's state (default: the menu did not come from a saved copy). */
    catalogue?: Partial<CatalogueState>;
    /**
     * The PromptPay ID saved on the device (D-20). `record` is already on the device when the app
     * starts (default: nothing saved); `fetch` answers the refresh the app makes (default: no
     * connection, so nothing changes).
     */
    promptpay?: TestPromptpay;
    /** What the menu editor's calls answer (every other call fails the test). */
    menuApi?: Partial<ApiClient['menu']>;
    /** What the settings screens' calls answer (every other call fails the test). */
    settingsApi?: SettingsOverrides;
    /** What the devices and staff screens' calls answer (every other call fails the test). */
    adminApi?: Partial<ApiClient['admin']>;
    /** The browser's picture engine for a menu photo (default: one that returns a clean WebP). */
    photoEngine?: PhotoEngine;
  } = {},
) {
  const entities = createEntityStore();
  if (options.menu !== false) seedMenu(entities);
  if (options.buildings !== false) entities.apply(deliveryFrame(1));
  const activity = createActivity();
  const api = createFakeApi({
    ...(options.recipients ? { recipients: options.recipients } : {}),
    orders: {
      ...(options.create ? { create: options.create } : {}),
      ...(options.getOrder ? { get: options.getOrder } : {}),
      ...options.orders,
    },
    payments: options.payments ?? {},
    ...(options.devices ? { devices: options.devices } : {}),
  });
  const create = api.orders.create;
  const getOrder = api.orders.get;
  const life = createFakeLifecycle({ online: !options.offline });
  const connection = createStore<ConnectionState>({
    status: 'online',
    synced: true,
    ...options.connection,
  });
  const localStore = options.localStore ?? { ...createMemoryLocalStore(), persistent: true };
  const outbox = createOutboxStore({
    api,
    entities,
    auth:
      options.auth ??
      createStore({
        phase: 'signedIn' as const,
        session: { staff: { id: IDS.cashier } },
        device: { id: IDS.device },
      }),
    lifecycle: life.lifecycle,
    connection,
    localStore: async () => localStore,
  });
  const unbindOutbox = outbox.bind();
  if (options.promptpay?.record) {
    void localStore.kv.set(PROMPTPAY_CACHE_KEY, options.promptpay.record);
  }
  const promptpayApi = {
    settings: {
      promptpay: vi.fn<ApiClient['settings']['promptpay']>(
        options.promptpay?.fetch ??
          (async () => {
            throw new ApiClientError('NETWORK');
          }),
      ),
    },
  };
  const promptpay = createPromptpayCache({
    api: promptpayApi,
    entities,
    auth:
      options.auth ??
      createStore({
        phase: 'signedIn' as const,
        session: { staff: { id: IDS.cashier }, permissions: [...ROLE_PERMISSIONS.cashier] },
        device: { id: IDS.device },
      }),
    connection,
    lifecycle: life.lifecycle,
    localStore: async () => localStore,
  });
  const unbindPromptpay = promptpay.bind();
  const queueDeps = options.queue ? { outbox } : {};
  const cart = createCartStore({ api: { orders: { create } }, entities, activity, ...queueDeps });
  const platformCart = createCartStore({
    api: { orders: { create } },
    entities,
    activity,
    mode: 'platform',
    ...queueDeps,
  });
  const recipients = createRecipientStore({ api, entities });
  const payments = createPaymentStore({
    api,
    entities,
    activity,
    auth: options.auth ?? {
      runSensitive: async (call) => ({ ok: true as const, value: await call() }),
    },
  });
  const orderMoves = createOrderMovesStore({ api, entities });
  const menuApi = createFakeMenuApi(options.menuApi);
  const menuEditor = createMenuEditorStore({
    api: { menu: menuApi as unknown as ApiClient['menu'] },
    entities,
    lifecycle: life.lifecycle,
    canSeeCosts: () =>
      options.auth?.getState().session?.permissions.includes('report.view') ?? false,
    photoEngine: options.photoEngine ?? cleanEngine(),
  });
  const settingsApi = createFakeSettingsApi(options.settingsApi);
  const settingsEditor = createSettingsStore({
    api: { settings: settingsApi as unknown as ApiClient['settings'] },
    lifecycle: life.lifecycle,
    auth: options.auth ?? {
      runSensitive: async (call) => ({ ok: true as const, value: await call() }),
    },
  });
  const adminApi = createFakeAdminApi(options.adminApi);
  const adminEditor = createAdminStore({
    api: { admin: adminApi as unknown as ApiClient['admin'] },
    lifecycle: life.lifecycle,
    auth: options.auth ?? {
      runSensitive: async (call) => ({ ok: true as const, value: await call() }),
    },
  });
  // The sound and the wake lock run on doubles: the engine starts only on unlock, like iOS.
  const audio = createFakeEngine();
  const soundPrefs = createFakePrefs();
  const sound = createSound({
    engine: audio.engine,
    prefs: soundPrefs.prefs,
    lifecycle: life.lifecycle,
  });
  const wake = createFakeWakeLock();
  // The clipboard double: copies succeed unless a test says the browser refused.
  const clipboard = { copyText: vi.fn(async (_text: string) => true) };
  const files = { save: vi.fn(), print: vi.fn() };
  const catalogue = createStore<CatalogueState>({
    fromCache: false,
    savedAt: null,
    ...options.catalogue,
  });
  const services = {
    api,
    entities,
    catalogue,
    activity,
    cart,
    platformCart,
    outbox,
    promptpay,
    recipients,
    payments,
    orderMoves,
    menuEditor,
    settingsEditor,
    adminEditor,
    sound,
    wakeLock: wake.wakeLock,
    clipboard,
    files,
    lifecycle: life.lifecycle,
    ...(options.auth ? { auth: options.auth } : {}),
    connection: { ...connection, start: vi.fn(), stop: vi.fn() },
  } as unknown as Services;
  return {
    services,
    entities,
    catalogue,
    cart,
    platformCart,
    outbox,
    unbindOutbox,
    promptpay,
    promptpayApi,
    unbindPromptpay,
    localStore,
    recipients,
    payments,
    orderMoves,
    menuEditor,
    menuApi,
    settingsEditor,
    settingsApi,
    adminEditor,
    adminApi,
    sound,
    audio,
    soundPrefs,
    wake,
    clipboard,
    files,
    life,
    activity,
    api,
    create,
    getOrder,
    connection,
  };
}

export function renderScreen(
  ui: ReactElement,
  services: Services,
  locale: Locale = 'th',
): ReturnType<typeof render> {
  const { auth } = services;
  return render(
    <LocaleContext.Provider value={locale}>
      <ServicesContext.Provider value={services}>
        {auth ? (
          <AuthContext.Provider value={auth}>
            {ui}
            <StepUpDialog />
          </AuthContext.Provider>
        ) : (
          ui
        )}
      </ServicesContext.Provider>
    </LocaleContext.Provider>,
  );
}
