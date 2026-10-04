/**
 * The devices and staff routes of the dev server (`VITE_MOCK_API=1`) and of tests, answering the
 * way apps/api does: owner only (`device.manage`, `staff.manage`), and every route, the lists
 * included, needs a fresh step-up (403 STEP_UP_REQUIRED). A staff change names the version it was
 * built on (409 VERSION_CONFLICT with the current one), nobody changes themselves (409
 * SELF_CHANGE) and the last active owner stays (409 LAST_OWNER) (D-23), an owner's and a manager's
 * PIN needs all 6 digits (400), deactivating someone, changing their role or setting their PIN ends
 * their open sessions, and nothing here returns a PIN. Creating staff takes no idempotency key, like
 * the real route.
 *
 * Invites (D-23): the owner makes one (the answer carries the token once), the public preview
 * shows who it is for and a NEW authenticator secret each time, and the accept needs the app code
 * MOCK_INVITE_CODE (anything else is 422 INVITE_CODE_INVALID). The invited person then exists with
 * their PIN. The mock's owner sign-in still knows only MOCK_OWNER, so a made-up co-owner signs in
 * with the PIN here. Everything is made up and nothing is persisted.
 */
import {
  acceptInviteInputSchema,
  changeRoleInputSchema,
  createInviteInputSchema,
  createStaffInputSchema,
  type DeviceDto,
  type DeviceKind,
  type InviteDto,
  idParamSchema,
  invitePreviewInputSchema,
  type OutboxRecoveryInput,
  outboxRecoveryInputSchema,
  PIN_MIN_DIGITS,
  patchStaffInputSchema,
  pinSchemaFor,
  ROLE_PERMISSIONS,
  type StaffDto,
  type StaffRole,
  setStaffPinInputSchema,
} from '@sds/shared';
import type { MockAnswer, MockCaller } from './mock-payments.ts';

/** The authenticator code the mock's invite accept takes (made up; a real app shows its own). */
export const MOCK_INVITE_CODE = '123456';
const INVITE_TTL_MS = 72 * 3600_000;
/** With `demoInvite`, the dev server starts with this invite open: try `/invite#mock-invite-demo`. */
export const MOCK_DEMO_INVITE_TOKEN = 'mock-invite-demo';

export interface MockPerson {
  id: string;
  displayName: string;
  role: StaffRole;
  pin: string;
  /** The sign-in e-mail of an invited person or of the owner; null for PIN-only staff. */
  email?: string | null;
  active: boolean;
  version: number;
}

interface MockInvite {
  id: string;
  token: string;
  email: string;
  role: StaffRole;
  displayName: string | null;
  createdAt: number;
  expiresAt: number;
  accepted: boolean;
  revoked: boolean;
  /** How many times the preview ran: each one hands out a new authenticator secret. */
  previews: number;
}

export interface MockDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  lastSeenAt: string | null;
  revokedAt: string | null;
  version: number;
}

interface Deps {
  now: () => number;
  newUuid: () => string;
  people: MockPerson[];
  devices: MockDevice[];
  /** Epoch ms until which this person's PIN is locked (0: not locked). */
  lockedUntil: (staffId: string) => number;
  /** The new PIN clears every lock and ends the open sessions; so does a deactivation. */
  endSessions: (staffId: string) => void;
  /** The server forgets this device: its token stops working. */
  revokeDevice: (id: string) => void;
  /** Start with one open invite (a manager) whose link is `/invite#mock-invite-demo`. */
  demoInvite?: boolean;
}

const error = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): MockAnswer => ({
  status,
  body: { code, message: 'mock server error', details },
});
const conflict = (version: number) => error(409, 'VERSION_CONFLICT', { currentVersion: version });

