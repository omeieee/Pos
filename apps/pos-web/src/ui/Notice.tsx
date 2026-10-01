import type { MessageKey } from '@sds/i18n';
import type { Notice as NoticeCode } from '../auth/auth-store.ts';
import { useT } from './hooks.ts';
import { Icon } from './Icon.tsx';

const NOTICE_KEYS: Record<NoticeCode, MessageKey> = {
  sessionExpired: 'auth.notice.sessionExpired',
  deviceRemoved: 'auth.notice.deviceRemoved',
  deviceMismatch: 'auth.notice.deviceMismatch',
};

/** The one-time explanation for why the person is back at a sign-in screen. */
export function Notice({ notice }: { notice: NoticeCode | null }) {
  const tr = useT();
  if (!notice) return null;
  return (
    <p className="notice" role="status">
      <Icon name="alert" />
      <span>{tr(NOTICE_KEYS[notice])}</span>
    </p>
  );
}
