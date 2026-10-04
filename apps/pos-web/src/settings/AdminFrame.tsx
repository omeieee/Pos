import type { ReactNode } from 'react';
import { s } from '../design/style.ts';
import { useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
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
    <div style={s('display:flex;flex-direction:column;gap:14px')}>
      {offline ? (
        <Callout tone="warn" role="status">
          {tr('settings.offline')}
        </Callout>
      ) : null}
      {message ? (
        <Callout
          tone={message.kind === 'error' ? 'bad' : 'ok'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </Callout>
      ) : null}
      {slot.status === 'loading' ? (
        <p className="g-t-s" style={s('margin:0')} role="status">
          {tr('settings.admin.loading')}
        </p>
      ) : null}
      {slot.status === 'locked' ? (
        <Callout
          tone="info"
          role="status"
          icon="lock"
          action={
            <button type="button" className="g-btn gbtn-row" disabled={offline} onClick={onLoad}>
              {tr('settings.admin.unlock')}
            </button>
          }
        >
          {tr('settings.admin.locked')}
        </Callout>
      ) : null}
      {slot.status === 'error' ? (
        <Callout
          tone="bad"
          role="alert"
          action={
            <button type="button" className="g-btn gbtn-row" disabled={offline} onClick={onLoad}>
              {tr('common.retry')}
            </button>
          }
        >
          {tr('settings.admin.loadFailed')}
        </Callout>
      ) : null}
      {slot.status === 'ready' ? children : null}
    </div>
  );
}
