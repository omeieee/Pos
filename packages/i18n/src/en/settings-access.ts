import type { thSettingsAccess } from '../th/settings-access.ts';

/** English catalog: the settings screens for staff, devices and co-owners. `satisfies` makes a missing or extra key a type error. */
export const enSettingsAccess = {
  'settings.devices.title': 'Devices',
  'settings.devices.desc': 'Registered devices and removing one (owner only)',
  'settings.staff.title': 'Staff',
  'settings.staff.desc':
    'Invite people by e-mail, add staff, set a PIN, change roles, deactivate (owner only)',
  'settings.admin.locked': 'You need to confirm who you are before this list is shown.',
  'settings.admin.unlock': 'Confirm who I am',
  'settings.admin.loading': 'Loading the list…',
  'settings.admin.loadFailed': 'The list could not be loaded',
  'settings.admin.uncertain':
    'No answer came back, so it is not known whether it worked. The list was loaded again: look at it before trying again.',
  'settings.devices.registerHint':
    'A new device is registered on that device itself: open the app there and sign in as the owner.',
  'settings.devices.empty': 'No device is registered.',
  'settings.devices.kind.ipad': 'iPad',
  'settings.devices.kind.iphone': 'iPhone',
  'settings.devices.kind.laptop': 'Computer',
  'settings.devices.kind.print_agent': 'Print notebook',
  'settings.devices.kind.display': 'Display',
  'settings.devices.lastSeen': 'Last used {time}',
  'settings.devices.neverSeen': 'Never used',
  'settings.devices.thisDevice': 'This device',
  'settings.devices.revokedAt': 'Removed {time}',
  'settings.devices.revoke': 'Remove device {name}',
  'settings.devices.unknownSelf':
    'This device could not be identified, so devices cannot be removed from this page. Try signing in again.',
  'settings.devices.revokeCurrent': 'You cannot remove the device you are using from this page.',
  'settings.devices.revokeTitle': 'Remove this device?',
  'settings.devices.revokeBody':
    'The device “{name}” stops working at once and whoever is signed in on it is signed out. The owner has to register it again on that device to use it later.',
  'settings.devices.revokeConfirm': 'Remove device',
  'settings.devices.removed': 'The device was removed.',
  'settings.staff.add': 'Add a staff member',
  'settings.staff.empty': 'No staff yet.',
  'settings.staff.name': 'Display name',
  'settings.staff.role': 'Role',
  'settings.staff.pin': 'PIN',
  'settings.staff.pin2': 'Enter the PIN again',
  'settings.staff.pinHint': 'Owners and managers need 6 digits; counter and kitchen staff 4 to 6.',
  'settings.staff.pinNote':
    'The PIN is stored scrambled and cannot be looked up later. If it is forgotten, set a new one.',
  'settings.staff.error.displayName': 'Enter a name (60 characters at most).',
  'settings.staff.error.pin':
    'The PIN must be digits with enough of them (6 for an owner or manager, 4 to 6 for others).',
  'settings.staff.error.pin2': 'The two PINs do not match.',
  'settings.staff.inactive': 'Deactivated',
  'settings.staff.locked': 'PIN locked',
  'settings.staff.noPin': 'No PIN',
  'settings.staff.selfNote':
    'This is your own account. You cannot change your role or deactivate yourself: ask another owner.',
  'settings.staff.rename': 'Rename {name}',
  'settings.staff.setPin': 'Set a new PIN for {name}',
  'settings.staff.deactivate': 'Deactivate {name}',
  'settings.staff.activate': 'Reactivate {name}',
  'settings.staff.addTitle': 'Add a staff member',
  'settings.staff.renameTitle': 'Rename a staff member',
  'settings.staff.pinTitle': 'Set a new PIN',
  'settings.staff.pinBody':
    '{name}’s new PIN works at once, and that person is signed out everywhere.',
  'settings.staff.deactivateTitle': 'Deactivate {name}?',
  'settings.staff.deactivateBody':
    'They are signed out at once and cannot sign in until you reactivate them.',
  'settings.staff.deactivateConfirm': 'Deactivate',
  'settings.staff.added': 'The staff member was added.',
  'settings.staff.working': 'Working…',
  'settings.admin.confirm': 'Confirm',
  'settings.staff.activateLabel': 'Reactivate',
  // Invites and role changes (D-23)
  'settings.staff.you': 'You',
  'settings.staff.noEmail': 'No e-mail (signs in with a PIN)',
  'settings.staff.invite': 'Invite a person',
  'settings.staff.inviteTitle': 'Invite a person',
  'settings.staff.inviteIntro':
    'The invited person sets their own password, authenticator app and PIN through the invite link.',
  'settings.staff.inviteEmail': 'E-mail of the person to invite',
  'settings.staff.inviteName': 'Display name (optional)',
  'settings.staff.inviteNameHint':
    'The invited person can change the name when they set up the account.',
  'settings.staff.inviteCreate': 'Create invite link',
  'settings.staff.error.email': 'Enter a valid e-mail',
  'settings.staff.roleDesc.owner':
    'Everything, including the PromptPay ID, refunds and managing staff.',
  'settings.staff.roleDesc.manager':
    'Takes orders and payments, edits the menu, sees reports, can cancel and refund, edits general shop settings.',
  'settings.staff.roleDesc.cashier':
    'Takes orders and payments and moves orders along; can only view settings.',
  'settings.staff.roleDesc.kitchen': 'Sees and moves orders along, and marks dishes sold out.',
  'settings.staff.ownerWarn':
    'An owner has full access, including the PromptPay ID, refunds and managing staff. Invite only people you trust.',
  'settings.staff.inviteUncertain':
    'No answer came back, so it is not known whether the invite was created. Look at the invites list: if this e-mail is there, cancel it and invite again to get a new link.',
  'settings.staff.linkTitle': 'The invite link is ready',
  'settings.staff.linkBody':
    'Send this link to {email} yourself (for example in LINE). The system does not send any e-mail.',
  'settings.staff.linkNote':
    'The link works once and expires in 72 hours. It is shown only now: once you close this window you cannot see it again. If it is lost, cancel the invite and invite again.',
  'settings.staff.linkLabel': 'Invite link',
  'settings.staff.linkCopy': 'Copy link',
  'settings.staff.linkCopied': 'Link copied',
  'settings.staff.linkCopyFailed':
    'Could not copy automatically. Press and hold the link field and choose Copy.',
  'settings.staff.linkDone': 'Done',
  'settings.staff.invites.title': 'Open invites',
  'settings.staff.invites.none': 'No open invites.',
  'settings.staff.invites.expires': 'Expires {when}',
  'settings.staff.invites.expired': 'Expired {when}',
  'settings.staff.invites.expiredBadge': 'Expired',
  'settings.staff.invites.revoke': 'Cancel invite',
  'settings.staff.invites.revokeLabel': 'Cancel the invite for {email}',
  'settings.staff.invites.revokeTitle': 'Cancel the invite for {email}?',
  'settings.staff.invites.revokeBody': 'The link that was sent stops working at once.',
  'settings.staff.invites.revoked': 'The invite was cancelled.',
  'settings.staff.invites.asRole': 'Role: {role}',
  'settings.staff.changeRole': 'Change role',
  'settings.staff.changeRoleLabel': 'Change the role of {name}',
  'settings.staff.changeRoleTitle': 'Change the role of {name}',
  'settings.staff.changeRoleBody':
    'Current role: {role}. After the change this person is signed out of every device and all owners get an alert.',
  'settings.staff.changeRoleSelf': 'You cannot change your own role. Ask another owner.',
  'settings.staff.changeRoleSame': 'Choose a role different from the current one.',
  'settings.staff.changeRoleNoAccount':
    'The owner role needs an e-mail account. This person uses a PIN only, so it cannot be chosen: invite them by e-mail instead.',
  'settings.staff.changeRolePin': 'New PIN for this role',
  'settings.staff.changeRolePinHint': 'This role needs a PIN of {min} to 6 digits. Set it now.',
  'settings.staff.changeRoleDone': 'The role was changed.',
} as const satisfies Record<keyof typeof thSettingsAccess, string>;
