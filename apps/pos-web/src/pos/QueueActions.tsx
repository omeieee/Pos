import { useState } from 'react';
import type { IconName } from '../app/routes.ts';
import { useServices, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import type { QueueItem } from './outbox-model.ts';
import { entryErrorText, stateKey } from './outbox-text.ts';

const TONE: Record<QueueItem['state'], { tone: string; icon: IconName }> = {
  queued: { tone: 'warning', icon: 'sync' },
  attention: { tone: 'danger', icon: 'alert' },
  blocked: { tone: 'neutral', icon: 'clock' },
};

/** The state of an entry: colour, icon and words together (a state is never colour alone). */
export function QueueStateBadge({ item }: { item: Pick<QueueItem, 'state' | 'stuck'> }) {
  const tr = useT();
  const { tone, icon } = TONE[item.state];
  return (
    <span className={`status status--${tone}`}>
      <Icon name={icon} />
      {tr(stateKey(item))}
    </span>
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

  if (item.state === 'queued') {
    return item.stuck ? (
      <div className="qactions">
        <button type="button" className="btn" onClick={() => outbox.kick()}>
          <Icon name="sync" />
          {tr('outbox.sendNow')}
        </button>
      </div>
    ) : null;
  }
  if (item.state === 'blocked') return null;

  return (
    <div className="qactions">
      <p className="error" role="alert">
        {entryErrorText(tr, item.error)}
      </p>
      <div className="qactions__row">
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
          <p>{tr(item.kind === 'order' ? 'outbox.discard.order' : 'outbox.discard.payment')}</p>
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
