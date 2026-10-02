import type { MessageKey } from '@sds/i18n';
import type { IconName } from '../app/routes.ts';
import type { ConnectionStatus } from '../realtime/connection.ts';
import { useConnection, useT } from './hooks.ts';
import { Icon } from './Icon.tsx';

const LABELS: Record<Exclude<ConnectionStatus, 'idle'>, MessageKey> = {
  online: 'net.online',
  connecting: 'net.connecting',
  reconnecting: 'net.reconnecting',
  offline: 'net.offline',
};

const ICONS: Record<Exclude<ConnectionStatus, 'idle'>, IconName> = {
  online: 'check-circle',
  connecting: 'sync',
  reconnecting: 'sync',
  offline: 'wifi-off',
};

/** Colour, icon and words together: the state is never carried by colour alone (brand §3). */
export function ConnectionBadgeView({ status }: { status: ConnectionStatus }) {
  const tr = useT();
  if (status === 'idle') return null;
  return (
    <span className={`net net--${status}`} role="status" aria-live="polite">
      <Icon name={ICONS[status]} />
      <span>{tr(LABELS[status])}</span>
    </span>
  );
}

export function ConnectionBadge() {
  return <ConnectionBadgeView status={useConnection().status} />;
}
