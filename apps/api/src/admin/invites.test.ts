/**
 * D-23: an owner invites a person by e-mail and role; the person opens the single-use link,
 * chooses a password and a PIN, enrols an authenticator and gets recovery codes once.
 */
import {
  acceptInviteResponseSchema,
  createInviteResponseSchema,
  invitePreviewResponseSchema,
  listInvitesResponseSchema,
  listStaffResponseSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { hashToken } from '../auth/crypto.ts';
import { DEFAULT_AUTH_POLICY } from '../auth/policy.ts';
import { base32Decode, hotp, timeStep } from '../auth/totp.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

let h: Harness;
let owner: OwnerFixture;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner({ pin: '246810' });
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** A fresh owner session that has stepped up. Moves the clock so the TOTP codes are new. */
async function admin() {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
}

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string | undefined,
  body?: unknown,
  ip = h.nextIp(),
) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: ip,
  });
}

const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const PASSWORD = 'invitee-pass-phrase-1';

async function invite(token: string, body: Record<string, unknown>) {
  const res = await call('POST', '/v1/staff/invites', token, body);
  if (res.statusCode !== 201) throw new Error(`invite failed: ${res.statusCode} ${res.body}`);
  return createInviteResponseSchema.parse(res.json());
}

const preview = (linkToken: string, ip?: string) =>
  call('POST', '/v1/auth/invite/preview', undefined, { token: linkToken }, ip);

const codeFor = (secretBase32: string, stepsAhead = 0) =>
  hotp(base32Decode(secretBase32), timeStep(h.clock.now().getTime()) + stepsAhead);

function accept(linkToken: string, body: Record<string, unknown> = {}) {
  return call('POST', '/v1/auth/invite/accept', undefined, {
    token: linkToken,
    displayName: 'Invitee',
    password: PASSWORD,
    pin: '4821',
    totpCode: '000000',
    ...body,
  });
}

/** Previews, then accepts with the right code. Returns what the invitee holds afterwards. */
async function acceptFully(
  linkToken: string,
  extra: { pin?: string; displayName?: string; password?: string } = {},
) {
  const shown = invitePreviewResponseSchema.parse((await preview(linkToken)).json());
  const res = await accept(linkToken, {
    ...extra,
    totpCode: codeFor(shown.totp.secretBase32),
  });
  if (res.statusCode !== 200) throw new Error(`accept failed: ${res.statusCode} ${res.body}`);
  return {
    shown,
    secret: shown.totp.secretBase32,
    recoveryCodes: acceptInviteResponseSchema.parse(res.json()).recoveryCodes,
    password: extra.password ?? PASSWORD,
    pin: extra.pin ?? '4821',
  };
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await h.client.query<Record<string, unknown>>(sql, params)).rows;

