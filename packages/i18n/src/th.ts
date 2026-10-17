/**
 * Thai catalog: the source of truth for message keys (Thai-first, D-12).
 * Params use `{name}` placeholders. Keep wording short enough for an iPhone button.
 */

import { thAuth } from './th/auth.ts';
import { thCommon } from './th/common.ts';
import { thErrors } from './th/errors.ts';
import { thLiff } from './th/liff.ts';
import { thLine } from './th/line.ts';
import { thMenuEditor } from './th/menu-editor.ts';
import { thOrders } from './th/orders.ts';
import { thPayment } from './th/payment.ts';
import { thPos } from './th/pos.ts';
import { thReports } from './th/reports.ts';
import { thSettings } from './th/settings.ts';
import { thSettingsAccess } from './th/settings-access.ts';
import { thSettingsPayments } from './th/settings-payments.ts';
import { thShell } from './th/shell.ts';

export const th = {
  ...thCommon,
  ...thShell,
  ...thPos,
  ...thOrders,
  ...thPayment,
  ...thErrors,
  ...thAuth,
  ...thMenuEditor,
  ...thSettings,
  ...thSettingsAccess,
  ...thSettingsPayments,
  ...thLine,
  ...thLiff,
  ...thReports,
} as const;

export type MessageKey = keyof typeof th;
