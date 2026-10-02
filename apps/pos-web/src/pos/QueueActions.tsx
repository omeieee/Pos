import { useState } from 'react';
import type { IconName } from '../app/routes.ts';
import { useNow, useServices, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { isOldEntry, type QueueItem } from './outbox-model.ts';
import { entryErrorText, stateKey } from './outbox-text.ts';

const TONE: Record<QueueItem['state'], { tone: string; icon: IconName }> = {
  queued: { tone: 'warning', icon: 'sync' },
  attention: { tone: 'danger', icon: 'alert' },
  blocked: { tone: 'neutral', icon: 'clock' },
};

/** The state of an entry: colour, icon and words together (a state is never colour alone). */
export function QueueStateBadge({
  item,
}: {
  item: Pick<QueueItem, 'state' | 'stuck' | 'createdAt'>;
}) {
  const tr = useT();
  const now = useNow(60_000);
  const { tone, icon } = TONE[item.state];
  return (
    <>
      <span className={`status status--${tone}`}>
        <Icon name={icon} />
        {tr(stateKey(item))}
      </span>
      {isOldEntry(item.createdAt, now) ? (
        <span className="status status--danger">
          <Icon name="clock" />
          {tr('outbox.state.old')}
        </span>
      ) : null}
    </>
  );
}

/**
 * What a person can do with an entry that is waiting or refused. A refused entry shows the
 * server's reason and can be sent again (unless its request id was reused: then only removed) or
 * removed after a confirmation that says what is lost. A stuck one can be tried now. A waiting one
 * has no controls: it sends itself.
 */
export function QueueActions({ item }: { item: QueueItem }) {
  const { outbox } = useServices();
  const tr = useT();
  const [confirming, setConfirming] = useState(false);

  if (item.state === 'blocked') return null;
  // Waiting and not stuck: it sends itself. Stuck: tried many times without an answer, so it can
  // be tried now or removed.
  const stuck = item.state === 'queued';
  if (stuck && !item.stuck) return null;

  return (
    <div className="qactions">
      {stuck ? null : (
        <p className="error" role="alert">
          {entryErrorText(tr, item.error)}
        </p>
      )}
      <div className="qactions__row">
        {stuck ? (
          <button type="button" className="btn btn-primary" onClick={() => outbox.kick()}>
            <Icon name="sync" />
            {tr('outbox.sendNow')}
          </button>
        ) : null}
        {item.canRetry ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void outbox.retry(item.id)}
          >
            <Icon name="sync" />
            {tr('outbox.retry')}
          </button>
        ) : null}
        <button type="button" className="btn btn-soft" onClick={() => setConfirming(true)}>
          {tr('outbox.discard')}
        </button>
      </div>
      {confirming ? (
        <Modal labelledBy={`discard-${item.id}`} onClose={() => setConfirming(false)}>
          <h2 id={`discard-${item.id}`} className="sheet__title">
            {tr('outbox.discard.title')}
          </h2>
          <p>
            {tr(
              stuck
                ? 'outbox.discard.stuck'
                : item.kind === 'order'
                  ? 'outbox.discard.order'
                  : 'outbox.discard.payment',
            )}
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => setConfirming(false)}
          >
            {tr('outbox.discard.keep')}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => {
              setConfirming(false);
              void outbox.discard(item.id);
            }}
          >
            {tr('outbox.discard.confirm')}
          </button>
        </Modal>
      ) : null}
    </div>
  );
}
