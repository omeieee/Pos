import { describe, expect, test } from 'vitest';
import {
  acceptInviteInputSchema,
  changeRoleInputSchema,
  createInviteInputSchema,
  createInviteResponseSchema,
  createStaffInputSchema,
  deviceDtoSchema,
  idParamSchema,
  inviteDtoSchema,
  invitePreviewInputSchema,
  invitePreviewResponseSchema,
  patchStaffInputSchema,
  setStaffPinInputSchema,
  staffDtoSchema,
} from './admin.ts';

const uuid = '0192f3a0-0000-7000-8000-000000000001';

describe('createStaffInputSchema', () => {
  test('a cashier or kitchen member may have a 4-digit PIN', () => {
    for (const role of ['cashier', 'kitchen'] as const) {
      expect(
        createStaffInputSchema.safeParse({ displayName: 'น้อย', role, pin: '1234' }).success,
      ).toBe(true);
    }
  });

  test('a manager needs 6 digits', () => {
    const manager = { displayName: 'หัวหน้า', role: 'manager' };
    expect(createStaffInputSchema.safeParse({ ...manager, pin: '123456' }).success).toBe(true);
    expect(createStaffInputSchema.safeParse({ ...manager, pin: '1234' }).success).toBe(false);
    expect(createStaffInputSchema.safeParse({ ...manager, pin: '12345' }).success).toBe(false);
  });

  test('the owner cannot be created here (that is the owner:create command)', () => {
    expect(
      createStaffInputSchema.safeParse({ displayName: 'x', role: 'owner', pin: '123456' }).success,
    ).toBe(false);
  });

  test('trims the name and refuses an empty or very long one', () => {
    expect(
      createStaffInputSchema.parse({ displayName: '  น้อย ', role: 'cashier', pin: '1234' })
        .displayName,
    ).toBe('น้อย');
    expect(
      createStaffInputSchema.safeParse({ displayName: ' ', role: 'cashier', pin: '1234' }).success,
    ).toBe(false);
    expect(
      createStaffInputSchema.safeParse({
        displayName: 'x'.repeat(61),
        role: 'cashier',
        pin: '1234',
      }).success,
    ).toBe(false);
  });

  test('refuses fields it does not know, such as a pre-hashed PIN', () => {
    expect(
      createStaffInputSchema.safeParse({
        displayName: 'x',
        role: 'cashier',
        pin: '1234',
        pinHash: 'abc',
      }).success,
    ).toBe(false);
  });
});

describe('setStaffPinInputSchema', () => {
  test('takes a 4 to 6 digit PIN; the role-specific length is checked against the person', () => {
    expect(setStaffPinInputSchema.safeParse({ pin: '1234' }).success).toBe(true);
    expect(setStaffPinInputSchema.safeParse({ pin: '123' }).success).toBe(false);
    expect(setStaffPinInputSchema.safeParse({ pin: 'abcd' }).success).toBe(false);
  });
});