export function createMockAdmin(deps: Deps) {
  const iso = (ms: number) => new Date(ms).toISOString();
  /** What the owner reported, by request id: a retry answers 200 and writes nothing more. */
  const recoveries = new Map<string, OutboxRecoveryInput & { deviceId: string }>();
  const invites: MockInvite[] = deps.demoInvite
    ? [
        {
          id: deps.newUuid(),
          token: MOCK_DEMO_INVITE_TOKEN,
          email: 'invited@example.test',
          role: 'manager',
          displayName: null,
          createdAt: deps.now(),
          expiresAt: deps.now() + INVITE_TTL_MS,
          accepted: false,
          revoked: false,
          previews: 0,
        },
      ]
    : [];
  const usable = (invite: MockInvite) =>
    !invite.accepted && !invite.revoked && invite.expiresAt > deps.now();
  const inviteDto = (invite: MockInvite): InviteDto => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    displayName: invite.displayName,
    createdAt: iso(invite.createdAt),
    expiresAt: iso(invite.expiresAt),
    status: invite.expiresAt > deps.now() ? 'open' : 'expired',
  });
  const emailTaken = (email: string) => deps.people.some((p) => p.email === email);
  const activeOwners = () => deps.people.filter((p) => p.role === 'owner' && p.active);

  const deviceDto = (device: MockDevice): DeviceDto => ({ ...device });
  const staffDto = (person: MockPerson): StaffDto => {
    const locked = deps.lockedUntil(person.id);
    return {
      id: person.id,
      displayName: person.displayName,
      role: person.role,
      active: person.active,
      email: person.email ?? null,
      hasPin: person.pin !== '',
      pinLockedUntil: locked > deps.now() ? iso(locked) : null,
      version: person.version,
    };
  };

  /** Owner only and a fresh step-up, in the order the real guard checks them. */
  function gate(
    caller: MockCaller,
    permission: 'device.manage' | 'staff.manage',
  ): MockAnswer | null {
    if (!ROLE_PERMISSIONS[caller.role].has(permission)) return error(403, 'FORBIDDEN');
    if (!caller.stepUpFresh) return error(403, 'STEP_UP_REQUIRED');
    return null;
  }

  /**
   * The owner took over or cleared what other people left in a device's offline outbox: owner only,
   * a fresh step-up, counts only. 201 the first time (the real route writes an audit row and a
   * warn alert), 200 for a retry of the same request id, 409 IDEMPOTENCY_KEY_REUSED when that id
   * comes back with other counts or another action.
   */
  function recordRecovery(rawId: string, body: unknown, caller: MockCaller): MockAnswer {
    const refused = gate(caller, 'device.manage');
    if (refused) return refused;
    const input = outboxRecoveryInputSchema.safeParse(body);
    if (!input.success) return error(400, 'VALIDATION_ERROR');
    const id = idParamSchema.safeParse({ id: rawId });
    if (!id.success || !deps.devices.some((d) => d.id === id.data.id))
      return error(404, 'NOT_FOUND');
    const answer = {
      deviceId: id.data.id,
      action: input.data.action,
      orders: input.data.orders,
      payments: input.data.payments,
    };
    const seen = recoveries.get(input.data.clientRequestId);
    if (seen) {
      const same =
        seen.deviceId === answer.deviceId &&
        seen.action === answer.action &&
        seen.orders === answer.orders &&
        seen.payments === answer.payments;
      return same ? { status: 200, body: answer } : error(409, 'IDEMPOTENCY_KEY_REUSED');
    }
    recoveries.set(input.data.clientRequestId, { ...input.data, deviceId: id.data.id });
    return { status: 201, body: answer };
  }

  function handle(
    method: string,
    path: string,
    body: unknown,
    caller: MockCaller,
  ): MockAnswer | null {
    const recovery = /^\/v1\/devices\/([^/]+)\/outbox-recovery$/.exec(path);
    if (method === 'POST' && recovery) return recordRecovery(recovery[1] ?? '', body, caller);

    if (path === '/v1/devices' || /^\/v1\/devices\/[^/]+\/revoke$/.test(path)) {
      const refused = gate(caller, 'device.manage');
      if (refused) return refused;
      if (method === 'GET' && path === '/v1/devices') {
        return { status: 200, body: { devices: deps.devices.map(deviceDto) } };
      }
      const match = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(path);
      if (method === 'POST' && match) {
        const id = idParamSchema.safeParse({ id: match[1] });
        const device = id.success ? deps.devices.find((d) => d.id === id.data.id) : undefined;
        if (!device) return error(404, 'NOT_FOUND');
        if (device.revokedAt === null) {
          device.revokedAt = iso(deps.now());
          device.version += 1;
          deps.revokeDevice(device.id);
        }
        return { status: 200, body: deviceDto(device) };
      }
      return null;
    }

    const staffPath = /^\/v1\/staff(?:\/([^/]+)(\/pin|\/role)?)?$/.exec(path);
    const inviteRevoke = /^\/v1\/staff\/invites\/([^/]+)\/revoke$/.exec(path);
    if (!staffPath && !inviteRevoke) return null;
    const refused = gate(caller, 'staff.manage');
    if (refused) return refused;
    if (inviteRevoke) {
      if (method !== 'POST') return null;
      const id = idParamSchema.safeParse({ id: inviteRevoke[1] });
      const invite = id.success ? invites.find((i) => i.id === id.data.id) : undefined;
      if (!invite || invite.revoked) return error(404, 'NOT_FOUND');
      if (invite.accepted) return error(409, 'INVITE_ACCEPTED');
      invite.revoked = true;
      return { status: 204, body: undefined };
    }
    if (!staffPath) return null;
    const [, rawId, suffix] = staffPath;
    const pinSuffix = suffix === '/pin' ? suffix : undefined;

    if (rawId === 'invites') {
      if (suffix !== undefined) return null;
      if (method === 'GET') {
        return {
          status: 200,
          body: { invites: invites.filter((i) => !i.accepted && !i.revoked).map(inviteDto) },
        };
      }
      if (method === 'POST') {
        const input = createInviteInputSchema.safeParse(body);
        if (!input.success) return error(400, 'VALIDATION_ERROR');
        if (emailTaken(input.data.email)) return error(409, 'EMAIL_TAKEN');
        if (invites.some((i) => i.email === input.data.email && usable(i))) {
          return error(409, 'INVITE_EXISTS');
        }
        const invite: MockInvite = {
          id: deps.newUuid(),
          token: `mock-invite-${deps.newUuid()}`,
          email: input.data.email,
          role: input.data.role,
          displayName: input.data.displayName ?? null,
          createdAt: deps.now(),
          expiresAt: deps.now() + INVITE_TTL_MS,
          accepted: false,
          revoked: false,
          previews: 0,
        };
        invites.push(invite);
        return { status: 201, body: { ...inviteDto(invite), token: invite.token } };
      }
      return null;
    }

    if (rawId === undefined) {
      if (method === 'GET') return { status: 200, body: { staff: deps.people.map(staffDto) } };
      if (method === 'POST') {
        const input = createStaffInputSchema.safeParse(body);
        if (!input.success) return error(400, 'VALIDATION_ERROR');
        const person: MockPerson = {
          id: deps.newUuid(),
          displayName: input.data.displayName,
          role: input.data.role,
          pin: input.data.pin,
          active: true,
          version: 1,
        };
        deps.people.push(person);
        return { status: 201, body: staffDto(person) };
      }
      return null;
    }

    const id = idParamSchema.safeParse({ id: rawId });
    const person = id.success ? deps.people.find((p) => p.id === id.data.id) : undefined;
    if (!person) return error(404, 'NOT_FOUND');

    if (method === 'PATCH' && pinSuffix === undefined) {
      const input = patchStaffInputSchema.safeParse(body);
      if (!input.success) return error(400, 'VALIDATION_ERROR');
      if (person.id === caller.staffId) return error(409, 'SELF_CHANGE');
      if (input.data.expectedVersion !== person.version) return conflict(person.version);
      const lastOwner = person.role === 'owner' && person.active && activeOwners().length <= 1;
      if (input.data.active === false && lastOwner) return error(409, 'LAST_OWNER');
      let changed = false;
      if (input.data.displayName !== undefined && input.data.displayName !== person.displayName) {
        person.displayName = input.data.displayName;
        changed = true;
      }
      if (input.data.active !== undefined && input.data.active !== person.active) {
        person.active = input.data.active;
        changed = true;
        if (!person.active) deps.endSessions(person.id);
      }
      if (changed) person.version += 1;
      return { status: 200, body: staffDto(person) };
    }

    if (method === 'POST' && suffix === '/role') {
      const input = changeRoleInputSchema.safeParse(body);
      if (!input.success) return error(400, 'VALIDATION_ERROR');
      if (person.id === caller.staffId) return error(409, 'SELF_CHANGE');
      const changes = input.data.role !== person.role;
      const needsPin =
        changes &&
        (PIN_MIN_DIGITS[input.data.role] > PIN_MIN_DIGITS[person.role] ||
          (person.pin === '' && input.data.role !== 'owner'));
      if (needsPin && input.data.pin === undefined) return error(400, 'VALIDATION_ERROR');
      if (
        input.data.pin !== undefined &&
        !pinSchemaFor(input.data.role).safeParse(input.data.pin).success
      ) {
        return error(400, 'VALIDATION_ERROR');
      }
      if (input.data.expectedVersion !== person.version) return conflict(person.version);
      if (!changes) return { status: 200, body: staffDto(person) };
      if (person.role === 'owner' && person.active && activeOwners().length <= 1) {
        return error(409, 'LAST_OWNER');
      }
      if (input.data.role === 'owner' && !person.email) return error(409, 'OWNER_NEEDS_ACCOUNT');
      person.role = input.data.role;
      if (input.data.pin !== undefined) person.pin = input.data.pin;
      person.version += 1;
      deps.endSessions(person.id);
      return { status: 200, body: staffDto(person) };
    }

    if (method === 'POST' && pinSuffix !== undefined) {
      const input = setStaffPinInputSchema.safeParse(body);
      if (!input.success) return error(400, 'VALIDATION_ERROR');
      // The owner and managers need all 6 digits (the shared rule, by role).
      if (!pinSchemaFor(person.role).safeParse(input.data.pin).success) {
        return error(400, 'VALIDATION_ERROR');
      }
      person.pin = input.data.pin;
      person.version += 1;
      deps.endSessions(person.id);
      return { status: 200, body: staffDto(person) };
    }
    return null;
  }

  const secretFor = (invite: MockInvite) =>
    // Base32 letters only; the last one changes with every preview, like a new secret would.
    `JBSWY3DPEHPK3PX${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[invite.previews % 32]}`;
  const inviteOf = (token: string) => invites.find((i) => i.token === token && usable(i));

  /**
   * The invite link's public calls (no session). One generic answer for every unusable link, and a
   * preview that hands out a new authenticator secret each time (only the last one is confirmed).
   */
  function handlePublic(method: string, path: string, body: unknown): MockAnswer | null {
    if (method !== 'POST') return null;
    if (path === '/v1/auth/invite/preview') {
      const input = invitePreviewInputSchema.safeParse(body);
      if (!input.success) return error(400, 'VALIDATION_ERROR');
      const invite = inviteOf(input.data.token);
      if (!invite) return error(404, 'INVITE_INVALID');
      invite.previews += 1;
      const secretBase32 = secretFor(invite);
      return {
        status: 200,
        body: {
          email: invite.email,
          role: invite.role,
          displayName: invite.displayName,
          totp: {
            secretBase32,
            otpauthUri: `otpauth://totp/Saap%20Don%20Sen%20POS:${encodeURIComponent(invite.email)}?secret=${secretBase32}&issuer=Saap%20Don%20Sen%20POS`,
          },
        },
      };
    }
    if (path === '/v1/auth/invite/accept') {
      const input = acceptInviteInputSchema.safeParse(body);
      if (!input.success) return error(400, 'VALIDATION_ERROR');
      const invite = inviteOf(input.data.token);
      if (!invite) return error(404, 'INVITE_INVALID');
      if (!pinSchemaFor(invite.role).safeParse(input.data.pin).success) {
        return error(400, 'VALIDATION_ERROR');
      }
      if (input.data.totpCode !== MOCK_INVITE_CODE) return error(422, 'INVITE_CODE_INVALID');
      if (emailTaken(invite.email)) return error(409, 'EMAIL_TAKEN');
      invite.accepted = true;
      deps.people.push({
        id: deps.newUuid(),
        displayName: input.data.displayName,
        role: invite.role,
        pin: input.data.pin,
        email: invite.email,
        active: true,
        version: 1,
      });
      return {
        status: 200,
        body: {
          recoveryCodes: Array.from(
            { length: 8 },
            (_, n) => `MOCK-${String(n + 1).padStart(4, '0')}-EXAM-PLE${n}`,
          ),
        },
      };
    }
    return null;
  }

  return {
    handle,
    handlePublic,
    /** Dev and tests: what the owner reported so far (each request id once). */
    recoveries: () => [...recoveries.values()],
  };
}
