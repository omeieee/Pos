import type { thLine } from '../th/line.ts';

/** English catalog: the LINE bot replies and LINE ordering. `satisfies` makes a missing or extra key a type error. */
export const enLine = {
  'line.menu.title': 'Menu',
  'line.menu.closed': 'Not taking orders · reopens {time}',
  'line.menu.reorder': 'Order again',
  'line.cart.viewCart': 'View cart · {count} items',
  'line.checkout.title': 'Review order',
  'line.checkout.pickup': 'Pick up',
  'line.checkout.roomDelivery': 'Deliver to room',
  'line.checkout.roomNumber': 'Room number',
  'line.checkout.paymentMethod': 'Payment method',
  'line.checkout.cashNote': 'Pay cash when you collect',
  'line.checkout.govCopayPickupOnly': 'Thai Chuay Thai is for pick-up only',
  'line.checkout.privacy': 'We use your room number and order history only to deliver',
  'line.checkout.placeOrder': 'Place order · {amount}',
  'line.checkout.staffConfirms': 'The shop checks your transfer and confirms in chat',
  'lineBot.greeting': 'Welcome to Saap Don Sen',
  'lineBot.greetingHow':
    'Tap "Order" in the menu below to order. We deliver to the building entrance only.',
  'lineBot.privacy.title': 'Privacy notice',
  'lineBot.privacy.summary':
    'The shop keeps your LINE user ID, your LINE display name and profile picture (used to call the right person in the kitchen), your orders, and the slip picture if you send one (kept 90 days), to prepare, deliver and take payment for them and to keep the shop accounts. The shop sends the data in the QR code on the slip (or the slip picture if the QR cannot be read) to the slip-checking provider Slip2Go (Slip2Go Co., Ltd.) to confirm the transfer really reached the shop and to prevent fake slips; the provider may process it outside Thailand. If the system detects a slip that is probably fake, the shop records this event on your record to prevent fraud; a person on staff checks it, the system does not refuse your orders automatically, and you can ask the shop to review or correct it. When an order is paid, or a slip needs a person on staff to check it, the shop sends an alert to a private Telegram group of the owner and staff. The alert has your LINE name and profile picture, the recipient name given in the order, the building, the dishes and the total (never a phone number, room, note or slip picture). Telegram (Telegram Messenger Inc.) is the provider and may keep this message outside Thailand. If you fill in your member profile (full name, nickname, phone, building), the shop uses it to tell who an order belongs to and to contact you about it. Every field is optional; leave it empty or clear it any time. The profile is kept until you ask to erase it, or 24 months after your last order. Names, buildings and LINE names on orders are erased 30 days after an order is done. Data controller: {controller}. To see, correct or delete your data, write to {contact}.',
  'lineBot.privacy.readNotice': 'Read the full notice',
  'lineBot.privacy.ackButton': 'I understand',
  'lineBot.privacy.acked': 'Thank you. Your acknowledgement of the privacy notice is saved.',
  'lineBot.order.title': 'Order {orderNo} confirmed',
  'lineBot.order.altText': 'Order {orderNo} confirmed, total {total}',
  'lineBot.order.total': 'Total',
  'lineBot.order.deliverTo': 'Deliver to the entrance of building {building} · {name}',
  'lineBot.pay.title': 'How to pay · {orderNo}',
  'lineBot.pay.altText': 'How to pay order {orderNo}, total {total}',
  'lineBot.pay.cash':
    'Pay cash when you collect the food at the building entrance. Total {amount}.',
  'lineBot.pay.promptpay': 'Transfer by PromptPay to {promptpayId}, exactly {amount}.',
  'lineBot.pay.promptpayAfter':
    'After you transfer, tap "I have paid" or send the slip in this chat. Staff will check that the money arrived.',
  'lineBot.pay.govCopay': "Thai Chuay Thai: we'll send you the QR shortly. Full price {amount}.",
  'lineBot.pay.govCopayNote': 'Sending it to you in just a moment.',
  'lineBot.pay.paidButton': 'I have paid',
  'lineBot.pay.changeButton': 'Change payment method',
  'lineBot.ready.title': 'Your food is ready · {orderNo}',
  'lineBot.ready.body': 'Order {orderNo} is ready at the entrance of building {building}',
  'lineBot.ready.altText': 'Your food is ready, order {orderNo}',
  'lineBot.orderChange.voided': 'The shop has cancelled order {orderNo}.',
  'lineBot.orderChange.edited':
    'The shop has changed the items of order {orderNo}. New total {total}',
  'lineBot.orderChange.refund': 'The shop has refunded {amount}',
  'lineBot.orderChange.due': 'Amount to pay: {amount}. You can pay the shop directly.',
  'lineBot.paymentRejected':
    'The shop could not find your transfer for order {orderNo}. Please check and pay again, attach the slip, or contact the shop.',
  'lineBot.receipt.title': 'Electronic receipt',
  'lineBot.receipt.total': 'Amount paid',
  'lineBot.receipt.method': 'Paid by {method}',
  'lineBot.receipt.thanks': 'Thank you for ordering from Saap Don Sen.',
  'lineBot.pay.openQr': 'Open PromptPay QR',
  'lineBot.pay.qrNote':
    'Tap the button below to open the QR for the exact order total (a fresh QR every time).',
  'lineBot.pick.title': 'Choose how to pay · {orderNo}',
  'lineBot.pick.altText': 'Choose how to pay order {orderNo}',
  'lineBot.pick.hint': 'Total {amount} · tap to change the payment method',
  'lineBot.claim.noSlip':
    'We got your transfer notice for order {orderNo}. Please send the picture of your transfer slip in this chat so we can check it faster. Staff will also check that the money arrived.',
  'lineBot.claim.slipReceived':
    'We got the slip for order {orderNo} and are checking it. Staff will see the money arrive and confirm.',
  'lineBot.err.generic': 'That did not work. Please try again, or type your question here.',
  'lineBot.err.noOrder': 'We cannot find that order on your account.',
  'lineBot.err.claimed':
    'This order is already marked as paid by you, so the method cannot change. Please tell staff in this chat.',
  'lineBot.err.closed': 'This order is closed or already paid, so it cannot change.',
  'lineBot.err.methodUnavailable':
    'That payment method is not available right now. Please pick another.',
  'lineBot.err.slipCooldown':
    'Slips are being sent too often. Please wait {minutes} min and send again.',
  'lineBot.err.slipBlocked':
    'A slip cannot be sent for this order. Please tap "I have paid" and staff will check with the bank.',
  'lineBot.status.title': 'Order {orderNo} status',
  'lineBot.status.altText': 'Order {orderNo}: {status}',
  'lineBot.status.order': 'Order: {status}',
  'lineBot.status.payment': 'Payment: {payment}',
  'lineBot.status.open': 'See details',
  'lineBot.status.none': 'You have no order in progress. Tap "Order" in the menu below to order.',
  'lineBot.status.new': 'Waiting for the shop to accept',
  'lineBot.status.preparing': 'Being prepared',
  'lineBot.status.ready': 'Ready at the building entrance',
  'lineBot.status.completed': 'Handed over',
  'lineBot.status.cancelled': 'Cancelled',
  'lineBot.menu.text':
    'See the menu and order with the button below. We deliver to the building entrance only.',
  'lineBot.menu.open': 'Open the menu',
  'lineBot.payInfo.title': 'How to pay',
  'lineBot.payInfo.promptpay':
    'PromptPay: transfer the order total, then tap "I have paid". Staff check the money arrived.',
  'lineBot.payInfo.cash': 'Cash: pay when you collect at the building entrance.',
  'lineBot.payInfo.govCopay':
    "Thai Chuay Thai: we'll send you the QR shortly (only while the scheme runs).",
  'lineBot.payInfo.altText': 'How to pay: PromptPay, cash, Thai Chuay Thai',
  'lineBot.contact.reply': 'Got it. Staff will reply in this chat.',
  'lineBot.hours.today': 'Today we deliver {from}–{to} (to the building entrance only).',
  'lineBot.hours.closed': 'The shop is closed today.',
  'lineBot.hours.always':
    'We are taking orders at any time (delivery to the building entrance only).',
  'lineBot.hours.paused': 'We are not taking orders through LINE right now.',
  'lineBot.slip.reply':
    'We got your picture. Please tap "I have paid" on the payment card; staff will then check the money arrived.',
  'lineBot.receipt.altText': 'Receipt for order {orderNo}',
  'lineBot.receipt.deliveredTo': 'Delivered to the entrance of building {building}',
} as const satisfies Record<keyof typeof thLine, string>;
