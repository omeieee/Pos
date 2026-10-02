/**
 * The devices and staff routes of the dev server (`VITE_MOCK_API=1`) and of tests, answering the
 * way apps/api does: owner only (`device.manage`, `staff.manage`), and every route, the lists
 * included, needs a fresh step-up (403 STEP_UP_REQUIRED). A staff change names the version it was
 * built on (409 VERSION_CONFLICT with the current one), the owner cannot be changed (409
 * OWNER_PROTECTED), a manager's PIN needs all 6 digits (400), deactivating someone or setting their
 * PIN ends their open sessions, and nothing here returns a PIN. Creating staff takes no idempotency
 * key, like the real route. Everything is made up and nothing is persisted.
 */
import {
  createStaffInputSchema,
  type DeviceDto,
  type DeviceKind,
  idParamSchema,
  patchStaffInputSchema,
  pinSchemaFor,
  ROLE_PERMISSIONS,
  type StaffDto,
  type StaffRole,
  setStaffPinInputSchema,
} from '@sds/shared';
import type { MockAnswer, MockCaller } from './mock-payments.ts';

export interface MockPerson {
  id: string;
  displayName: string;
  role: StaffRole;
  pin: string;
  active: boolean;
  version: number;
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

  const deviceDto = (device: MockDevice): DeviceDto => ({ ...device });
  const staffDto = (person: MockPerson): StaffDto => {
    const locked = deps.lockedUntil(person.id);
    return {
      id: person.id,
      displayName: person.displayName,
      role: person.role,
      active: person.active,
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

  function handle(
    method: string,
    path: string,
    body: unknown,
    caller: MockCaller,
  ): MockAnswer | null {
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

    const staffPath = /^\/v1\/staff(?:\/([^/]+)(\/pin)?)?$/.exec(path);
    if (!staffPath) return null;
    const refused = gate(caller, 'staff.manage');
    if (refused) return refused;
    const [, rawId, pinSuffix] = staffPath;

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
      if (person.role === 'owner') return error(409, 'OWNER_PROTECTED');
      if (input.data.expectedVersion !== person.version) return conflict(person.version);
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

  return { handle };
}
