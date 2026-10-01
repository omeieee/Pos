/**
 * Auth state for the staff app: this device's registration, who is signed in, their role and
 * permissions, and whether a recent step-up is still valid. No React in here.
 *
 * What is held and where:
 * - The device token and the session token live in this module's closure only. They are not in
 *   `AuthState`, so a component cannot render, log or serialize them; only the API client reads
 *   them, through `deviceToken()` and `sessionToken()`.
 * - The device registration is stored through the platform tokenStore (long-lived). A PIN
 *   session is stored for the tab (an accidental reload does not ask for the PIN again). The
 *   owner's password session is memory only.
 * - Sign-out clears the session, the role, the step-up state and the stored session. It keeps
 *   the device registration: the device stays registered and shows the PIN screen. The device
 *   is forgotten only when the server says it is gone (DEVICE_UNREGISTERED).
 *
 * Step-up: the API keeps no separate grant token. A successful `POST /v1/auth/step-up` marks the
 * session as stepped-up until `stepUpUntil` (5 minutes), and the next sensitive call simply
 * carries the same bearer. `runSensitive` wraps such a call: it asks first when the local clock
 * says the step-up has lapsed (saving a round trip), and asks again once if the server answers
 * STEP_UP_REQUIRED anyway (clock skew, a revoked step-up).
 */
import type { Permission, RegisterDeviceResponse, SessionResponse, StaffRole } from '@sds/shared';
import type { ApiClient, OwnerLoginRequest, OwnerStepUpRequest } from '../api/client.ts';
import { ApiClientError, isApiClientError } from '../api/errors.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { TokenStore } from '../platform/tokenStore.ts';

export type AuthPhase = 'booting' | 'unregistered' | 'locked' | 'signedIn';
export type SignInMethod = 'pin' | 'owner';
/** A one-time explanation shown on the screen the person lands on after being signed out. */
export type Notice = 'sessionExpired' | 'deviceRemoved' | 'deviceMismatch';

export interface Principal {
  id: string;
  displayName: string;
  role: StaffRole;
}

export interface AuthSession {
  staff: Principal;
  permissions: readonly Permission[];
  expiresAt: string;
  idleTimeoutSeconds: number;
  method: SignInMethod;
}

export interface StaffTiles {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  staff: Principal[];
  error: ApiClientError | null;
}

export interface AuthState {
  phase: AuthPhase;
  device: RegisterDeviceResponse['device'] | null;
  session: AuthSession | null;
  /** ISO time until which the session counts as stepped-up; null when it does not. */
  stepUpUntil: string | null;
  staffTiles: StaffTiles;
  /** Staff id -> epoch ms until which the PIN is locked, learned from 423 answers. */
  pinLockedUntil: Record<string, number>;
  notice: Notice | null;
  stepUpOpen: boolean;
}

/**
 * `error: null` on a failure means the person cancelled. `duplicate: true` means this call was
 * ignored because the same kind of attempt is still running: the caller must leave its busy
 * state to the first call and not report anything.
 */
export type Result<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: ApiClientError | null; duplicate?: true };

const duplicate: Result = { ok: false, error: null, duplicate: true };

export type StepUpSubmission =
  | { method: 'owner'; factors: OwnerStepUpRequest }
  | { method: 'pin'; pin: string };

/** The step-up factor follows the role: the owner has a password, everyone else a PIN. */
export const stepUpMethodFor = (role: StaffRole): StepUpSubmission['method'] =>
  role === 'owner' ? 'owner' : 'pin';

/** Skip the step-up round trip only when the local time is clearly inside the window. */
const STEP_UP_MARGIN_MS = 5_000;

const idleTiles: StaffTiles = { status: 'idle', staff: [], error: null };

const success: Result = { ok: true, value: undefined };

const toApiError = (error: unknown): ApiClientError =>
  isApiClientError(error) ? error : new ApiClientError('UNKNOWN');

export interface AuthStoreDeps {
  api: ApiClient;
  tokens: TokenStore;
  /** Epoch milliseconds; tests inject a clock. */
  now?: () => number;
}

