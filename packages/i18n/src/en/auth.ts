import type { thAuth } from '../th/auth.ts';

/** English catalog: sign-in, step-up, staff invites. `satisfies` makes a missing or extra key a type error. */
export const enAuth = {
  // Device registration (first run)
  'auth.register.title': 'Register this device',
  'auth.register.intro': 'The owner signs in first, to link this device to the shop',
  'auth.register.step1': 'Owner sign-in',
  'auth.register.step2': 'Name this device',
  'auth.register.signedInAs': 'Signed in as {name}',
  'auth.register.nameLabel': 'Device name',
  'auth.register.namePlaceholder': 'For example, Counter iPad',
  'auth.register.nameHint': 'This name appears in the shop’s activity log',
  'auth.register.kindLabel': 'Device type',
  'auth.register.submit': 'Register device',
  'auth.register.startOver': 'Start over',

  // Owner sign-in (password + authenticator code or recovery code)
  'auth.owner.title': 'Owner sign-in',
  'auth.owner.email': 'Email',
  'auth.owner.password': 'Password',
  'auth.owner.code': '6-digit code from the authenticator app',
  'auth.owner.recoveryCode': 'Recovery code',
  'auth.owner.useRecovery': 'Use a recovery code instead',
  'auth.owner.useCode': 'Use the app code instead',
  'auth.owner.submit': 'Sign in',
  'auth.owner.failed':
    'Those details are not right, or the account is paused for a moment. Please wait a little and try again.',
  'auth.owner.backToPin': 'Back to PIN',

  // Staff PIN screen
  'auth.pin.title': 'Welcome back',
  'auth.pin.enterFor': 'Enter PIN for {name}',
  'auth.pin.changePerson': 'Choose someone else',
  'auth.pin.delete': 'Delete last digit',
  'auth.pin.clear': 'Clear',
  'auth.pin.submit': 'Sign in',
  'auth.pin.progress': '{count} digits entered',
  'auth.pin.empty': 'No staff have a PIN yet',
  'auth.pin.emptyHint': 'The owner signs in with a password first, then adds staff',
  'auth.pin.loadFailed': 'Could not load the staff list',
  'auth.pin.wrong': 'That PIN is not right. Try again.',
  'auth.pin.lockedFor': 'This PIN is locked for now. Try again in {wait}',
  'auth.pin.lockedBadge': 'Locked',
  'auth.pin.ownerLink': 'Owner: sign in with a password',
  'auth.pin.subtitle': 'Everyone signs in with their own account, so every action can be traced',
  'auth.pin.pick': 'Choose your name',
  'auth.pin.forgot': 'Forgot your PIN? Ask the owner to reset it',
  'auth.hero.tagline': 'In-store sales and LINE orders',
  'auth.hero.cta': "Sign in to start today's sales",
  'auth.divider.or': 'or',
  'auth.passkey': 'Sign in with a passkey',
  'auth.owner.subtitle': 'Use your password and the 6-digit code from the authenticator app',
  'auth.owner.showPassword': 'Show password',
  'auth.owner.hidePassword': 'Hide password',

  // Step-up (asks again before a sensitive action)
  'auth.stepUp.title': 'Confirm it is you',
  'auth.stepUp.ownerHint':
    'Enter your password and the authenticator code. If you just used a code, wait about 30 seconds for the next one, or use a recovery code.',
  'auth.stepUp.pinHint': 'Enter your PIN again to do this',
  'auth.stepUp.submit': 'Confirm',
  'auth.stepUp.failed': 'Those details are not right. Please try again.',
  'auth.stepUp.lockedFor': 'Too many wrong tries. Please wait {wait} and try again.',

  // Notices shown once on the PIN screen
  'auth.notice.sessionExpired': 'Your session ended. Please sign in again.',
  'auth.notice.deviceRemoved': 'This device was removed from the shop. Register it again.',
  'auth.notice.deviceMismatch': 'That session belongs to another device. Please sign in again.',
  // The public invite page (D-23)
  'invite.title': 'Set up your account',
  'invite.subtitle': 'Welcome to the Saap Don Sen POS. Finish the set-up to start using it.',
  'invite.loading': 'Checking the invite link…',
  'invite.invalidTitle': 'This invite link cannot be used',
  'invite.invalidHelp':
    'If you reopened or refreshed this page, tap the link you were sent again, or ask the owner for a new one.',
  'invite.youAre': 'You are invited as {role}',
  'invite.email': 'Sign-in e-mail',
  'invite.name': 'Display name',
  'invite.password': 'Choose a password',
  'invite.passwordHint':
    'At least 12 characters. A memorable sentence works well; longer is better.',
  'invite.strength.short': 'Still too short',
  'invite.strength.fair': 'Fair',
  'invite.strength.strong': 'Strong',
  'invite.pin': 'PIN for everyday use on a shop device',
  'invite.pinHint.6': '6 digits',
  'invite.pinHint.4': '4 to 6 digits',
  'invite.pin2': 'Enter the PIN again',
  'invite.totp.title': 'Set up the authenticator app',
  'invite.totp.body':
    'Scan the QR with an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy.',
  'invite.totp.qrLabel': 'QR for the authenticator app',
  'invite.totp.secret': 'Or type this key into the app yourself',
  'invite.totp.reopen':
    'Opening this link again gives a new QR: delete the old entry in the app and scan the new one.',
  'invite.code': '6-digit code from the app',
  'invite.submit': 'Create account',
  'invite.submitting': 'Creating the account…',
  'invite.error.displayName': 'Enter a name (up to 60 characters)',
  'invite.error.password': 'The password needs at least 12 characters',
  'invite.error.pin': 'The PIN must be digits, with enough of them for the role',
  'invite.error.pin2': 'The two PINs do not match',
  'invite.error.code': 'Enter the 6-digit code from the app',
  'invite.done.title': 'Your account is ready',
  'invite.done.codesTitle': 'Recovery codes',
  'invite.done.codesBody':
    'Use them to sign in if the authenticator app or phone is lost. Each code works once, and they are shown only now.',
  'invite.done.codesHint': 'Write them on paper, or keep them in a secure password manager.',
  'invite.done.copy': 'Copy all codes',
  'invite.done.copied': 'Codes copied',
  'invite.done.copyFailed':
    'Could not copy automatically. Write the codes down or press and hold to select them.',
  'invite.done.saved': 'I have saved the recovery codes',
  'invite.done.signIn': 'Go to sign-in',
  'invite.done.firstSignIn':
    'The first time you sign in, wait for the next code in the app (it changes every 30 seconds): the code used during set-up cannot be reused.',
} as const satisfies Record<keyof typeof thAuth, string>;
