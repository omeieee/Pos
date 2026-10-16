import type { thSettingsPayments } from '../th/settings-payments.ts';

/** English catalog: the settings screens for payments: co-pay, PromptPay, bank account, receipts, numbering. `satisfies` makes a missing or extra key a type error. */
export const enSettingsPayments = {
  'settings.bankAccount.title': 'Receiving bank account',
  'settings.bankAccount.desc':
    'The bank account customers transfer to; used only to compare the receiver on slips (owner only)',
  'settings.bankAccount.shown': 'Saved account: {masked}',
  'settings.bankAccount.shownBank': 'Saved account: {bank} {masked}',
  'settings.bankAccount.configuredOnly': 'A receiving account is saved',
  'settings.bankAccount.none':
    'No account number saved (optional). A slip that shows the receiver as an account number cannot be compared.',
  'settings.bankAccount.bank': 'Bank (optional)',
  'settings.bankAccount.bankNone': 'Not set',
  'settings.bankAccount.number': 'Account number (10 to 15 digits)',
  'settings.bankAccount.numberHint':
    'Digits only; hyphens and spaces are fine. Leave empty to keep the saved number.',
  'settings.bankAccount.error.accountNumber': 'It must be 10 to 15 digits.',
  'settings.bankAccount.privacy':
    'Only part of the number is shown. It is used only to compare slips and does not prove that money arrived: always check the bank app.',
  'settings.bankAccount.ownerOnly':
    'Only the owner can change this, and must confirm their identity again before saving.',
  'settings.bankAccount.clear': 'Remove account number',
  'settings.bankAccount.bankName.002': 'Bangkok Bank',
  'settings.bankAccount.bankName.004': 'Kasikornbank',
  'settings.bankAccount.bankName.006': 'Krungthai Bank',
  'settings.bankAccount.bankName.011': 'TTB',
  'settings.bankAccount.bankName.014': 'SCB',
  'settings.bankAccount.bankName.025': 'Krungsri',
  'settings.bankAccount.bankName.030': 'GSB',
  'settings.bankAccount.bankName.034': 'BAAC',
  'settings.receipt.title': 'Receipts',
  'settings.receipt.desc': 'The tax ID and address printed on receipts (owner only)',
  'settings.receipt.taxId': 'Tax ID (13 digits)',
  'settings.receipt.address': 'Address on receipts',
  'settings.receipt.hint': 'You can leave these empty; a receipt skips the lines left blank.',
  'settings.receipt.error.taxId': 'That 13-digit number is not valid. Check it again.',
  'settings.receipt.error.address': '200 characters at most.',
  'settings.receipt.ownerOnly':
    'Only the owner can change it, and must confirm who they are again before it is saved.',
  'settings.numbering.title': 'Business day and order numbers',
  'settings.numbering.desc': 'Cutoff time; order numbers restart each day',
  'settings.payments.title': 'Payment methods',
  'settings.payments.desc': 'Turn cash, PromptPay, platform and other on or off',
  'settings.promptpay.title': 'PromptPay',
  'settings.promptpay.desc': 'The account behind the QR (only the owner can change it)',
  'settings.copay.title': 'Thai Chuay Thai Plus',
  'settings.copay.desc': 'Dates, hours and the on/off switch of the co-pay scheme (owner only)',
  'settings.numbering.cutoff': 'Business-day cutoff (for example 04:00)',
  'settings.numbering.hint':
    'Orders before this time count for the previous business day, and order numbers restart when a new business day begins.',
  'settings.numbering.error': 'Enter a time from 00:00 to 23:59.',
  'settings.numbering.zone': 'Time zone: {zone} (it cannot be changed here)',
  'settings.payments.cash': 'Cash',
  'settings.payments.promptpay': 'PromptPay',
  'settings.payments.platform': 'Grab / LINE MAN (the platform collects the money)',
  'settings.payments.other': 'Other',
  'settings.payments.hint': 'Staff cannot take a payment with a method that is off.',
  'settings.payments.govNote':
    'The government co-pay scheme has its own switch under “Thai Chuay Thai Plus”.',
  'settings.promptpay.shown': '{type}: {masked}',
  'settings.promptpay.type.phone': 'Mobile number',
  'settings.promptpay.type.national_id': 'National ID (13 digits)',
  'settings.promptpay.type.ewallet': 'e-Wallet (15 digits)',
  'settings.promptpay.none': 'No PromptPay account is set, so PromptPay cannot be used yet.',
  'settings.promptpay.privacy': 'Only part of the account number is ever shown.',
  'settings.promptpay.ownerOnly':
    'Only the owner can change it, and must confirm who they are again before it is saved.',
  'settings.promptpay.set': 'Set the PromptPay account',
  'settings.promptpay.change': 'Change the PromptPay account',
  'settings.promptpay.dialog.title': 'Change the PromptPay account',
  'settings.promptpay.dialog.kind': 'Account type',
  'settings.promptpay.dialog.value': 'New account number',
  'settings.promptpay.dialog.valueHint': 'Digits only (hyphens and spaces are fine).',
  'settings.promptpay.dialog.error':
    'The number does not fit the chosen type. Check how many digits it has.',
  'settings.promptpay.dialog.review': 'Review',
  'settings.promptpay.dialog.edit': 'Edit the number',
  'settings.promptpay.dialog.confirmTitle': 'Confirm the change',
  'settings.promptpay.dialog.newAccount': 'New account: {masked}',
  'settings.promptpay.dialog.oldAccount': 'Current account: {masked}',
  'settings.promptpay.dialog.noOld': 'No account was set before.',
  'settings.promptpay.dialog.warnOpen':
    '{count} PromptPay payments are still waiting to be confirmed (as far as this device can see). The customer may already have paid the old account. They are not cancelled for you: check both the old and the new account before confirming them.',
  'settings.promptpay.dialog.warnNone':
    'This device sees no PromptPay payment waiting, but a customer who already scanned the old QR will pay the old account.',
  'settings.promptpay.dialog.alert': 'The change is written to the audit log and alerts the owner.',
  'settings.promptpay.dialog.confirm': 'Change account',
  'settings.promptpay.dialog.changing': 'Changing…',
  'settings.promptpay.done': 'The PromptPay account was changed.',
  'settings.copay.rules':
    'It can be used only inside the dates and hours set here, and only face to face (at the counter or at the hand-over at the building entrance). Staff create the ถุงเงิน QR for every transaction, it is never sent through LINE, and staff confirm every payment by hand.',
  'settings.copay.risk':
    'It is not confirmed with ถุงเงิน that a hand-over at the building entrance is within the scheme terms. If the scheme says it is not, switch it off below.',
  'settings.copay.channels': 'Channels it is set for: {channels}',
  'settings.copay.channelsNote':
    'This page does not change the channels. A new scheme is set for the storefront only.',
  'settings.copay.new':
    'No scheme is set yet. Fill it in and save. A new scheme stays off until you switch it on.',
  'settings.copay.nameTh': 'Scheme name (Thai)',
  'settings.copay.nameEn': 'Scheme name (English)',
  'settings.copay.share': 'Government share (%)',
  'settings.copay.shareHint':
    'For example 60 means the government pays 60% and the customer the rest.',
  'settings.copay.dailyCap': 'Daily cap per person (baht)',
  'settings.copay.totalCap': 'Total cap per person for the scheme (baht)',
  'settings.copay.capHint': 'Leave empty for no cap.',
  'settings.copay.from': 'First day',
  'settings.copay.to': 'Last day',
  'settings.copay.fromTime': 'Daily start (for example 06:00)',
  'settings.copay.toTime': 'Daily end (for example 23:00 or 24:00)',
  'settings.copay.enabled': 'Scheme switched on',
  'settings.copay.enabledHint':
    'When on, staff can pick this method only inside the dates and hours above.',
  'settings.copay.error.nameTh': 'Enter the scheme name (80 characters at most).',
  'settings.copay.error.share':
    'Enter a percent from 0 to 100 (up to 2 decimals), above 0 if the scheme is on.',
  'settings.copay.error.dailyCap': 'Enter an amount in baht, like 200, or leave it empty.',
  'settings.copay.error.totalCap': 'Enter an amount in baht, like 1000, or leave it empty.',
  'settings.copay.error.activeFrom': 'Pick a real date.',
  'settings.copay.error.activeTo': 'The last day must be a real date, not before the first day.',
  'settings.copay.error.fromTime': 'Enter a time as hours:minutes, like 06:00.',
  'settings.copay.error.toTime': 'The end must be after the start, like 23:00 or 24:00.',
  'settings.copay.error.enabled':
    'This scheme is not set for the storefront alone, so it cannot be switched on.',
  'settings.copay.channelsWarn':
    'This scheme is not set for the storefront alone, which conflicts with face-to-face payment, so it cannot be switched on (only off). Have an administrator set its channels to the storefront first.',
} as const satisfies Record<keyof typeof thSettingsPayments, string>;
