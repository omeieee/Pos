import type { InvitePreviewResponse } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { emptyInviteDraft, type InviteDraft } from './invite-model.ts';
import { createInviteStore } from './invite-store.ts';

const TOKEN = 'tok_MADEUP_invite_token_0001';
const preview: InvitePreviewResponse = {
  email: 'new@example.test',
  role: 'cashier',
  displayName: null,
  totp: {
    secretBase32: 'JBSWY3DPEHPK3PXA',
    otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXA',
  },
};
const draft: InviteDraft = {
  ...emptyInviteDraft,
  displayName: 'น้องนก',
  password: 'a long enough made-up password',
  pin: '1234',
  pin2: '1234',
  code: '123456',
};

function env(over: Partial<Pick<ApiClient['auth'], 'invitePreview' | 'inviteAccept'>> = {}) {
  const api = {
    invitePreview: vi.fn(over.invitePreview ?? (async () => preview)),
    inviteAccept: vi.fn(
      over.inviteAccept ?? (async () => ({ recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] })),
    ),
  };
  return { api, store: createInviteStore({ api }) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('reading the invite', () => {
  test('the preview runs once however often start is called (it replaces the authenticator secret)', async () => {
    const { api, store } = env();
    store.start(TOKEN);
    store.start(TOKEN);
    store.start(TOKEN);
    await settle();
    expect(api.invitePreview).toHaveBeenCalledTimes(1);
    expect(api.invitePreview).toHaveBeenCalledWith({ token: TOKEN });
    expect(store.getState()).toMatchObject({ phase: 'ready', preview });
  });

  test('no token at all is the one generic "invalid" state, with no call', async () => {
    const { api, store } = env();
    store.start(null);
    expect(store.getState().phase).toBe('invalid');
    expect(api.invitePreview).not.toHaveBeenCalled();
  });

  test.each([
    'INVITE_INVALID',
    'INVITE_ACCEPTED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'REQUEST_INVALID',
  ])('%s at the preview is the same generic state', async (code) => {
    const { store } = env({
      invitePreview: async () => {
        throw new ApiClientError(code, { status: 404 });
      },
    });
    store.start(TOKEN);
    await settle();
    expect(store.getState()).toMatchObject({ phase: 'invalid', preview: null });
  });

  test('offline or a busy server is "unavailable" and a retry asks again', async () => {
    let fail = true;
    const { api, store } = env({
      invitePreview: async () => {
        if (fail) throw new ApiClientError('NETWORK');
        return preview;
      },
    });
    store.start(TOKEN);
    await settle();
    expect(store.getState()).toMatchObject({ phase: 'unavailable' });
    expect(store.getState().error?.code).toBe('NETWORK');
    fail = false;
    store.retry();
    await settle();
    expect(store.getState().phase).toBe('ready');
    expect(api.invitePreview).toHaveBeenCalledTimes(2);
    // A retry on a form that is already showing does nothing.
    store.retry();
    expect(api.invitePreview).toHaveBeenCalledTimes(2);
  });
});

describe('sending the form', () => {
  test('a good form is sent with the token and shows the recovery codes once; the token is forgotten', async () => {
    const { api, store } = env();
    store.start(TOKEN);
    await settle();
    await expect(store.accept(draft)).resolves.toBe(true);
    expect(api.inviteAccept).toHaveBeenCalledWith({
      token: TOKEN,
      displayName: 'น้องนก',
      password: draft.password,
      pin: '1234',
      totpCode: '123456',
    });
    expect(store.getState()).toMatchObject({
      phase: 'done',
      recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'],
      preview: null,
    });
    // The state never held the token, and the spent link cannot be sent again.
    expect(JSON.stringify(store.getState())).not.toContain(TOKEN);
    await expect(store.accept(draft)).resolves.toBe(false);
    expect(api.inviteAccept).toHaveBeenCalledTimes(1);
  });

  test('an invalid form sends nothing', async () => {
    const { api, store } = env();
    store.start(TOKEN);
    await settle();
    await expect(store.accept({ ...draft, pin2: '9999' })).resolves.toBe(false);
    expect(api.inviteAccept).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe('ready');
  });

  test('a wrong authenticator code keeps the form (422): it is not a dead link', async () => {
    const { api, store } = env({
      inviteAccept: async () => {
        throw new ApiClientError('INVITE_CODE_INVALID', { status: 422 });
      },
    });
    store.start(TOKEN);
    await settle();
    await expect(store.accept(draft)).resolves.toBe(false);
    expect(store.getState()).toMatchObject({ phase: 'ready' });
    expect(store.getState().preview).toEqual(preview);
    expect(store.getState().error?.code).toBe('INVITE_CODE_INVALID');
    // The next code goes through with the same token: the preview did not run again.
    api.inviteAccept.mockResolvedValueOnce({ recoveryCodes: ['X'] });
    await expect(store.accept({ ...draft, code: '654321' })).resolves.toBe(true);
    expect(api.invitePreview).toHaveBeenCalledTimes(1);
  });

  test('a taken e-mail or a busy server keeps the form; a dead link at accept is the generic state', async () => {
    for (const code of ['EMAIL_TAKEN', 'RATE_LIMITED', 'NETWORK']) {
      const { store } = env({
        inviteAccept: async () => {
          throw new ApiClientError(code);
        },
      });
      store.start(TOKEN);
      await settle();
      await store.accept(draft);
      expect(store.getState()).toMatchObject({ phase: 'ready' });
      expect(store.getState().error?.code).toBe(code);
    }
    const dead = env({
      inviteAccept: async () => {
        throw new ApiClientError('INVITE_INVALID', { status: 404 });
      },
    });
    dead.store.start(TOKEN);
    await settle();
    await dead.store.accept(draft);
    expect(dead.store.getState()).toMatchObject({ phase: 'invalid', preview: null });
  });

  test('a field the server refused (400) keeps the form and the token: the link is still good', async () => {
    const { api, store } = env({
      inviteAccept: async () => {
        throw new ApiClientError('VALIDATION_ERROR', { status: 400 });
      },
    });
    store.start(TOKEN);
    await settle();
    await expect(store.accept(draft)).resolves.toBe(false);
    expect(store.getState()).toMatchObject({ phase: 'ready' });
    expect(store.getState().error?.code).toBe('VALIDATION_ERROR');
    api.inviteAccept.mockResolvedValueOnce({ recoveryCodes: ['X'] });
    await expect(store.accept(draft)).resolves.toBe(true);
    expect(api.inviteAccept).toHaveBeenLastCalledWith(expect.objectContaining({ token: TOKEN }));
  });

  test('a double tap sends once', async () => {
    let release: () => void = () => undefined;
    const { api, store } = env({
      inviteAccept: () =>
        new Promise((resolve) => {
          release = () => resolve({ recoveryCodes: ['X'] });
        }),
    });
    store.start(TOKEN);
    await settle();
    const first = store.accept(draft);
    await expect(store.accept(draft)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(api.inviteAccept).toHaveBeenCalledTimes(1);
  });
});
