import type { MessageKey } from '@sds/i18n';
import type { ReactNode } from 'react';
import type { Notice as NoticeCode } from '../auth/auth-store.ts';
import { Gi, type GiName } from '../design/icons.tsx';
import { useT } from './hooks.ts';
import './glass-forms.css';

const NOTICE_KEYS: Record<NoticeCode, MessageKey> = {
  sessionExpired: 'auth.notice.sessionExpired',
  deviceRemoved: 'auth.notice.deviceRemoved',
  deviceMismatch: 'auth.notice.deviceMismatch',
};

export type CalloutTone = 'info' | 'warn' | 'bad' | 'ok' | 'mute';

const TONE_ICON: Record<CalloutTone, GiName> = {
  info: 'info',
  warn: 'warn',
  bad: 'warn',
  ok: 'check',
  mute: 'info',
};

/**
 * A message block in the design language: a soft tinted panel with an icon and words (never colour
 * alone), and an optional action on the right. `role` is the live-region role the caller needs
 * (`status` for news, `alert` for something that needs action, `note` for a standing remark).
 */
export function Callout({
  tone = 'info',
  icon,
  role,
  action,
  children,
}: {
  tone?: CalloutTone;
  icon?: GiName;
  role?: 'status' | 'alert' | 'note';
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`gcall gcall--${tone}`} role={role}>
      <Gi n={icon ?? TONE_ICON[tone]} size="sm" />
      <span className="gcall__text">{children}</span>
      {action ? <span className="gcall__action">{action}</span> : null}
    </div>
  );
}

/** The one-time explanation for why the person is back at a sign-in screen. */
export function Notice({ notice }: { notice: NoticeCode | null }) {
  const tr = useT();
  if (!notice) return null;
  return (
    <Callout tone="warn" role="status">
      {tr(NOTICE_KEYS[notice])}
    </Callout>
  );
}
