/**
 * Authentication rules (D-17, 02 §7): registered devices, staff PINs, the owner's password +
 * TOTP, step-up and sessions. Policy and orchestration live here; SQL lives in `@sds/db`.
 *
 * Every attempt runs in one transaction that holds a row lock on the account being guessed, so
 * parallel guesses are counted one at a time. A wrong guess is returned as a value (not thrown)
 * so its counter and audit row commit, then the caller turns it into the HTTP error.
 */

export type { AuthContext, Principal, RequestMeta } from './context.ts';
export { hasFreshStepUp, permissionsOf, securityAlert } from './context.ts';
export {
  authenticateDevice,
  listLoginStaff,
  registerDevice,
  requireStaffDevice,
} from './devices.ts';
export { ownerLogin } from './owner-login.ts';
export { pinLogin } from './pin.ts';
export { authenticateSession, describeSession, logout, peekSession } from './sessions.ts';
export { stepUp } from './step-up.ts';
