import { enAuth } from './en/auth.ts';
import { enCommon } from './en/common.ts';
import { enErrors } from './en/errors.ts';
import { enFinance } from './en/finance.ts';
import { enLiff } from './en/liff.ts';
import { enLine } from './en/line.ts';
import { enMenuEditor } from './en/menu-editor.ts';
import { enOrders } from './en/orders.ts';
import { enPayment } from './en/payment.ts';
import { enPos } from './en/pos.ts';
import { enPrint } from './en/print.ts';
import { enPush } from './en/push.ts';
import { enReports } from './en/reports.ts';
import { enSettings } from './en/settings.ts';
import { enSettingsAccess } from './en/settings-access.ts';
import { enSettingsPayments } from './en/settings-payments.ts';
import { enShell } from './en/shell.ts';
import type { MessageKey } from './th.ts';

/** English catalog. `satisfies` makes a missing or extra key a type error. */
export const en = {
  ...enCommon,
  ...enShell,
  ...enPos,
  ...enOrders,
  ...enPayment,
  ...enErrors,
  ...enAuth,
  ...enMenuEditor,
  ...enSettings,
  ...enSettingsAccess,
  ...enSettingsPayments,
  ...enLine,
  ...enLiff,
  ...enReports,
  ...enFinance,
  ...enPrint,
  ...enPush,
} as const satisfies Record<MessageKey, string>;
