import type { MessageKey } from '@sds/i18n';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import type { ConnectionStatus } from '../realtime/connection.ts';
import { useConnection, useServices, useStoreState, useT } from './hooks.ts';

const LABELS: Record<Exclude<ConnectionStatus, 'idle'>, MessageKey> = {
  online: 'net.online',
  connecting: 'net.connecting',
  reconnecting: 'net.reconnecting',
  offline: 'net.offline',
};

const ICONS: Record<Exclude<ConnectionStatus, 'idle'>, GiName> = {
  online: 'check',
  connecting: 'clock',
  reconnecting: 'clock',
  offline: 'warn',
};

const INK: Record<Exclude<ConnectionStatus, 'idle'>, string> = {
  online: 'var(--jade-ink)',
  connecting: 'var(--amber-ink)',
  reconnecting: 'var(--amber-ink)',
  offline: 'var(--chili-ink)',
};

/**
 * The "ซิงก์แล้ว" pill of the design: a glass pill with the pulsing green dot. The other states
 * keep the pill and swap the dot for an icon, the words and the colour together, so a state is
 * never told by colour alone. On a phone only the dot (or the icon) shows, the words become the title.
 */
export function SyncPillView({
  status,
  compact = false,
}: {
  status: ConnectionStatus;
  compact?: boolean;
}) {
  const tr = useT();
  if (status === 'idle') return null;
  const label = tr(LABELS[status]);
  const mark =
    status === 'online' ? <span className="g-dot" /> : <Gi n={ICONS[status]} size="sm" />;
  return (
    <span
      className={`g-glass net net--${status}`}
      role="status"
      aria-live="polite"
      title={label}
      style={
        compact
          ? s(
              `height:48px;width:48px;border-radius:50%;display:grid;place-items:center;color:${INK[status]}`,
            )
          : s(
              `height:48px;padding:0 16px;border-radius:999px;display:flex;align-items:center;gap:9px;font-size:14px;font-weight:600;white-space:nowrap;color:${INK[status]}`,
            )
      }
    >
      {mark}
      {compact ? <span className="visually-hidden">{label}</span> : label}
    </span>
  );
}

export function SyncPill({ compact = false }: { compact?: boolean }) {
  return <SyncPillView status={useConnection().status} compact={compact} />;
}

/**
 * Orders and payments kept on this device and not sent yet: a second pill next to the sync pill.
 * It links to the orders page, where the waiting entries are listed. Nothing shows when nothing waits.
 */
export function OutboxPill() {
  const state = useStoreState(useServices().outbox);
  const tr = useT();
  const attention = state.items.filter((i) => i.state === 'attention').length;
  const waiting = state.items.length - attention;
  if (state.items.length === 0) return null;
  return (
    <a
      className="g-glass qbadge"
      href="#/orders"
      aria-label={tr('outbox.badge.label')}
      style={s(
        'height:48px;padding:0 16px;border-radius:999px;display:flex;align-items:center;gap:12px;font-size:14px;font-weight:600;white-space:nowrap;text-decoration:none;color:var(--ink)',
      )}
    >
      {waiting > 0 ? (
        <span
          className="qbadge__part qbadge__part--waiting"
          style={s('display:inline-flex;align-items:center;gap:6px;color:var(--amber-ink)')}
        >
          <Gi n="pending" size="sm" />
          <span>{tr('outbox.badge.waiting', { count: waiting })}</span>
        </span>
      ) : null}
      {attention > 0 ? (
        <span
          className="qbadge__part qbadge__part--attention"
          style={s('display:inline-flex;align-items:center;gap:6px;color:var(--chili-ink)')}
        >
          <Gi n="warn" size="sm" />
          <span>{tr('outbox.badge.attention', { count: attention })}</span>
        </span>
      ) : null}
    </a>
  );
}

/**
 * The waiting-entries pill for a page that has no header of its own with the sync state (the
 * settings, the menu editor, the overview): a refused or unsent order or payment is never out of
 * sight, on any page. Nothing is drawn when nothing waits.
 */
export function OutboxStrip() {
  const waiting = useStoreState(useServices().outbox).items.length;
  if (waiting === 0) return null;
  return (
    <div style={s('display:flex;justify-content:flex-end;flex:none')}>
      <OutboxPill />
    </div>
  );
}
