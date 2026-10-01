/**
 * QA N1: one anonymous address must not be able to use up the global buckets and so block the
 * owner's sign-in or anyone's step-up. These use the PRODUCTION limits (30 global, 10 per IP),
 * not shrunken test ones, and flood each route from ONE address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { DEFAULT_AUTH_POLICY } from './policy.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    policy: {
      ownerGlobalRatePerMinute: DEFAULT_AUTH_POLICY.ownerGlobalRatePerMinute,
      stepUpGlobalRatePerMinute: DEFAULT_AUTH_POLICY.stepUpGlobalRatePerMinute,
    },
  });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const FLOOD_IP = '203.0.113.50';
const FLOOD_COUNT = 31; // one more than the global default of 30

/** One request after another, as an attacker's script would (and as the limiter counts them). */
async function sequentially(count: number, send: () => Promise<{ statusCode: number }>) {
  const codes: number[] = [];
  for (let i = 0; i < count; i++) codes.push((await send()).statusCode);
  return codes;
}

describe('flooding from one address', () => {
  test('production limits are what this test runs with', () => {
    expect(DEFAULT_AUTH_POLICY.ownerGlobalRatePerMinute).toBe(30);
    expect(DEFAULT_AUTH_POLICY.stepUpGlobalRatePerMinute).toBe(30);
  });

  test('/v1/auth/owner: 31 bad sign-ins from one IP do not block a valid sign-in from another', async () => {
    const owner = await h.newOwner();
    const bad = { email: 'nobody@example.test', password: 'whatever-it-is', totp: '123456' };
    const flood = await sequentially(FLOOD_COUNT, () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/owner',
        payload: bad,
        remoteAddress: FLOOD_IP,
      }),
    );
    expect(
      flood.filter((s) => s === 401),
      JSON.stringify(flood),
    ).toHaveLength(10); // the per-IP allowance
    expect(flood.filter((s) => s === 429)).toHaveLength(FLOOD_COUNT - 10);

    const valid = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: owner.email, password: owner.password, totp: owner.totp() },
      remoteAddress: '198.51.100.7',
    });
    expect(valid.statusCode).toBe(200);

    // The flooding address itself stays limited.
    const again = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: bad,
      remoteAddress: FLOOD_IP,
    });
    expect(again.statusCode).toBe(429);
  });

  test('/v1/auth/step-up: 31 anonymous requests from one IP do not block owner or manager step-up elsewhere', async () => {
    const owner = await h.newOwner();
    h.clock.advanceSeconds(90);
    const ownerToken = await h.ownerSession(owner);
    const device = await h.newDevice();
    const manager = await h.newStaff('manager', '4821');
    const managerToken = await h.pinSession(device.token, manager.id, '4821');

    const flood = await sequentially(FLOOD_COUNT, () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/step-up',
        payload: { pin: '0000' },
        remoteAddress: FLOOD_IP,
      }),
    );
    expect(flood.every((s) => s === 401 || s === 429)).toBe(true);
    expect(flood.filter((s) => s === 401).length).toBeGreaterThan(0);

    h.clock.advanceSeconds(30);
    const ownerStep = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/step-up',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { password: owner.password, totp: owner.totp(1) },
      remoteAddress: '198.51.100.8',
    });
    expect(ownerStep.statusCode).toBe(200);

    const managerStep = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/step-up',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { pin: '4821' },
      remoteAddress: '198.51.100.9',
    });
    expect(managerStep.statusCode).toBe(200);
  });

  test('an authenticated flood of step-ups from one IP is limited per IP, and still spares others', async () => {
    h.clock.advanceSeconds(90);
    const device = await h.newDevice();
    const manager = await h.newStaff('manager', '4821');
    const token = await h.pinSession(device.token, manager.id, '4821');
    const flood = await sequentially(FLOOD_COUNT, () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/step-up',
        headers: { authorization: `Bearer ${token}` },
        payload: { pin: '0000' },
        remoteAddress: FLOOD_IP,
      }),
    );
    expect(flood.filter((s) => s === 429).length).toBeGreaterThan(0);

    const other = await h.newStaff('manager', '4821');
    const otherToken = await h.pinSession(device.token, other.id, '4821');
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/step-up',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { pin: '4821' },
      remoteAddress: '198.51.100.10',
    });
    expect(ok.statusCode).toBe(200);
  });
});
