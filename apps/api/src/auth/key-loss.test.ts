/**
 * AUTH_SECRET_KEY lost or replaced (QA High): the stored TOTP secret no longer decrypts. That must
 * not be an unaudited 500 inside the transaction, must not lock the owner out, and recovery
 * codes (which never need the key) must still sign in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { deriveAuthKeys, encryptSecret } from './crypto.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const replacedKeys = deriveAuthKeys(Buffer.alloc(32, 1));

/** An owner whose TOTP secret was encrypted under a different key, as after a key change. */
async function ownerWithUnreadableSecret(): Promise<OwnerFixture> {
  const owner = await h.newOwner();
  await h.client.query('update owner_credentials set totp_secret_enc = $1 where staff_id = $2', [
    encryptSecret(owner.totpSecret, replacedKeys.totpKey, owner.staffId),
    owner.staffId,
  ]);
  return owner;
}

const login = (body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/owner',
    payload: body,
    remoteAddress: h.nextIp(),
  });

describe('a TOTP secret that cannot be decrypted', () => {
  test('is a clear 503 after the right password, not a bare 500, and is audited and alerted', async () => {
    const owner = await ownerWithUnreadableSecret();
    const res = await login({ email: owner.email, password: owner.password, totp: owner.totp() });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SECOND_FACTOR_UNAVAILABLE', details: {} });

    const audit = (await h.auditRows(owner.staffId)).filter(
      (a) => a.action === 'auth.totp_unreadable',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'system', entity: 'staff' });
    expect(h.alerts).toContainEqual(
      expect.objectContaining({
        kind: 'owner.totp_unreadable',
        severity: 'critical',
        staffId: owner.staffId,
      }),
    );
  });

  test('puts no secret, ciphertext or key material in the response, audit row or log', async () => {
    const owner = await ownerWithUnreadableSecret();
    const stored = (
      await h.client.query<{ totp_secret_enc: string }>(
        'select totp_secret_enc from owner_credentials where staff_id = $1',
        [owner.staffId],
      )
    ).rows[0]?.totp_secret_enc;
    const res = await login({ email: owner.email, password: owner.password, totp: owner.totp() });
    const everything = JSON.stringify([res.json(), await h.auditRows(owner.staffId)]) + h.logs();
    expect(everything).not.toContain(stored ?? 'x');
    expect(everything).not.toContain(owner.totpSecret.toString('base64url'));
    expect(everything).not.toMatch(/Unsupported state|unable to authenticate/i);
  });

  test('does not count as a wrong guess, so it never locks the owner out of recovery', async () => {
    const owner = await ownerWithUnreadableSecret();
    for (let i = 0; i < 8; i++) {
      const res = await login({ email: owner.email, password: owner.password, totp: owner.totp() });
      expect(res.statusCode).toBe(503);
    }
    const row = (
      await h.client.query(
        'select failed_login_count, locked_until from owner_credentials where staff_id = $1',
        [owner.staffId],
      )
    ).rows[0];
    expect(row).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  test('a recovery code still signs in, because it never needs the key', async () => {
    const owner = await ownerWithUnreadableSecret();
    const res = await login({
      email: owner.email,
      password: owner.password,
      recoveryCode: owner.recoveryCodes[0],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staff: { id: owner.staffId, role: 'owner' } });
  });

  test('a wrong password still looks like any other wrong password', async () => {
    const owner = await ownerWithUnreadableSecret();
    const res = await login({
      email: owner.email,
      password: 'definitely-not-it',
      totp: owner.totp(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  test('step-up reports the same failure, and a recovery code works there too', async () => {
    const owner = await ownerWithUnreadableSecret();
    const session = await login({
      email: owner.email,
      password: owner.password,
      recoveryCode: owner.recoveryCodes[0],
    });
    const token = (session.json() as { sessionToken: string }).sessionToken;
    const stepUp = (body: Record<string, unknown>) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/step-up',
        headers: { authorization: `Bearer ${token}` },
        payload: body,
        remoteAddress: h.nextIp(),
      });
    const withTotp = await stepUp({ password: owner.password, totp: owner.totp(1) });
    expect(withTotp.statusCode).toBe(503);
    expect(withTotp.json()).toMatchObject({ code: 'SECOND_FACTOR_UNAVAILABLE' });
    const withCode = await stepUp({
      password: owner.password,
      recoveryCode: owner.recoveryCodes[1],
    });
    expect(withCode.statusCode).toBe(200);
  });
});
