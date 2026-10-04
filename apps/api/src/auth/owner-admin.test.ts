import { describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { deriveAuthKeys, encryptSecret } from './crypto.ts';
import {
  findOwnerForCommand,
  MultipleOwnersError,
  NoOwnerError,
  resetOwnerSecondFactor,
  unlockOwner,
  verifyOwnerProof,
} from './owner-admin.ts';
import { generateTotpSecret, hotp, timeStep } from './totp.ts';

// These functions act on THE owner, so every test gets its own database with exactly one.
async function withOwner(run: (h: Harness, owner: OwnerFixture) => Promise<void>) {
  const h = await createHarness();
  try {
    await run(h, await h.newOwner());
  } finally {
    await h.close();
  }
}

const ctx = (h: Harness) => ({ db: h.db, keys: h.keys, now: h.clock.now });

const login = (h: Harness, body: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/v1/auth/owner', payload: body, remoteAddress: h.nextIp() });

const stepNow = (h: Harness) => timeStep(h.clock.now().getTime());

describe('verifyOwnerProof', () => {
  test('accepts the password or a recovery code without using the code up', async () => {
    await withOwner(async (h, owner) => {
      expect(await verifyOwnerProof({ db: h.db }, owner.password)).toBe(true);
      const code = owner.recoveryCodes[0] ?? '';
      expect(await verifyOwnerProof({ db: h.db }, code)).toBe(true);
      expect(await verifyOwnerProof({ db: h.db }, code)).toBe(true);
      // The code is still good for a real sign-in.
      const res = await login(h, {
        email: owner.email,
        password: owner.password,
        recoveryCode: code,
      });
      expect(res.statusCode).toBe(200);
    });
  }, 120_000); // five scrypt checks: 30 s is not enough when every package runs its tests at once

  test('refuses anything else and records the refusal', async () => {
    await withOwner(async (h, owner) => {
      expect(await verifyOwnerProof({ db: h.db }, 'nope')).toBe(false);
      expect(await verifyOwnerProof({ db: h.db }, 'ABCD-EFGH-JKLM-NPQR')).toBe(false);
      const refused = (await h.auditRows(owner.staffId)).filter(
        (a) => a.action === 'owner.reset_refused',
      );
      expect(refused).toHaveLength(2);
    });
  }, 30_000);
});

describe('resetOwnerSecondFactor (owner:reset)', () => {
  test('refuses a wrong proof, changes nothing and records the refusal', async () => {
    await withOwner(async (h, owner) => {
      const result = await resetOwnerSecondFactor(ctx(h), {
        proof: 'not the password',
        newTotpSecret: generateTotpSecret(),
      });
      expect(result).toEqual({ ok: false });
      expect((await h.auditRows(owner.staffId)).map((a) => a.action)).toContain(
        'owner.reset_refused',
      );
      const stillWorks = await login(h, {
        email: owner.email,
        password: owner.password,
        totp: owner.totp(),
      });
      expect(stillWorks.statusCode).toBe(200);
    });
  }, 30_000);

  test('with the password: new authenticator, new recovery codes, old ones and old sessions dead', async () => {
    await withOwner(async (h, owner) => {
      const session = await h.ownerSession(owner);
      const newSecret = generateTotpSecret();

      const result = await resetOwnerSecondFactor(ctx(h), {
        proof: owner.password,
        newTotpSecret: newSecret,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.recoveryCodes).toHaveLength(8);
      expect(new Set(result.recoveryCodes).size).toBe(8);
      expect((await h.probe(session)).statusCode).toBe(401);

      h.clock.advanceSeconds(60); // past the step the first sign-in used
      const step = stepNow(h);
      const old = { email: owner.email, password: owner.password };
      expect((await login(h, { ...old, totp: hotp(owner.totpSecret, step) })).statusCode).toBe(401);
      expect((await login(h, { ...old, recoveryCode: owner.recoveryCodes[0] })).statusCode).toBe(
        401,
      );
      expect((await login(h, { ...old, totp: hotp(newSecret, step) })).statusCode).toBe(200);
      expect((await login(h, { ...old, recoveryCode: result.recoveryCodes[0] })).statusCode).toBe(
        200,
      );

      const audit = (await h.auditRows(owner.staffId)).find((a) => a.action === 'owner.reset');
      expect(audit).toMatchObject({ actorType: 'system', entity: 'staff' });
      expect(JSON.stringify(audit)).not.toContain(newSecret.toString('base64url'));
      for (const code of result.recoveryCodes) expect(JSON.stringify(audit)).not.toContain(code);
    });
  }, 30_000);

  test('a valid recovery code is accepted as proof, even with the TOTP key lost', async () => {
    await withOwner(async (h, owner) => {
      const otherKeys = deriveAuthKeys(Buffer.alloc(32, 3));
      await h.client.query(
        'update owner_credentials set totp_secret_enc = $1 where staff_id = $2',
        [encryptSecret(owner.totpSecret, otherKeys.totpKey, owner.staffId), owner.staffId],
      );
      const newSecret = generateTotpSecret();
      const result = await resetOwnerSecondFactor(ctx(h), {
        proof: owner.recoveryCodes[2] ?? '',
        newTotpSecret: newSecret,
      });
      expect(result.ok).toBe(true);
      const res = await login(h, {
        email: owner.email,
        password: owner.password,
        totp: hotp(newSecret, stepNow(h)),
      });
      expect(res.statusCode).toBe(200);
    });
  }, 30_000);

  test('clears a lock', async () => {
    await withOwner(async (h, owner) => {
      for (let i = 0; i < 5; i++) {
        await login(h, { email: owner.email, password: 'wrong-wrong-wrong', totp: '000000' });
      }
      const newSecret = generateTotpSecret();
      const result = await resetOwnerSecondFactor(ctx(h), {
        proof: owner.password,
        newTotpSecret: newSecret,
      });
      expect(result.ok).toBe(true);
      const res = await login(h, {
        email: owner.email,
        password: owner.password,
        totp: hotp(newSecret, stepNow(h)),
      });
      expect(res.statusCode).toBe(200);
    });
  }, 30_000);
});

describe('unlockOwner (owner:unlock)', () => {
  test('lets a locked owner sign in again and records it', async () => {
    await withOwner(async (h, owner) => {
      for (let i = 0; i < 5; i++) {
        await login(h, { email: owner.email, password: 'wrong-wrong-wrong', totp: '000000' });
      }
      const right = { email: owner.email, password: owner.password, totp: owner.totp() };
      expect((await login(h, right)).statusCode).not.toBe(200);

      await unlockOwner(ctx(h));
      expect((await login(h, right)).statusCode).toBe(200);
      const audit = (await h.auditRows(owner.staffId)).find((a) => a.action === 'owner.unlocked');
      expect(audit).toMatchObject({ actorType: 'system', entity: 'staff' });
    });
  }, 30_000);
});

describe('with no owner', () => {
  test('both refuse', async () => {
    const empty = await createHarness();
    try {
      await expect(
        resetOwnerSecondFactor(ctx(empty), { proof: 'x', newTotpSecret: generateTotpSecret() }),
      ).rejects.toBeInstanceOf(NoOwnerError);
      await expect(unlockOwner(ctx(empty))).rejects.toBeInstanceOf(NoOwnerError);
    } finally {
      await empty.close();
    }
  }, 30_000);
});

describe('with several owners (D-23)', () => {
  async function withTwoOwners(
    run: (h: Harness, a: OwnerFixture, b: OwnerFixture) => Promise<void>,
  ) {
    const h = await createHarness();
    try {
      await run(h, await h.newOwner(), await h.newOwner());
    } finally {
      await h.close();
    }
  }

  test('without --email every command refuses and says only how many owners there are', async () => {
    await withTwoOwners(async (h, a, b) => {
      const refusals = [
        verifyOwnerProof({ db: h.db }, a.password),
        resetOwnerSecondFactor(ctx(h), { proof: a.password, newTotpSecret: generateTotpSecret() }),
        unlockOwner(ctx(h)),
        findOwnerForCommand({ db: h.db }),
      ];
      for (const refusal of refusals) {
        const error = await refusal.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MultipleOwnersError);
        expect((error as MultipleOwnersError).count).toBe(2);
        expect((error as Error).message).not.toContain(a.email);
        expect((error as Error).message).not.toContain(b.email);
      }
      // Nothing was changed or audited by the refusals.
      expect(await h.auditRows(a.staffId)).toHaveLength(0);
      expect(await h.auditRows(b.staffId)).toHaveLength(0);
    });
  }, 60_000);

  test('--email picks the owner (any case); the other owner is untouched', async () => {
    await withTwoOwners(async (h, a, b) => {
      for (let i = 0; i < 5; i++) {
        await login(h, { email: a.email, password: 'wrong-wrong-wrong', totp: '000000' });
        await login(h, { email: b.email, password: 'wrong-wrong-wrong', totp: '000000' });
      }
      await unlockOwner(ctx(h), ` ${b.email.toUpperCase()} `);
      expect(
        (await login(h, { email: b.email, password: b.password, totp: b.totp() })).statusCode,
      ).toBe(200);
      expect(
        (await login(h, { email: a.email, password: a.password, totp: a.totp() })).statusCode,
      ).not.toBe(200); // still locked
      expect((await h.auditRows(b.staffId)).map((r) => r.action)).toContain('owner.unlocked');
      expect((await h.auditRows(a.staffId)).map((r) => r.action)).not.toContain('owner.unlocked');
    });
  }, 60_000);

  test('owner:reset with --email replaces only that owner second factor', async () => {
    await withTwoOwners(async (h, a, b) => {
      const found = await findOwnerForCommand({ db: h.db }, b.email);
      expect(found.staffId).toBe(b.staffId);
      expect(await verifyOwnerProof({ db: h.db }, b.password, b.email)).toBe(true);
      // The password of the OTHER owner is not proof for this one.
      expect(await verifyOwnerProof({ db: h.db }, a.password, b.email)).toBe(false);

      const newSecret = generateTotpSecret();
      const result = await resetOwnerSecondFactor(ctx(h), {
        proof: b.password,
        newTotpSecret: newSecret,
        email: b.email,
      });
      expect(result.ok).toBe(true);
      h.clock.advanceSeconds(60);
      const step = stepNow(h);
      expect(
        (await login(h, { email: b.email, password: b.password, totp: hotp(newSecret, step) }))
          .statusCode,
      ).toBe(200);
      expect(
        (await login(h, { email: a.email, password: a.password, totp: hotp(a.totpSecret, step) }))
          .statusCode,
      ).toBe(200);
    });
  }, 60_000);

  test('an e-mail that is not an owner, or does not exist, answers like no owner', async () => {
    await withTwoOwners(async (h) => {
      await expect(unlockOwner(ctx(h), 'nobody@example.test')).rejects.toBeInstanceOf(NoOwnerError);
      // A manager with an e-mail account is not an owner.
      const manager = await h.newOwner();
      await h.client.query("update staff set role = 'manager' where id = $1", [manager.staffId]);
      await expect(unlockOwner(ctx(h), manager.email)).rejects.toBeInstanceOf(NoOwnerError);
    });
  }, 60_000);

  test('a second owner who is not signed up by e-mail does not count', async () => {
    const h = await createHarness();
    try {
      const only = await h.newOwner();
      await h.client.query(
        "insert into staff (display_name, role) values ('owner without e-mail', 'owner')",
      );
      await expect(unlockOwner(ctx(h))).resolves.toBeUndefined(); // still exactly one owner account
      expect((await h.auditRows(only.staffId)).map((r) => r.action)).toContain('owner.unlocked');
    } finally {
      await h.close();
    }
  }, 30_000);
});
