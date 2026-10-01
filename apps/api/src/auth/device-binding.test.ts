/**
 * PIN sessions are bound to the device (QA Medium): a stolen session token is useless without the
 * device token that signed it in. Every request on a PIN session must carry that device's
 * X-Device-Token. Owner sessions (password + TOTP) are not bound.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

// The harness adds the right device header to a known PIN session by itself; these tests turn
// that off to see what the API does with exactly the headers they send.
const RAW = { 'x-test-no-device-autofill': '1' };

async function signedIn() {
  const device = await h.newDevice();
  const staff = await h.newStaff('manager', '4821');
  const token = await h.pinSession(device.token, staff.id, '4821');
  return { device, staff, token };
}

const me = (headers: Record<string, string>) =>
  h.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { ...RAW, ...headers } });

describe('a PIN session', () => {
  test('works with the device token it was opened on', async () => {
    const { device, token } = await signedIn();
    const res = await me({ authorization: `Bearer ${token}`, 'x-device-token': device.token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deviceId: device.id });
  });

  test('is refused without a device token', async () => {
    const { token } = await signedIn();
    const res = await me({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'DEVICE_MISMATCH' });
  });

  test("is refused with another registered device's token, or a made-up one", async () => {
    const { token } = await signedIn();
    const other = await h.newDevice();
    for (const device of [other.token, 'sds_dev_not-a-real-token-at-all-0123456789']) {
      const res = await me({ authorization: `Bearer ${token}`, 'x-device-token': device });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'DEVICE_MISMATCH' });
    }
  });

  test('an unknown session token still just says "sign in", whatever device is sent', async () => {
    const { device } = await signedIn();
    const res = await me({
      authorization: 'Bearer sds_ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'x-device-token': device.token,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  test('stays refused when the device is revoked, even with its token', async () => {
    const { device, token } = await signedIn();
    await h.revokeDevice(device.id);
    const res = await me({ authorization: `Bearer ${token}`, 'x-device-token': device.token });
    expect(res.statusCode).toBe(401);
  });

  test('the same check guards every route: permission probes, step-up, logout and orders', async () => {
    const { device, token } = await signedIn();
    const withDevice = { authorization: `Bearer ${token}`, 'x-device-token': device.token };
    const without = { authorization: `Bearer ${token}` };
    const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>) =>
      h.app.inject({
        method,
        url,
        headers: { ...RAW, ...headers },
        ...(method === 'POST' ? { payload: {} } : {}),
        remoteAddress: h.nextIp(),
      });

    for (const [method, url] of [
      ['GET', '/__probe/session'],
      ['GET', '/__probe/payment.confirm'],
      ['GET', '/v1/orders'],
      ['POST', '/v1/auth/step-up'],
      ['POST', '/v1/auth/logout'],
    ] as const) {
      const bad = await call(method, url, without);
      expect(bad.statusCode, `${method} ${url} without the device`).toBe(401);
      expect(bad.json()).toMatchObject({ code: 'DEVICE_MISMATCH' });
      const good = await call(method, url, withDevice);
      expect(good.statusCode, `${method} ${url} with the device`).not.toBe(401);
    }
  });
});

describe('an owner session', () => {
  test('is not bound to a device: it works without the header', async () => {
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
  });

  test('is not bound even when it was opened from a registered device', async () => {
    const owner = await h.newOwner();
    const device = await h.newDevice('laptop');
    const token = await h.ownerSession(owner, device.token);
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    expect(
      (
        await me({
          authorization: `Bearer ${token}`,
          'x-device-token': 'sds_dev_whatever-0123456789012345',
        })
      ).statusCode,
    ).toBe(200);
  });

  test("an owner's own PIN session on a device is bound like anyone's", async () => {
    const owner = await h.newOwner({ pin: '246810' });
    const device = await h.newDevice();
    const token = await h.pinSession(device.token, owner.staffId, '246810');
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
    expect(
      (await me({ authorization: `Bearer ${token}`, 'x-device-token': device.token })).statusCode,
    ).toBe(200);
  });
});
