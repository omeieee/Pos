import { describe, expect, test } from 'vitest';
import {
  apiError,
  bodyOf,
  FAKE_DEVICE_TOKEN,
  FAKE_SESSION_TOKEN,
  mockFetch,
} from '../test-support/fixtures.ts';
import { createApiClient } from './client.ts';

const BASE = 'https://api.example.test';
const NOW = '2026-10-04T03:00:00.000Z';
const ID = '0192f3a0-0000-7000-8000-000000000501';
const TOKEN = 'tok_MADEUP_invite_token_0001';

function clientWith(responder: Parameters<typeof mockFetch>[0]) {
  const net = mockFetch(responder);
  const api = createApiClient({
    baseUrl: BASE,
    fetch: net.fetch,
    getSessionToken: () => FAKE_SESSION_TOKEN,
    getDeviceToken: () => FAKE_DEVICE_TOKEN,
  });
  return { api, calls: net.calls };
}

const invite = {
  id: ID,
  email: 'new@example.test',
  role: 'cashier',
  displayName: null,
  createdAt: NOW,
  expiresAt: '2026-10-07T03:00:00.000Z',
  status: 'open',
};

describe('the owner’s invite calls', () => {
  test('list, create and revoke use the staff routes, with the session', async () => {
    const { api, calls } = clientWith((call) => {
      if (call.method === 'GET') return { status: 200, json: { invites: [invite] } };
      if (call.url.endsWith('/revoke')) return { status: 204 };
      return { status: 201, json: { ...invite, token: TOKEN } };
    });
    expect((await api.admin.invites()).invites).toHaveLength(1);
    const made = await api.admin.createInvite({ email: ' New@Example.test ', role: 'manager' });
    expect(made.token).toBe(TOKEN);
    await api.admin.revokeInvite(ID);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/staff/invites`,
      `POST ${BASE}/v1/staff/invites`,
      `POST ${BASE}/v1/staff/invites/${ID}/revoke`,
    ]);
    expect(bodyOf(calls[1])).toEqual({ email: 'new@example.test', role: 'manager' });
    expect(calls.every((c) => c.headers.authorization === `Bearer ${FAKE_SESSION_TOKEN}`)).toBe(
      true,
    );
  });

  test('a bad e-mail is refused before the network', async () => {
    const { api, calls } = clientWith(() => ({ status: 201, json: { ...invite, token: TOKEN } }));
    await expect(api.admin.createInvite({ email: 'nope', role: 'cashier' })).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
    });
    expect(calls).toHaveLength(0);
  });

  test('a role change is a POST to the role route with the version, and a PIN only if given', async () => {
    const person = {
      id: ID,
      displayName: 'น้องเอ',
      role: 'manager',
      active: true,
      email: 'a@example.test',
      hasPin: true,
      pinLockedUntil: null,
      version: 3,
    };
    const { api, calls } = clientWith(() => ({ status: 200, json: person }));
    await api.admin.changeStaffRole(ID, { expectedVersion: 2, role: 'manager', pin: '123456' });
    await api.admin.changeStaffRole(ID, { expectedVersion: 3, role: 'kitchen' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/staff/${ID}/role` });
    expect(bodyOf(calls[0])).toEqual({ expectedVersion: 2, role: 'manager', pin: '123456' });
    expect(bodyOf(calls[1])).toEqual({ expectedVersion: 3, role: 'kitchen' });
    // A PIN too short for the new role never leaves the device.
    await expect(
      api.admin.changeStaffRole(ID, { expectedVersion: 3, role: 'manager', pin: '1234' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(calls).toHaveLength(2);
  });

  test('the new conflict codes keep their code', async () => {
    for (const code of ['LAST_OWNER', 'SELF_CHANGE', 'OWNER_NEEDS_ACCOUNT', 'INVITE_EXISTS']) {
      const { api } = clientWith(() => apiError(409, code));
      await expect(
        api.admin.changeStaffRole(ID, { expectedVersion: 1, role: 'kitchen' }),
      ).rejects.toMatchObject({ code, status: 409 });
    }
  });
});

describe('the invite page’s public calls', () => {
  const preview = {
    email: 'new@example.test',
    role: 'cashier',
    displayName: null,
    totp: {
      secretBase32: 'JBSWY3DPEHPK3PXA',
      otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXA',
    },
  };

  test('they carry the token in the body only, and neither a session nor a device token', async () => {
    const { api, calls } = clientWith((call) =>
      call.url.endsWith('/preview')
        ? { status: 200, json: preview }
        : { status: 200, json: { recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] } },
    );
    await api.auth.invitePreview({ token: TOKEN });
    const accepted = await api.auth.inviteAccept({
      token: TOKEN,
      displayName: 'น้องนก',
      password: 'a long enough made-up password',
      pin: '1234',
      totpCode: '123456',
    });
    expect(accepted.recoveryCodes).toHaveLength(1);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/auth/invite/preview`,
      `${BASE}/v1/auth/invite/accept`,
    ]);
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers['x-device-token']).toBeUndefined();
    }
    expect(bodyOf(calls[0])).toEqual({ token: TOKEN });
  });

  test('a wrong code (422) and an unusable link (404) keep their codes, and the token is in neither error', async () => {
    const wrong = clientWith(() => apiError(422, 'INVITE_CODE_INVALID'));
    const error = await wrong.api.auth
      .inviteAccept({
        token: TOKEN,
        displayName: 'น้องนก',
        password: 'a long enough made-up password',
        pin: '1234',
        totpCode: '123456',
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'INVITE_CODE_INVALID', status: 422 });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    const gone = clientWith(() => apiError(404, 'INVITE_INVALID'));
    await expect(gone.api.auth.invitePreview({ token: TOKEN })).rejects.toMatchObject({
      code: 'INVITE_INVALID',
      status: 404,
    });
  });

  test('an invalid answer from the server is RESPONSE_INVALID, never used', async () => {
    const { api } = clientWith(() => ({ status: 200, json: { email: 'x' } }));
    await expect(api.auth.invitePreview({ token: TOKEN })).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    });
  });
});
