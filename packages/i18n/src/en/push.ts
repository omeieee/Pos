import type { thPush } from '../th/push.ts';

/** English catalog: phone alerts (P8, Web Push). `satisfies` makes a missing or extra key a type error. */
export const enPush = {
  'push.title': 'Phone alerts',
  'push.desc': 'Get an alert when a new order comes in, even when the app is not open',
  'push.hubDesc': 'Turn new-order alerts on or off for this device',
  'push.back': 'Back',
  'push.switch': 'New-order alerts on this device',
  'push.switchHint':
    'Set per device: other devices must turn it on themselves, and an order keyed on this device does not alert it',
  'push.state.loading': 'Checking this device…',
  'push.state.working': 'Working…',
  'push.state.on': 'On: this device gets an alert when a new order comes in',
  'push.state.off': 'Off: this device gets no alerts',
  'push.privacy':
    'An alert only carries the order number and the item count: no customer name, phone or address',
  'push.retry': 'Try again',
  'push.notConfigured':
    'Phone alerts are not set up on the server yet. The owner or the system admin has to set them up before they can be turned on',
  'push.unsupported':
    'This browser does not support alerts. Try the latest Safari, Chrome, Edge or Firefox (iPhone and iPad need iOS or iPadOS 16.4 or later)',
  'push.needsInstall.title': 'Add the app to the Home Screen first',
  'push.needsInstall.body':
    'iPhone and iPad only get alerts when the app is opened from its Home Screen icon (iOS or iPadOS 16.4 or later). Follow these steps',
  'push.needsInstall.step1': 'Open this page in Safari',
  'push.needsInstall.step2': 'Tap the Share button (a square with an arrow pointing up)',
  'push.needsInstall.step3': 'Choose “Add to Home Screen”, then tap “Add”',
  'push.needsInstall.step4':
    'Open the app from the Home Screen icon, then come back here and turn the switch on',
  'push.denied.title': 'Alerts are blocked on this device',
  'push.denied.body':
    'You have to allow alerts yourself: on iPhone and iPad go to Settings > Notifications > แซ่บโดนเส้น; on a computer tap the icon beside the web address and allow notifications. Then come back to this page',
  'push.denied.recheck': 'Check again',
  'push.deviceRequired':
    'This device is not registered yet. The owner has to register the device before it can get alerts',
  'push.error.dismissed': 'Alerts were not allowed. Tap the switch and choose “Allow” again',
  'push.error.enable': 'Could not turn alerts on. Try again',
  'push.error.disable': 'Could not turn alerts off. Try again',
  'push.error.load': 'Could not check the alert status',
  'push.fallback.title': 'New order',
  'push.fallback.body': 'Open the app to see the order',
  'error.pushNotConfigured': 'Phone alerts are not set up on the server',
  'error.deviceRequired': 'This device is not registered. Ask the owner to register it first',
} as const satisfies Record<keyof typeof thPush, string>;
