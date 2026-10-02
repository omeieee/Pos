import type { ReactNode } from 'react';
import { useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import type { ListSlot } from './admin-store.ts';

export type AdminMessage = { kind: 'ok' | 'error'; text: string };

/**
 * The frame of a devices or staff list: says plainly when the device is offline, when the list
 * waits for the owner to confirm who they are (a step-up the person closed), while it loads, and
 * when it could not be read. The rows themselves are the children.
 */
export function AdminFrame({
  slot,
  offline,
  message,
  onLoad,
  children,
}: {
  slot: ListSlot<unknown>;
  offline: boolean;
  message: AdminMessage | null;
  onLoad: () => void;
  children: ReactNode;
}) {
  const tr = useT();
  return (
    <div className="sset__body">
      {offline ? (
        <p className="notice" role="status">
          <Icon name="wifi-off" />
          <span>{tr('settings.offline')}</span>
        </p>
      ) : null}
      {message ? (
        <p
          className={message.kind === 'error' ? 'error' : 'sset__message'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
      {slot.status === 'loading' ? (
        <p className="muted" role="status">
          {tr('settings.admin.loading')}
        </p>
      ) : null}
      {slot.status === 'locked' ? (
        <div className="notice" role="status">
          <Icon name="info" />
          <span>{tr('settings.admin.locked')}</span>
          <button type="button" className="btn btn-soft" disabled={offline} onClick={onLoad}>
            {tr('settings.admin.unlock')}
          </button>
        </div>
      ) : null}
      {slot.status === 'error' ? (
        <div className="notice" role="alert">
          <Icon name="alert" />
          <span>{tr('settings.admin.loadFailed')}</span>
          <button type="button" className="btn btn-soft" disabled={offline} onClick={onLoad}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}
      {slot.status === 'ready' ? children : null}
    </div>
  );
}