describe('patchStaffInputSchema', () => {
  test('needs the version and something to change', () => {
    expect(patchStaffInputSchema.safeParse({ expectedVersion: 1, active: false }).success).toBe(
      true,
    );
    expect(
      patchStaffInputSchema.safeParse({ expectedVersion: 1, displayName: 'ใหม่' }).success,
    ).toBe(true);
    expect(patchStaffInputSchema.safeParse({ active: false }).success).toBe(false);
    expect(patchStaffInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  test('refuses a role change and anything else', () => {
    for (const field of ['role', 'pin', 'pinHash', 'id']) {
      expect(
        patchStaffInputSchema.safeParse({ expectedVersion: 1, active: true, [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });
});

describe('response shapes', () => {
  test('a device has no token, hash or secret field', () => {
    expect(Object.keys(deviceDtoSchema.shape).join()).not.toMatch(/token|hash|secret/i);
    expect(
      deviceDtoSchema.safeParse({
        id: uuid,
        name: 'iPad',
        kind: 'ipad',
        lastSeenAt: null,
        revokedAt: null,
        version: 1,
      }).success,
    ).toBe(true);
  });

  test('a staff member shows whether they have a PIN, never the PIN or its counters', () => {
    expect(Object.keys(staffDtoSchema.shape).join()).not.toMatch(/hash|secret|failed|level/i);
    expect(
      staffDtoSchema.safeParse({
        id: uuid,
        displayName: 'น้อย',
        role: 'cashier',
        active: true,
        email: null,
        hasPin: true,
        pinLockedUntil: null,
        version: 3,
      }).success,
    ).toBe(true);
    // The e-mail is required (null for PIN-only staff), so the UI never has to guess.
    expect(
      staffDtoSchema.safeParse({
        id: uuid,
        displayName: 'น้อย',
        role: 'cashier',
        active: true,
        hasPin: true,
        pinLockedUntil: null,
        version: 3,
      }).success,
    ).toBe(false);
  });

  test('an id parameter must be a uuid', () => {
    expect(idParamSchema.safeParse({ id: uuid }).success).toBe(true);
    expect(idParamSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});

describe('invites (D-23)', () => {
  test('an invite takes any role, lower-cases the e-mail and refuses extra fields', () => {
    for (const role of ['owner', 'manager', 'cashier', 'kitchen']) {
      expect(createInviteInputSchema.safeParse({ email: 'a@example.test', role }).success).toBe(
        true,
      );
    }
    expect(
      createInviteInputSchema.parse({ email: '  Co.Owner@Example.TEST ', role: 'owner' }),
    ).toEqual({ email: 'co.owner@example.test', role: 'owner' });
    expect(createInviteInputSchema.safeParse({ email: 'nope', role: 'cashier' }).success).toBe(
      false,
    );
    expect(
      createInviteInputSchema.safeParse({ email: 'a@example.test', role: 'admin' }).success,
    ).toBe(false);
    expect(
      createInviteInputSchema.safeParse({ email: 'a@example.test', role: 'cashier', extra: 1 })
        .success,
    ).toBe(false);
    expect(
      createInviteInputSchema.parse({
        email: 'a@example.test',
        role: 'cashier',
        displayName: ' น้อย ',
      }).displayName,
    ).toBe('น้อย');
  });

  test('the DTO has no hash and only open or expired as status; the response adds the token', () => {
    const dto = {
      id: uuid,
      email: 'a@example.test',
      role: 'manager',
      displayName: null,
      createdAt: '2026-10-04T03:00:00.000Z',
      expiresAt: '2026-10-07T03:00:00.000Z',
      status: 'open',
    };
    expect(inviteDtoSchema.safeParse(dto).success).toBe(true);
    expect(inviteDtoSchema.safeParse({ ...dto, status: 'accepted' }).success).toBe(false);
    expect(Object.keys(inviteDtoSchema.shape).join()).not.toMatch(/hash|secret|token/i);
    expect(createInviteResponseSchema.safeParse({ ...dto, token: 'sds_inv_x' }).success).toBe(true);
    expect(createInviteResponseSchema.safeParse(dto).success).toBe(false);
  });

  test('preview takes only a token and answers with the e-mail, role and authenticator secret', () => {
    expect(invitePreviewInputSchema.safeParse({ token: 'sds_inv_x' }).success).toBe(true);
    expect(invitePreviewInputSchema.safeParse({ token: '' }).success).toBe(false);
    expect(invitePreviewInputSchema.safeParse({ token: 'x', role: 'owner' }).success).toBe(false);
    expect(
      invitePreviewResponseSchema.safeParse({
        email: 'a@example.test',
        role: 'cashier',
        displayName: null,
        totp: { secretBase32: 'ABCDEFGH', otpauthUri: 'otpauth://totp/x' },
      }).success,
    ).toBe(true);
  });

  test('accept needs a 12+ character password, a 4-6 digit PIN and a 6-digit code; no role in the body', () => {
    const body = {
      token: 'sds_inv_x',
      displayName: 'น้อย',
      password: 'a-long-enough-password',
      pin: '4821',
      totpCode: '123456',
    };
    expect(acceptInviteInputSchema.safeParse(body).success).toBe(true);
    expect(acceptInviteInputSchema.safeParse({ ...body, password: 'short' }).success).toBe(false);
    expect(acceptInviteInputSchema.safeParse({ ...body, pin: '123' }).success).toBe(false);
    expect(acceptInviteInputSchema.safeParse({ ...body, pin: '1234567' }).success).toBe(false);
    expect(acceptInviteInputSchema.safeParse({ ...body, totpCode: '12345' }).success).toBe(false);
    expect(acceptInviteInputSchema.safeParse({ ...body, role: 'owner' }).success).toBe(false);
  });
});

describe('changeRoleInputSchema', () => {
  test('takes expectedVersion and a role; a PIN, when given, must fit the new role', () => {
    expect(changeRoleInputSchema.safeParse({ expectedVersion: 2, role: 'cashier' }).success).toBe(
      true,
    );
    expect(
      changeRoleInputSchema.safeParse({ expectedVersion: 2, role: 'cashier', pin: '1234' }).success,
    ).toBe(true);
    expect(
      changeRoleInputSchema.safeParse({ expectedVersion: 2, role: 'manager', pin: '1234' }).success,
    ).toBe(false);
    expect(
      changeRoleInputSchema.safeParse({ expectedVersion: 2, role: 'owner', pin: '123456' }).success,
    ).toBe(true);
    expect(changeRoleInputSchema.safeParse({ role: 'cashier' }).success).toBe(false);
    expect(changeRoleInputSchema.safeParse({ expectedVersion: 0, role: 'cashier' }).success).toBe(
      false,
    );
    expect(changeRoleInputSchema.safeParse({ expectedVersion: 1, role: 'boss' }).success).toBe(
      false,
    );
  });
});
