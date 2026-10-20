import type { thErrors } from '../th/errors.ts';

/** English catalog: API error codes and the offline outbox. `satisfies` makes a missing or extra key a type error. */
export const enErrors = {
  'error.adjustClaimOpen':
    'A transfer claim is not confirmed yet. Confirm or cancel it on the payment page and then adjust, or choose to void the payment instead.',
  'error.adjustTotalZero':
    'The new total is zero, so it cannot be adjusted. Void the whole order or refund everything instead.',
  'error.adjustMethodNotAdjustable':
    'The money was received by a method that cannot be partly returned (co-pay, platform or other). Choose to void or refund the payment in full, then collect the new total again.',
  'error.refundDetailsRequired':
    'The new total is lower than what was received. Choose how to return the difference before saving.',
  'error.refundNotNeeded':
    'The new total is not lower than what was received, so nothing is returned. Save again.',
  'error.paymentActionRequired':
    'This order has a payment. Choose to adjust, void or refund it first.',
  'error.nothingToChange': 'Nothing was changed.',
  'error.discountExceedsSubtotal':
    'The discount would be larger than the lines after this change, so it cannot be saved.',
  'error.unknownOrderItem': 'That line is not on this order. Close this and open it again.',

  // API errors, by the API's stable error code (never show the server's own message)
  'error.unauthenticated': 'Your session ended. Please sign in again.',
  'error.deviceUnregistered': 'This device is not registered, or was removed from the shop.',
  'error.deviceMismatch': 'That session belongs to another device. Please sign in again.',
  'error.invalidCredentials': 'Those details are not right. Please try again.',
  'error.accountLocked': 'Too many wrong tries. Please wait a little and try again.',
  'error.accountLockedFor': 'Too many wrong tries. Please wait {wait} and try again.',
  'error.forbidden': 'Your role may not do this.',
  'error.stepUpRequired': 'Confirm it is you again before doing this.',
  'error.secondFactorUnavailable':
    'The authenticator code cannot be checked right now. Use a recovery code instead.',
  'error.notFound': 'That item was not found.',
  'error.versionConflict': 'This was changed on another device. Reload and try again.',
  'error.invalidTransition': 'This order cannot move to that status.',
  'error.orderInvalid': 'This order cannot be accepted yet. Please check its items.',
  'error.orderClosed': 'A finished order cannot be edited.',
  'error.roomRequired': 'Room delivery needs a room number.',
  'error.reasonRequired': 'Please give a reason.',
  'error.unknownCustomer': 'That customer was not found.',
  'error.idempotencyKeyMismatch': 'The request ids do not match. Please try again.',
  'error.idempotencyKeyReused':
    'That request id was already used for another order. Start a new order.',
  'error.validation': 'Some details are not right. Please check and try again.',
  'error.rateLimited': 'Too many tries. Please wait a moment and try again.',
  'error.server': 'The system is having trouble. Please try again.',
  'error.network': 'Cannot reach the server. Check the internet and try again.',
  'error.timeout': 'The server is taking too long. Please try again.',
  'error.badResponse': 'Could not read the server’s answer. Please try again.',
  'error.tenderedBelowTotal': 'The cash received is less than the amount due',
  'error.amountTooLarge': 'The amount is too large for the system',
  'error.promptpayNotConfigured':
    'The shop’s PromptPay account has not been set up. Please ask the owner to set it up first.',
  'error.paymentInvalidTransition':
    'This payment cannot move to that status. Another device may have done it. The data has been reloaded.',
  'error.promptpayPayloadInvalid':
    'A PromptPay QR cannot be made. Ask the owner to check the PromptPay number.',
  'error.govCopayUnavailable':
    'The government co-pay scheme is not available now (outside its dates or hours, or not paid face to face at the entrance)',
  'error.fulfillmentNotOffered':
    'That way of receiving the order is not offered on this channel. The shop delivers to the building entrance only.',
  'error.unknownBuilding':
    'The shop does not deliver to that building. Choose a building from the list again.',
  'error.unknownStaff':
    'The staff member who took this entry is not in the system. The owner should check it.',
  'error.copayChannelsNotStorefront':
    'The government co-pay scheme can only be on for the storefront channel. Choose "Storefront" only.',
  'error.ownerSignInNeeded':
    'The owner has to sign in and confirm their identity, while online, to do this.',
  'error.methodDisabled': 'The shop has switched this payment method off',
  'error.paymentAlreadyOpen': 'This order already has an unfinished payment',
  'error.orderAlreadyPaid': 'This order is already paid',
  'error.nothingToPay': 'This order has nothing to pay',
  'error.paymentNotPending': 'This payment is no longer waiting. Please reload.',
  'error.methodUnchanged': 'It already uses this payment method. Nothing changed.',
  'error.qrNotAvailable': 'This payment has no QR',
  'error.receiptNotAvailable': 'The payment is not confirmed yet, so no receipt can be issued',
  'error.qrLinkInvalid': 'The QR link is not valid',
  'error.qrLinkExpired': 'The QR link has expired. Please make a new one.',
  'error.orderHasPayment':
    'This order has a payment. Cancel the transfer claim or the payment first.',
  'error.unknownItem': 'That dish no longer exists. Please reload the menu.',
  'error.itemUnavailable': 'A dish is sold out or off the menu. Please check the order.',
  'error.itemNotOnChannel': 'A dish is not sold on this channel',
  'error.unknownOption': 'That option no longer exists. Please reload the menu.',
  'error.optionUnavailable': 'An option is sold out. Please choose again.',
  'error.groupTooFew': 'Some required options are not chosen yet',
  'error.groupTooMany': 'Too many options chosen',
  'error.unknownMenuRow': 'That category or option group was not found',
  'error.emailTaken': 'This e-mail already has an account',
  'error.inviteExists': 'This e-mail already has an open invite. Cancel it before inviting again.',
  'error.selfChange': 'You cannot change your own account here. Ask another owner.',
  'error.lastOwner':
    'There must always be one active owner, so this person cannot lose the role or be deactivated.',
  'error.ownerNeedsAccount':
    'The owner role needs an e-mail account. This person uses a PIN only: invite them by e-mail instead.',
  'error.inviteAccepted': 'This invite was already used',
  'error.inviteInvalid':
    'This invite link cannot be used. It may have expired, been used, or been cancelled. Ask the owner for a new one.',
  'error.inviteCodeInvalid':
    'That authenticator code is not right. Wait for the next code (it changes every 30 seconds) and try again.',
  'error.upgradeRequired': 'This address only speaks WebSocket',
  'outbox.badge.waiting': 'Waiting {count}',
  'outbox.badge.attention': 'Check {count}',
  'outbox.badge.label': 'Items kept on this device',
  'outbox.state.waiting': 'Waiting to sync',
  'outbox.state.attention': 'Needs attention',
  'outbox.state.blocked': 'Waiting for its order',
  'outbox.state.stuck': 'Tried several times, still trying',
  'outbox.state.old': 'Waiting over 3 days: check',
  'outbox.purged':
    '{count} entries older than 14 days, left by other staff or a replaced device, were removed.',
  'outbox.provisional': 'Temporary number {label}',
  'outbox.section.title': 'Waiting to sync',
  'outbox.section.hint':
    'Saved on this device and sent automatically when the internet is back. The kitchen and other devices cannot see these orders yet.',
  'outbox.others':
    '{count} items from other staff are on this device. They are sent when their owner signs in.',
  'outbox.others.takeOver': 'Take these over as mine',
  'outbox.others.clear': 'Clear these entries',
  'outbox.others.takeOver.title': 'Take over {count} entries left by other staff?',
  'outbox.others.takeOver.body':
    'They will be sent under your name: the server will record you as the creator of the orders and the one who took the cash, and keep the original staff member’s name in the record. Taking over or clearing is logged on the server (the internet is needed), and you will see the entries’ details.',
  'outbox.others.takeOver.confirm': 'Take over',
  'outbox.others.clear.title': 'Clear {count} entries left by other staff?',
  'outbox.others.clear.body':
    'These orders and cash entries are not in the system yet. If you clear them they are gone for good.',
  'outbox.others.clear.confirm': 'Clear all',
  'outbox.others.done.takeOver': 'Took over {count} entries.',
  'outbox.others.done.clear': 'Cleared {count} entries.',
  'outbox.others.failed': '{count} could not be done. Try again.',
  'outbox.others.forbidden': 'Only the owner can do this.',
  'outbox.others.offline':
    'Taking over or clearing other staff’s entries needs the internet, because the server must record the action. Try again when the signal is back.',
  'outbox.stepUp.waiting':
    'Some entries are sent under the original staff member’s name and need the owner to confirm their identity first. They are still on this device.',
  'outbox.stepUp.ask': 'Confirm owner identity',
  'outbox.sendNow': 'Send now',
  'outbox.retry': 'Send again',
  'outbox.discard': 'Remove this',
  'outbox.discard.title': 'Remove this unsent item?',
  'outbox.discard.order':
    'This order is not in the system and the kitchen cannot see it. If you remove it the order is gone, and any cash saved for it is removed too.',
  'outbox.discard.payment':
    'This cash payment is not recorded in the system. If you remove it, record it again on the order page.',
  'outbox.discard.stuck':
    'This entry failed many times with no answer. It may already be on the server: check the Orders page before removing it. If you remove it, it will not be sent again.',
  'outbox.error.tenderBelow':
    'The real total on the server is higher than the cash received, so sending it again would be refused. Remove this entry, then open the order and take the cash again while online.',
  'outbox.discard.confirm': 'Remove it',
  'outbox.discard.keep': 'Keep it',
  'outbox.error.storage':
    'Could not save on this device. This order was not sent and was not kept. Write it down and try again when the internet is back.',
  'outbox.error.full': 'The queue on this device is full ({max} items). Wait for it to sync first.',
  'outbox.error.noSession': 'Not signed in, so it cannot be saved.',
  'outbox.error.orderGone':
    'The order for this cash is no longer waiting here. Open it from the Orders page and take the cash there.',
  'outbox.error.unreadable': 'This item cannot be read. Remove it and enter it again.',
  'outbox.error.orderMissing':
    'The order for this item was not found. Remove it and check the orders page.',
  'outbox.refused': 'The server did not accept this: {reason}',
  'outbox.order.title': 'Order {label}',
  'outbox.order.notYet': 'Not in the system yet. The real order number comes after it syncs.',
  'outbox.order.openSynced': 'Open the synced order',
  'outbox.order.estimateHint':
    'An estimate. The server works out the real total when it syncs, and it may differ.',
  'outbox.order.noEstimate':
    'The estimate could not be worked out, so cash cannot be taken offline.',
  'outbox.cash.title': 'Cash (offline)',
  'outbox.cash.confirm': 'Save cash received (waiting to sync)',
  'outbox.cash.summary': 'Received {tendered} · change {change}',
  'outbox.cash.waiting':
    'The cash is saved on this device. It does not count as paid until the server confirms it.',
  'outbox.cash.changed': 'The amount received was corrected. The latest amount will be sent.',
  'outbox.cash.change': 'Correct the amount',
  'outbox.cash.change.title': 'Correct the cash received',
  'outbox.error.busy':
    'This cash entry was already sent or is being sent, so the amount cannot be changed. Wait for the server first.',
  'outbox.cash.estimate': 'Change is worked out from the estimated total',
  'outbox.onlineOnly': 'Offline: cash works. PromptPay and ไทยช่วยไทย need the internet.',
  'outbox.onlineOnlyCopay':
    'Offline: cash and PromptPay (QR drawn on this device) work. ไทยช่วยไทย needs the internet.',
  'outbox.promptpay.title': 'PromptPay (offline)',
  'outbox.promptpay.summary': 'QR amount {amount} ({kind})',
  'outbox.promptpay.waiting':
    'Saved: the customer paid and staff checked the bank app. It is kept on this device and does not count as paid until the server confirms.',
  'outbox.promptpay.confirmOnly':
    'The payment is made in the system. Only the confirmation is left to send.',
  'outbox.promptpay.serverAmount': 'The server’s total is {amount}',
  'outbox.promptpay.moneyTaken':
    'The customer has paid, but the system has not recorded it as paid. Check the bank app, then deal with it on the order page. Do not let the customer pay again.',
  'outbox.discard.promptpay':
    'This PromptPay payment is not recorded as paid. If you remove it, deal with the order yourself, and if the customer already transferred the money, reconcile it by hand.',
  'outbox.error.qrAmount':
    'The server’s total is not the amount in the QR, so it was not confirmed. The customer has already transferred the money: reconcile by hand.',
  'outbox.error.qrId':
    'The shop changed the PromptPay ID after this QR was shown. The money may have gone to the old account. Check the bank app and deal with it by hand.',
  'outbox.error.alreadyPaid':
    'This order was already paid from another device. The customer may have paid twice: check, and refund if needed.',
  'outbox.error.alreadyThere':
    'The system already has this entry, possibly under another staff member’s name. Check the orders list before removing it, and do not enter it again.',
  'outbox.error.alreadyOpen':
    'This order already has a payment waiting in the system. Check on the order page whether the money was taken twice.',
  'error.reorderMismatch':
    'The list was changed on another device. The latest list is loaded. Try the move again.',
  'error.cashOpeningTooOld': 'The start date is more than 10 years back. Pick a more recent date.',
  'error.unknownExpenseCategory': 'That category does not exist or is switched off. Pick another.',
  'error.taxRulesNotAvailable': 'There are no tax rules for that year yet. Try another year.',
  'error.photoEmpty': 'The photo came through empty. Choose it again.',
  'error.photoTooLarge': 'The photo is too large. Choose another one.',
  'error.photoNotImage': 'That file is not a usable image (JPEG, PNG or WebP).',
  'error.photoTooManyPixels': 'The photo is bigger than the system accepts. Choose another one.',
} as const satisfies Record<keyof typeof thErrors, string>;