describe('who may use the owner routes', () => {
  const routes = [
    ['GET', '/v1/staff/invites'],
    ['POST', '/v1/staff/invites'],
    ['POST', '/v1/staff/invites/0192f3a0-0000-7000-8000-000000000001/revoke'],
  ] as const;

  test('nobody without a session', async () => {
    for (const [method, url] of routes) {
      expect((await call(method, url, undefined, {})).statusCode, url).toBe(401);
    }
  });

  test('not a manager, cashier or kitchen, even after they step up', async () => {
    const device = await h.newDevice();
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const pin = role === 'manager' ? '246813' : '4821';
      const person = await h.newStaff(role, pin);
      const token = await h.pinSession(device.token, person.id, pin);
      await call('POST', '/v1/auth/step-up', token, { pin });
      for (const [method, url] of routes) {
        const res = await call(method, url, token, { email: email('x'), role: 'cashier' });
        expect(res.statusCode, `${role} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  test('the owner needs a fresh step-up: signing in is not enough', async () => {
    h.clock.advanceSeconds(90);
    const token = await h.ownerSession(owner);
    for (const [method, url] of routes) {
      const res = await call(method, url, token, { email: email('x'), role: 'cashier' });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
  });
});

describe('the whole invite, end to end', () => {
  test('invite, preview, accept; then the co-owner signs in, steps up and manages staff', async () => {
    const token = await admin();
    const address = email('co-owner');
    const created = await invite(token, {
      email: address.toUpperCase(),
      role: 'owner',
      displayName: 'Co Owner',
    });
    expect(created).toMatchObject({
      email: address,
      role: 'owner',
      displayName: 'Co Owner',
      status: 'open',
    });
    expect(created.token).toMatch(/^sds_inv_/);
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(72 * 3600 * 1000);

    // Only the hash is stored.
    const stored = await rows('select * from staff_invites where id = $1', [created.id]);
    expect(stored[0]?.token_hash).toBe(hashToken(created.token));
    expect(JSON.stringify(stored)).not.toContain(created.token);

    // The list shows it (no token) until it is accepted.
    const listed = listInvitesResponseSchema.parse(
      (await call('GET', '/v1/staff/invites', token)).json(),
    );
    const mine = listed.invites.find((i) => i.id === created.id);
    expect(mine).toEqual({ ...created, token: undefined });
    expect(JSON.stringify(listed)).not.toContain(created.token);

    // Preview: who they are invited as, and a fresh authenticator secret.
    const shown = invitePreviewResponseSchema.parse((await preview(created.token)).json());
    expect(shown).toMatchObject({ email: address, role: 'owner', displayName: 'Co Owner' });
    expect(shown.totp.otpauthUri).toContain(`secret=${shown.totp.secretBase32}`);
    const afterPreview = await rows(
      'select pending_totp_secret_enc from staff_invites where id = $1',
      [created.id],
    );
    const pending = String(afterPreview[0]?.pending_totp_secret_enc);
    expect(pending).toMatch(/^v1\./); // encrypted, not the secret
    expect(pending).not.toContain(shown.totp.secretBase32);

    // Accept.
    const acceptCode = codeFor(shown.totp.secretBase32);
    const accepted = await accept(created.token, {
      displayName: 'Co-owner',
      pin: '135790',
      totpCode: acceptCode,
    });
    expect(accepted.statusCode).toBe(200);
    const { recoveryCodes } = acceptInviteResponseSchema.parse(accepted.json());
    expect(recoveryCodes).toHaveLength(8);
    expect(new Set(recoveryCodes).size).toBe(8);
    expect(accepted.headers['cache-control']).toBe('no-store');

    // The invite is used up: gone from the list, and its link answers like any bad link.
    const after = listInvitesResponseSchema.parse(
      (await call('GET', '/v1/staff/invites', token)).json(),
    );
    expect(after.invites.some((i) => i.id === created.id)).toBe(false);
    expect((await preview(created.token)).statusCode).toBe(404);
    expect((await accept(created.token, { totpCode: acceptCode })).statusCode).toBe(404);
    const leftover = await rows('select pending_totp_secret_enc from staff_invites where id = $1', [
      created.id,
    ]);
    expect(leftover[0]?.pending_totp_secret_enc).toBeNull();

    // E-mail sign-in. The code used at accept cannot be used again (RFC 6238); the next one can.
    const login = (totp: string) =>
      call('POST', '/v1/auth/owner', undefined, { email: address, password: PASSWORD, totp });
    expect((await login(acceptCode)).statusCode).toBe(401);
    h.clock.advanceSeconds(30);
    const session = await login(codeFor(shown.totp.secretBase32));
    expect(session.statusCode).toBe(200);
    const coOwnerToken = (session.json() as { sessionToken: string }).sessionToken;
    expect(session.json()).toMatchObject({ staff: { role: 'owner', displayName: 'Co-owner' } });

    // PIN sign-in on a registered device.
    const [staffRow] = await rows(
      'select s.id from staff s join owner_credentials c on c.staff_id = s.id where c.email = $1',
      [address],
    );
    const staffId = String(staffRow?.id);
    const device = await h.newDevice();
    const pinLogin = await call('POST', '/v1/auth/pin', undefined, { staffId, pin: '135790' });
    expect(pinLogin.statusCode).toBe(401); // no device token: refused
    const withDevice = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/pin',
      headers: { 'x-device-token': device.token },
      payload: { staffId, pin: '135790' },
      remoteAddress: h.nextIp(),
    });
    expect(withDevice.statusCode).toBe(200);

    // Step-up for the co-owner: password + the next authenticator code.
    h.clock.advanceSeconds(30);
    const stepUp = await call('POST', '/v1/auth/step-up', coOwnerToken, {
      password: PASSWORD,
      totp: codeFor(shown.totp.secretBase32),
    });
    expect(stepUp.statusCode).toBe(200);

    // ...and then the co-owner can manage staff like the first owner.
    const made = await call('POST', '/v1/staff', coOwnerToken, {
      displayName: 'น้อย',
      role: 'cashier',
      pin: '4821',
    });
    expect(made.statusCode).toBe(201);
    const list = listStaffResponseSchema.parse(
      (await call('GET', '/v1/staff', coOwnerToken)).json(),
    );
    expect(list.staff.find((s) => s.id === staffId)).toMatchObject({
      email: address,
      role: 'owner',
      hasPin: true,
      active: true,
    });
    expect(list.staff.find((s) => s.displayName === 'น้อย')?.email).toBeNull();
    // The co-owner is audited under the system actor, and the owners were alerted.
    const audit = (await h.auditRows(staffId)).find((a) => a.action === 'staff.invite_accepted');
    expect(audit).toMatchObject({ actorType: 'system', entity: 'staff' });
    expect(h.alerts.some((a) => a.kind === 'staff.invite_accepted' && a.staffId === staffId)).toBe(
      true,
    );
    expect(h.alerts.some((a) => a.kind === 'staff.invited')).toBe(true);

    // Recovery codes work once each, as for the first owner.
    h.clock.advanceSeconds(30);
    const byCode = (code: string) =>
      call('POST', '/v1/auth/owner', undefined, {
        email: address,
        password: PASSWORD,
        recoveryCode: code,
      });
    expect((await byCode(recoveryCodes[0] ?? '')).statusCode).toBe(200);
    expect((await byCode(recoveryCodes[0] ?? '')).statusCode).toBe(401);
  }, 60_000);

  test('a manager invite: the role comes from the invite, a 6-digit PIN is needed, step-up is by PIN', async () => {
    const token = await admin();
    const created = await invite(token, { email: email('mgr'), role: 'manager' });
    const shown = invitePreviewResponseSchema.parse((await preview(created.token)).json());
    const code = codeFor(shown.totp.secretBase32);

    // 4 digits are too few for a manager: 400 on `pin`, and the failure is not counted.
    const short = await accept(created.token, { pin: '4821', totpCode: code });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(short.json())).toContain('"path":"pin"');
    const [row] = await rows('select failed_attempts from staff_invites where id = $1', [
      created.id,
    ]);
    expect(row?.failed_attempts).toBe(0);

    // The body cannot name a role.
    const sneaky = await accept(created.token, { pin: '246813', totpCode: code, role: 'owner' });
    expect(sneaky.statusCode).toBe(400);

    expect((await accept(created.token, { pin: '246813', totpCode: code })).statusCode).toBe(200);
    const [person] = await rows(
      'select s.id, s.role from staff s join owner_credentials c on c.staff_id = s.id where c.email = $1',
      [created.email],
    );
    expect(person?.role).toBe('manager');

    // A manager steps up with the PIN, not the password.
    h.clock.advanceSeconds(30);
    const session = await call('POST', '/v1/auth/owner', undefined, {
      email: created.email,
      password: PASSWORD,
      totp: codeFor(shown.totp.secretBase32),
    });
    expect(session.statusCode).toBe(200);
    const managerToken = (session.json() as { sessionToken: string }).sessionToken;
    expect(
      (await call('POST', '/v1/auth/step-up', managerToken, { pin: '246813' })).statusCode,
    ).toBe(200);
    // Only owners manage staff.
    expect((await call('GET', '/v1/staff/invites', managerToken)).statusCode).toBe(403);
  }, 60_000);
});

describe('creating and revoking invites', () => {
  test('one open invite per e-mail, and an existing account cannot be invited', async () => {
    const token = await admin();
    const address = email('dup');
    await invite(token, { email: address, role: 'cashier' });
    const again = await call('POST', '/v1/staff/invites', token, {
      email: address.toUpperCase(),
      role: 'manager',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'INVITE_EXISTS' });

    const taken = await call('POST', '/v1/staff/invites', token, {
      email: owner.email,
      role: 'cashier',
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'EMAIL_TAKEN' });

    // Bad input: not an e-mail, an unknown role, unknown fields.
    for (const body of [
      { email: 'nope', role: 'cashier' },
      { email: email('x'), role: 'admin' },
      { email: email('x'), role: 'cashier', token: 'sds_inv_x' },
    ]) {
      expect((await call('POST', '/v1/staff/invites', token, body)).statusCode).toBe(400);
    }
  });

  test('revoking stops the link and frees the e-mail; revoking twice is harmless; unknown is 404', async () => {
    const token = await admin();
    const address = email('revoke');
    const created = await invite(token, { email: address, role: 'cashier' });
    const url = `/v1/staff/invites/${created.id}/revoke`;
    expect((await call('POST', url, token)).statusCode).toBe(204);
    expect((await call('POST', url, token)).statusCode).toBe(204);
    const audits = (await h.auditRows(created.id)).filter(
      (a) => a.action === 'staff.invite_revoke',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'staff', actorId: owner.staffId });
    expect(h.alerts.some((a) => a.kind === 'staff.invite_revoked')).toBe(true);

    expect((await preview(created.token)).statusCode).toBe(404);
    const list = listInvitesResponseSchema.parse(
      (await call('GET', '/v1/staff/invites', token)).json(),
    );
    expect(list.invites.some((i) => i.id === created.id)).toBe(false);
    await invite(token, { email: address, role: 'cashier' }); // free again

    expect(
      (await call('POST', '/v1/staff/invites/0192f3a0-0000-7000-8000-000000000001/revoke', token))
        .statusCode,
    ).toBe(404);
    expect((await call('POST', '/v1/staff/invites/not-a-uuid/revoke', token)).statusCode).toBe(400);
  });

  test('an accepted invite cannot be revoked', async () => {
    const token = await admin();
    const created = await invite(token, { email: email('done'), role: 'kitchen' });
    await acceptFully(created.token);
    const res = await call('POST', `/v1/staff/invites/${created.id}/revoke`, token);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVITE_ACCEPTED' });
  }, 30_000);

  test('an expired invite shows as expired, and a new invite for the e-mail replaces it', async () => {
    const token = await admin();
    const address = email('late');
    const old = await invite(token, { email: address, role: 'cashier' });
    h.clock.advanceSeconds(72 * 3600 + 1);
    const fresh = await admin();

    const list = listInvitesResponseSchema.parse(
      (await call('GET', '/v1/staff/invites', fresh)).json(),
    );
    expect(list.invites.find((i) => i.id === old.id)?.status).toBe('expired');

    const replacement = await invite(fresh, { email: address, role: 'manager' });
    expect(replacement.status).toBe('open');
    const after = listInvitesResponseSchema.parse(
      (await call('GET', '/v1/staff/invites', fresh)).json(),
    );
    expect(after.invites.some((i) => i.id === old.id)).toBe(false);
    expect(after.invites.find((i) => i.id === replacement.id)?.role).toBe('manager');
    expect((await h.auditRows(old.id)).map((a) => a.action)).toContain('staff.invite_revoke');
  });
});

describe('a link that does not work', () => {
  test('unknown, expired, used and revoked tokens all get the same answer, on both routes', async () => {
    const token = await admin();
    const expired = await invite(token, { email: email('e'), role: 'cashier' });
    const revoked = await invite(token, { email: email('r'), role: 'cashier' });
    const used = await invite(token, { email: email('u'), role: 'cashier' });
    await call('POST', `/v1/staff/invites/${revoked.id}/revoke`, token);
    await acceptFully(used.token);
    h.clock.advanceSeconds(72 * 3600 + 1);

    const answers: { status: number; body: unknown }[] = [];
    for (const link of ['sds_inv_never-issued', expired.token, revoked.token, used.token]) {
      const p = await preview(link);
      const a = await accept(link);
      answers.push(
        { status: p.statusCode, body: p.json() },
        { status: a.statusCode, body: a.json() },
      );
    }
    expect(new Set(answers.map((x) => x.status))).toEqual(new Set([404]));
    const first = answers[0];
    for (const answer of answers) expect(answer).toEqual(first);
    expect(first?.body).toMatchObject({ code: 'INVITE_INVALID', details: {} });
  }, 60_000);

  test('a body that is not valid is a 400, not a way to learn anything', async () => {
    expect((await call('POST', '/v1/auth/invite/preview', undefined, {})).statusCode).toBe(400);
    expect(
      (await call('POST', '/v1/auth/invite/accept', undefined, { token: 'x' })).statusCode,
    ).toBe(400);
  });
});

describe('the authenticator step at accept', () => {
  test('a wrong code is refused and counted; the invite is revoked at the limit, whatever code follows', async () => {
    const token = await admin();
    const created = await invite(token, { email: email('guess'), role: 'cashier' });
    const shown = invitePreviewResponseSchema.parse((await preview(created.token)).json());
    const right = codeFor(shown.totp.secretBase32);
    const wrong = right === '000000' ? '000001' : '000000';

    for (let i = 1; i < DEFAULT_AUTH_POLICY.inviteMaxFailures; i++) {
      const res = await accept(created.token, { totpCode: wrong });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'INVITE_CODE_INVALID' });
    }
    const [counted] = await rows(
      'select failed_attempts, revoked_at from staff_invites where id = $1',
      [created.id],
    );
    expect(counted?.failed_attempts).toBe(DEFAULT_AUTH_POLICY.inviteMaxFailures - 1);
    expect(counted?.revoked_at).toBeNull();

    // The attempt that reaches the limit revokes the invite; even the right code is too late.
    expect((await accept(created.token, { totpCode: wrong })).statusCode).toBe(422);
    expect((await accept(created.token, { totpCode: right })).statusCode).toBe(404);
    expect((await preview(created.token)).statusCode).toBe(404);
    expect(
      (await h.auditRows(created.id))
        .map((a) => a.action)
        .filter((a) => a.startsWith('staff.invite_')),
    ).toContain('staff.invite_locked');
    expect(h.alerts.some((a) => a.kind === 'staff.invite_locked')).toBe(true);
    const made = await rows('select 1 from owner_credentials where email = $1', [created.email]);
    expect(made).toHaveLength(0);
  }, 30_000);

  test('accepting without a preview fails, and a repeat preview shows the same secret', async () => {
    const token = await admin();
    const created = await invite(token, { email: email('stale'), role: 'cashier' });
    // No preview yet: there is no secret to check a code against.
    expect((await accept(created.token, { totpCode: '123456' })).statusCode).toBe(422);

    const first = invitePreviewResponseSchema.parse((await preview(created.token)).json());
    const second = invitePreviewResponseSchema.parse((await preview(created.token)).json());
    // A repeat preview (a second tab) shows the same secret, so the tabs do not break each other.
    expect(second.totp.secretBase32).toBe(first.totp.secretBase32);
    expect(
      (await accept(created.token, { totpCode: codeFor(second.totp.secretBase32) })).statusCode,
    ).toBe(200);
  }, 30_000);
});

describe('what is kept out of the audit log, alerts and logs', () => {
  test('no token, hash, authenticator secret, password, PIN or recovery code appears', async () => {
    const token = await admin();
    const created = await invite(token, { email: email('quiet'), role: 'owner' });
    const held = await acceptFully(created.token, { pin: '975310' });
    // A failed attempt and a revoke leave rows too.
    const other = await invite(token, { email: email('quiet2'), role: 'cashier' });
    await preview(other.token);
    await accept(other.token, { totpCode: '000000' });
    await call('POST', `/v1/staff/invites/${other.id}/revoke`, token);

    const everything = JSON.stringify([
      await rows('select * from audit_log'),
      h.alerts,
      h.events,
      h.logs(),
    ]);
    for (const secret of [
      created.token,
      hashToken(created.token),
      other.token,
      hashToken(other.token),
      held.secret,
      held.shown.totp.otpauthUri,
      held.password,
      held.pin,
      ...held.recoveryCodes,
    ]) {
      expect(everything).not.toContain(secret);
    }
    // Neither does the e-mail go to the audit log: it stays on the invite and the account.
    expect(JSON.stringify(await rows('select * from audit_log'))).not.toContain(created.email);
  }, 60_000);
});

describe('a stale actor (no longer an active owner)', () => {
  test('cannot create or revoke an invite', async () => {
    const lone = await createHarness();
    try {
      const a = await lone.newOwner({ pin: '864209' });
      await lone.newOwner({ pin: '753197' });
      const aToken = await lone.steppedUpOwner(a);
      const bystander = await lone.newOwner();
      const bToken = await lone.steppedUpOwner(bystander);
      const made = await lone.app.inject({
        method: 'POST',
        url: '/v1/staff/invites',
        headers: { authorization: `Bearer ${bToken}` },
        payload: { email: 'later@example.test', role: 'cashier' },
        remoteAddress: lone.nextIp(),
      });
      expect(made.statusCode).toBe(201);
      const inviteId = (made.json() as { id: string }).id;
      // The route guard read A as an owner; A is demoted before the transaction (simulated by
      // calling the service with that earlier principal).
      await lone.client.query("update staff set role = 'manager' where id = $1", [a.staffId]);
      const { createInvite, revokeInvite } = await import('./invites.ts');
      const { DEFAULT_AUTH_POLICY } = await import('../auth/policy.ts');
      const ctx = {
        db: lone.db,
        keys: lone.keys,
        policy: DEFAULT_AUTH_POLICY,
        now: lone.clock.now,
        events: lone.bus,
      };
      const stale = {
        sessionId: crypto.randomUUID(),
        staffId: a.staffId,
        displayName: 'stale',
        role: 'owner' as const,
        kind: 'owner' as const,
        deviceId: null,
        expiresAt: new Date(lone.clock.now().getTime() + 3_600_000),
        stepUpUntil: new Date(lone.clock.now().getTime() + 3_600_000),
      };
      await expect(
        createInvite(ctx, stale, { email: 'x@example.test', role: 'owner' }, { ip: null }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      await expect(revokeInvite(ctx, stale, inviteId, { ip: null })).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
      expect(aToken).toBeTruthy();
      const rows = await lone.client.query('select 1 from staff_invites where revoked_at is null');
      expect(rows.rows).toHaveLength(1);
    } finally {
      await lone.close();
    }
  }, 60_000);
});

describe('rate limits on the public routes', () => {
  test('ten requests per IP per minute, then 429; another IP is unaffected', async () => {
    const ip = '203.0.113.77';
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await preview('sds_inv_nope', ip)).statusCode);
    expect(codes.filter((c) => c === 404)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect((await preview('sds_inv_nope', '203.0.113.78')).statusCode).toBe(404);
  });

  test('a global bucket caps all callers together', async () => {
    const small = await createHarness({ policy: { inviteGlobalRatePerMinute: 3 } });
    try {
      const send = (n: number) =>
        small.app.inject({
          method: 'POST',
          url: '/v1/auth/invite/preview',
          payload: { token: 'sds_inv_nope' },
          remoteAddress: `198.51.100.${n}`,
        });
      const codes: number[] = [];
      for (let n = 1; n <= 5; n++) codes.push((await send(n)).statusCode);
      expect(codes).toEqual([404, 404, 404, 429, 429]);
    } finally {
      await small.close();
    }
  }, 60_000);
});
