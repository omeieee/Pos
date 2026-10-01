import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ApiError } from '../errors.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { decryptSecret } from './crypto.ts';
import { createOwner, OwnerExistsError, RECOVERY_CODE_COUNT } from './owner-setup.ts';
import { generateTotpSecret, hotp, timeStep } from './totp.ts';

// This file creates THE owner, so it needs its own database and no other owner fixture.
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const secret = generateTotpSecret();
const input = {
  email: 'Owner@Example.test',
  displayName: 'Shop Owner',
  password: 'a long made-up password',
  pin: '246810',
  totpSecret: secret,
};

describe('createOwner (the owner:create command)', () => {
  let staffId = '';
  let recoveryCodes: string[] = [];

  test('creates the owner and returns the recovery codes once', async () => {
    const created = await createOwner({ db: h.db, keys: h.keys }, input);
    staffId = created.staffId;
    recoveryCodes = created.recoveryCodes;
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
  });

  test('stores only hashes and ciphertext', async () => {
    const creds = (
      await h.client.query<{
        email: string;
        password_hash: string;
        totp_secret_enc: string;
        recovery_code_hashes: string[];
      }>('select * from owner_credentials where staff_id = $1', [staffId])
    ).rows[0];
    const staff = (
      await h.client.query<{ role: string; pin_hash: string; active: boolean }>(
        'select role, pin_hash, active from staff where id = $1',
        [staffId],
      )
    ).rows[0];

    expect(creds?.email).toBe('owner@example.test');
    expect(staff).toMatchObject({ role: 'owner', active: true });
    expect(creds?.password_hash).toMatch(/^scrypt\$/);
    expect(staff?.pin_hash).toMatch(/^scrypt\$/);
    // The secret is encrypted for this staff row and decrypts to the enrolled secret.
    expect(creds?.totp_secret_enc).toMatch(/^v1\./);
    expect(
      decryptSecret(creds?.totp_secret_enc ?? '', h.keys.totpKey, staffId).equals(secret),
    ).toBe(true);
    expect(() =>
      decryptSecret(creds?.totp_secret_enc ?? '', h.keys.totpKey, crypto.randomUUID()),
    ).toThrow();

    const hashes = creds?.recovery_code_hashes ?? [];
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const everything = JSON.stringify([creds, staff]);
    expect(everything).not.toContain(input.password);
    expect(everything).not.toContain(input.pin);
    expect(everything).not.toContain(secret.toString('base64url'));
    for (const code of recoveryCodes) expect(everything).not.toContain(code);
  });

  test('the owner can sign in with the enrolled authenticator, and with a recovery code', async () => {
    const code = hotp(secret, timeStep(h.clock.now().getTime()));
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: 'owner@example.test', password: input.password, totp: code },
      remoteAddress: h.nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staff: { id: staffId, role: 'owner' } });

    const byCode = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: {
        email: 'owner@example.test',
        password: input.password,
        recoveryCode: recoveryCodes[3],
      },
      remoteAddress: h.nextIp(),
    });
    expect(byCode.statusCode).toBe(200);
  });

  test('the owner can unlock a registered device with the daily PIN', async () => {
    const device = await h.newDevice();
    const token = await h.pinSession(device.token, staffId, input.pin);
    expect(token).toMatch(/^sds_ses_/);
  });

  test('writes an audit row', async () => {
    const audit = await h.auditRows(staffId);
    expect(audit.find((a) => a.action === 'owner.created')).toMatchObject({
      actorType: 'system',
      entity: 'staff',
    });
  });

  test('refuses a second owner and changes nothing', async () => {
    await expect(
      createOwner({ db: h.db, keys: h.keys }, { ...input, email: 'second@example.test' }),
    ).rejects.toBeInstanceOf(OwnerExistsError);
    const count = (
      await h.client.query<{ n: number }>(
        "select count(*)::int as n from staff where role = 'owner'",
      )
    ).rows[0];
    expect(count?.n).toBe(1);
  });
});

describe('createOwner input checks', () => {
  test.each([
    ['a short password', { password: 'too short' }],
    ['a malformed e-mail', { email: 'not-an-email' }],
    ['a PIN that is not 6 digits (the owner needs all 6)', { pin: '2468' }],
    ['a PIN that is too short', { pin: '12' }],
    ['an empty name', { displayName: '  ' }],
  ])('rejects %s before touching the database', async (_label, override) => {
    const error = await createOwner({ db: h.db, keys: h.keys }, { ...input, ...override }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_ERROR');
    expect((error as ApiError).message).not.toContain('too short');
  });
});
