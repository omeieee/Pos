/**
 * PIN lock escalation (QA High): repeated lock cycles get longer, 5 min then 1 h then 24 h, and
 * the ladder resets only on a successful sign-in (or step-up, for the step-up ladder).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, START_TIME } from '../test-support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

let day = 0;
function freshClock() {
  day += 1;
  h.clock.set(new Date(Date.parse(START_TIME) + day * 7 * 24 * 3_600_000).toISOString());
}

const MIN = 60;
const HOUR = 60 * MIN;
const LADDER = [5 * MIN, HOUR, 24 * HOUR];

async function setup() {
  freshClock();
  const device = await h.newDevice();
  const staff = await h.newStaff('cashier', '4821');
  return { device, staff };
}

function pinSignIn(device: { token: string }, staffId: string, pin: string) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/auth/pin',
    headers: { 'x-device-token': device.token },
    payload: { staffId, pin },
    remoteAddress: h.nextIp(),
  });
}

/** Five wrong PINs in a row; returns the answer to the fifth (the one that locks). */
async function fiveWrong(device: { token: string }, staffId: string) {
  let last = await pinSignIn(device, staffId, '0000');
  for (let i = 1; i < 5; i++) last = await pinSignIn(device, staffId, '0000');
  return last;
}

const retryAfter = (res: { json(): unknown }) =>
  (res.json() as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;

describe('PIN sign-in lock escalation', () => {
  test('5 minutes, then 1 hour, then 24 hours, and 24 hours from then on', async () => {
    const { device, staff } = await setup();
    const waits: number[] = [];
    for (const expected of [...LADDER, LADDER[2] ?? 0]) {
      const res = await fiveWrong(device, staff.id);
      expect(res.statusCode).toBe(423);
      waits.push(retryAfter(res));
      expect(retryAfter(res)).toBe(expected);
      // Still locked a moment before the end, even for the right PIN; free right after.
      h.clock.advanceSeconds(expected - 1);
      expect((await pinSignIn(device, staff.id, '4821')).statusCode).toBe(423);
      h.clock.advanceSeconds(1);
    }
    expect(waits).toEqual([300, 3600, 86400, 86400]);
  });

  test('the level is audited with each lock', async () => {
    const { device, staff } = await setup();
    await fiveWrong(device, staff.id);
    h.clock.advanceSeconds(5 * MIN);
    await fiveWrong(device, staff.id);
    const locks = (await h.auditRows(staff.id)).filter((a) => a.action === 'auth.pin_locked');
    expect(locks.map((a) => (a.after as { lockLevel: number }).lockLevel)).toEqual([1, 2]);
  });

  test('a lock that has run out does not reset the ladder; a successful sign-in does', async () => {
    const { device, staff } = await setup();
    await fiveWrong(device, staff.id); // level 1: 5 min
    h.clock.advanceSeconds(5 * MIN);
    const second = await fiveWrong(device, staff.id); // level 2: 1 h
    expect(retryAfter(second)).toBe(HOUR);

    h.clock.advanceSeconds(HOUR);
    expect((await pinSignIn(device, staff.id, '4821')).statusCode).toBe(200);
    // Back to the bottom of the ladder.
    const again = await fiveWrong(device, staff.id);
    expect(retryAfter(again)).toBe(5 * MIN);
  });

  test('a person who signs in between rare slips never climbs the ladder', async () => {
    const { device, staff } = await setup();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) await pinSignIn(device, staff.id, '0000');
      expect((await pinSignIn(device, staff.id, '4821')).statusCode).toBe(200);
    }
    expect(retryAfter(await fiveWrong(device, staff.id))).toBe(5 * MIN);
  });

  test("one person's ladder does not move another's", async () => {
    const { device, staff } = await setup();
    const other = await h.newStaff('cashier', '4821');
    await fiveWrong(device, staff.id);
    h.clock.advanceSeconds(5 * MIN);
    await fiveWrong(device, staff.id);
    expect(retryAfter(await fiveWrong(device, other.id))).toBe(5 * MIN);
  });
});

describe('PIN step-up lock escalation', () => {
  test('follows the same ladder, on its own level', async () => {
    freshClock();
    const device = await h.newDevice();
    const manager = await h.newStaff('manager', '4821');
    const token = await h.pinSession(device.token, manager.id, '4821');
    const wrongStepUp = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/step-up',
        headers: { authorization: `Bearer ${token}`, 'x-device-token': device.token },
        payload: { pin: '0000' },
        remoteAddress: h.nextIp(),
      });
    const five = async () => {
      let last = await wrongStepUp();
      for (let i = 1; i < 5; i++) last = await wrongStepUp();
      return last;
    };
    const first = await five();
    expect(first.statusCode).toBe(423);
    expect(retryAfter(first)).toBe(5 * MIN);
    // (The session idles out; the ladder does not care, so sign in again at each step.)
    h.clock.advanceSeconds(5 * MIN);
    const second = await five();
    expect(retryAfter(second)).toBe(HOUR);
  });
});