export function createAuthStore({ api, tokens, now = Date.now }: AuthStoreDeps) {
  let deviceTokenValue: string | null = null;
  let sessionTokenValue: string | null = null;
  let booting = true;
  let attemptInFlight = false;
  let registering = false;
  let staffRequest: Promise<void> | null = null;
  let stepUpWaiter: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;
  const signOutListeners = new Set<() => void>();

  const store = createStore<AuthState>({
    phase: 'booting',
    device: null,
    session: null,
    stepUpUntil: null,
    staffTiles: idleTiles,
    pinLockedUntil: {},
    notice: null,
    stepUpOpen: false,
  });

  const phaseNow = (): AuthPhase => {
    if (booting) return 'booting';
    const { device, session } = store.getState();
    if (!device) return 'unregistered';
    return session ? 'signedIn' : 'locked';
  };

  /** Applies a change and recomputes the phase from device + session. */
  function set(patch: Partial<AuthState>) {
    store.setState(patch);
    const phase = phaseNow();
    if (phase !== store.getState().phase) store.setState({ phase });
  }

  // ---------- Step-up ----------

  function hasFreshStepUp(): boolean {
    const until = store.getState().stepUpUntil;
    return until !== null && Date.parse(until) - STEP_UP_MARGIN_MS > now();
  }

  function closeStepUp(ok: boolean) {
    const waiter = stepUpWaiter;
    stepUpWaiter = null;
    if (store.getState().stepUpOpen) store.setState({ stepUpOpen: false });
    waiter?.resolve(ok);
  }

  /** Opens the step-up dialog and resolves true once it succeeded, false if cancelled. */
  function requestStepUp(): Promise<boolean> {
    if (sessionTokenValue === null) return Promise.resolve(false);
    if (stepUpWaiter === null) {
      let resolve: (ok: boolean) => void = () => undefined;
      const promise = new Promise<boolean>((r) => {
        resolve = r;
      });
      stepUpWaiter = { promise, resolve };
      store.setState({ stepUpOpen: true });
    }
    return stepUpWaiter.promise;
  }

  /** True now if a step-up is still fresh, otherwise asks the person. */
  const ensureStepUp = (): Promise<boolean> =>
    hasFreshStepUp() ? Promise.resolve(true) : requestStepUp();

  async function submitStepUp(input: StepUpSubmission): Promise<Result> {
    const role = store.getState().session?.staff.role;
    if (!role || sessionTokenValue === null) {
      return { ok: false, error: new ApiClientError('UNAUTHENTICATED') };
    }
    if (input.method !== stepUpMethodFor(role)) {
      return { ok: false, error: new ApiClientError('REQUEST_INVALID') };
    }
    if (attemptInFlight) return duplicate;
    attemptInFlight = true;
    try {
      const answer =
        input.method === 'owner'
          ? await api.auth.stepUpOwner(input.factors)
          : await api.auth.stepUpStaff({ pin: input.pin });
      set({ stepUpUntil: answer.stepUpUntil });
      closeStepUp(true);
      return success;
    } catch (error) {
      return { ok: false, error: toApiError(error) };
    } finally {
      attemptInFlight = false;
    }
  }

  /**
   * Runs a sensitive call. Cancelling the step-up gives `error: null`; any other failure is the
   * call's own error. The call runs at most twice (once more after a STEP_UP_REQUIRED answer).
   */
  async function runSensitive<T>(call: () => Promise<T>): Promise<Result<T>> {
    let retried = false;
    for (;;) {
      if (!hasFreshStepUp() && !(await requestStepUp())) return { ok: false, error: null };
      try {
        return { ok: true, value: await call() };
      } catch (error) {
        const failure = toApiError(error);
        if (failure.code === 'STEP_UP_REQUIRED' && !retried) {
          retried = true;
          set({ stepUpUntil: null });
          continue;
        }
        return { ok: false, error: failure };
      }
    }
  }

  // ---------- Session and device state ----------

  function clearLocalSession(notice: Notice | null): Promise<void> {
    sessionTokenValue = null;
    closeStepUp(false);
    set({ session: null, stepUpUntil: null, staffTiles: idleTiles, notice });
    if (store.getState().phase === 'locked') void loadStaff();
    for (const listener of [...signOutListeners]) listener();
    return tokens.clearSession();
  }

  async function forgetDevice(notice: Notice | null): Promise<void> {
    deviceTokenValue = null;
    sessionTokenValue = null;
    closeStepUp(false);
    set({ device: null, session: null, stepUpUntil: null, staffTiles: idleTiles, notice });
    for (const listener of [...signOutListeners]) listener();
    await Promise.all([tokens.clearDevice(), tokens.clearSession()]);
  }

  async function adoptSession(response: SessionResponse, method: SignInMethod): Promise<void> {
    sessionTokenValue = response.sessionToken;
    set({
      session: {
        staff: response.staff,
        permissions: response.permissions,
        expiresAt: response.expiresAt,
        idleTimeoutSeconds: response.idleTimeoutSeconds,
        method,
      },
      stepUpUntil: null,
      notice: null,
    });
    // Only a PIN session is kept for the tab; the owner signs in again after a reload.
    if (method === 'pin') await tokens.saveSession(response);
  }

  /** The API client calls this when a response says the session or device is gone. */
  function handleAuthFailure(error: ApiClientError): void {
    if (booting) return;
    if (error.code === 'DEVICE_UNREGISTERED') void forgetDevice('deviceRemoved');
    else if (error.code === 'DEVICE_MISMATCH' && sessionTokenValue !== null) {
      void clearLocalSession('deviceMismatch');
    } else if (error.code === 'UNAUTHENTICATED' && sessionTokenValue !== null) {
      void clearLocalSession('sessionExpired');
    }
  }

  // ---------- Start-up ----------

  async function boot(): Promise<void> {
    const [stored, saved] = await Promise.all([tokens.loadDevice(), tokens.loadSession()]);
    if (stored) {
      deviceTokenValue = stored.deviceToken;
      store.setState({ device: stored.device });
    }

    if (saved && !stored) {
      await tokens.clearSession();
    } else if (saved && Date.parse(saved.expiresAt) <= now()) {
      await tokens.clearSession();
    } else if (saved) {
      sessionTokenValue = saved.sessionToken;
      store.setState({
        session: {
          staff: saved.staff,
          permissions: saved.permissions,
          expiresAt: saved.expiresAt,
          idleTimeoutSeconds: saved.idleTimeoutSeconds,
          method: 'pin',
        },
      });
      try {
        const me = await api.auth.me();
        const current = store.getState().session;
        if (current) {
          store.setState({
            session: {
              ...current,
              staff: me.staff,
              permissions: me.permissions,
              expiresAt: me.expiresAt,
            },
            stepUpUntil: me.stepUpUntil,
          });
        }
      } catch (error) {
        const code = toApiError(error).code;
        if (code === 'DEVICE_UNREGISTERED') {
          deviceTokenValue = null;
          sessionTokenValue = null;
          store.setState({ device: null, session: null, notice: 'deviceRemoved' });
          await Promise.all([tokens.clearDevice(), tokens.clearSession()]);
        } else if (code === 'UNAUTHENTICATED' || code === 'DEVICE_MISMATCH') {
          sessionTokenValue = null;
          store.setState({ session: null });
          await tokens.clearSession();
        }
        // Offline or a server hiccup: keep the saved session; the next call will say if it died.
      }
    }

    booting = false;
    set({});
    if (store.getState().phase === 'locked') void loadStaff();
  }

  /** Loads the PIN screen's tiles. A call while one is running joins it. */
  function loadStaff(): Promise<void> {
    if (staffRequest) return staffRequest;
    if (deviceTokenValue === null) return Promise.resolve();
    store.setState({
      staffTiles: { status: 'loading', staff: store.getState().staffTiles.staff, error: null },
    });
    staffRequest = (async () => {
      try {
        const { staff } = await api.auth.listStaff();
        store.setState({ staffTiles: { status: 'ready', staff, error: null } });
      } catch (error) {
        store.setState({ staffTiles: { status: 'failed', staff: [], error: toApiError(error) } });
      } finally {
        staffRequest = null;
      }
    })();
    return staffRequest;
  }

  // ---------- Sign-in ----------

  async function signInWithPin(staffId: string, pin: string): Promise<Result> {
    if (attemptInFlight) return duplicate;
    attemptInFlight = true;
    try {
      await adoptSession(await api.auth.pinLogin({ staffId, pin }), 'pin');
      return success;
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'ACCOUNT_LOCKED' && failure.retryAfterSeconds !== null) {
        const until = now() + failure.retryAfterSeconds * 1000;
        set({ pinLockedUntil: { ...store.getState().pinLockedUntil, [staffId]: until } });
      }
      return { ok: false, error: failure };
    } finally {
      attemptInFlight = false;
    }
  }

  async function signInOwner(input: OwnerLoginRequest): Promise<Result> {
    if (attemptInFlight) return duplicate;
    attemptInFlight = true;
    try {
      const hadDevice = deviceTokenValue !== null;
      let response: SessionResponse;
      try {
        response = await api.auth.ownerLogin(input);
      } catch (error) {
        // A device token the server no longer knows blocks even the owner's sign-in. The API
        // client has already told us (handleAuthFailure forgot the device), so try once more
        // without it: the owner can then register this device again.
        const failure = toApiError(error);
        if (hadDevice && failure.code === 'DEVICE_UNREGISTERED' && deviceTokenValue === null) {
          response = await api.auth.ownerLogin(input);
        } else {
          throw failure;
        }
      }
      await adoptSession(response, 'owner');
      return success;
    } catch (error) {
      return { ok: false, error: toApiError(error) };
    } finally {
      attemptInFlight = false;
    }
  }

  /** Registers this device. The owner is signed in already; the API wants a fresh step-up. */
  async function registerDevice(
    input: Parameters<ApiClient['auth']['registerDevice']>[0],
  ): Promise<Result> {
    const { session, device } = store.getState();
    if (!session || device) return { ok: false, error: new ApiClientError('FORBIDDEN') };
    // A second tap while the step-up dialog or the request is open must not register twice.
    if (registering) return duplicate;
    registering = true;
    try {
      const outcome = await runSensitive(() => api.auth.registerDevice(input));
      if (!outcome.ok) return outcome;
      deviceTokenValue = outcome.value.deviceToken;
      await tokens.saveDevice(outcome.value);
      set({ device: outcome.value.device });
      return success;
    } finally {
      registering = false;
    }
  }

  // ---------- Sign-out ----------

  /**
   * Clears everything that identifies the person (session, role, step-up, stored session) at
   * once, then tells the server. The device registration stays. Works offline: if the server
   * cannot be reached the session simply expires there.
   */
  async function signOut(): Promise<void> {
    const token = sessionTokenValue;
    await clearLocalSession(null);
    if (token === null) return;
    try {
      await api.auth.logout(token);
    } catch {
      // nothing more to do: the local state is already clear
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    boot,
    loadStaff,
    signInWithPin,
    signInOwner,
    registerDevice,
    signOut,
    forgetDevice: () => forgetDevice(null),
    hasFreshStepUp,
    ensureStepUp,
    requestStepUp,
    submitStepUp,
    cancelStepUp: () => closeStepUp(false),
    runSensitive,
    handleAuthFailure,
    /** Called after sign-out or when the device is forgotten, so other stores can empty. */
    onSignOut(listener: () => void): () => void {
      signOutListeners.add(listener);
      return () => void signOutListeners.delete(listener);
    },
    /** For the API client only. Never render, log or serialize these. */
    deviceToken: () => deviceTokenValue,
    sessionToken: () => sessionTokenValue,
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
export type AuthReader = ReadableStore<AuthState>;

/** Permission check for routes and buttons. The API still enforces it on every call. */
export function can(state: AuthState, permission: Permission): boolean {
  return state.session?.permissions.includes(permission) ?? false;
}
