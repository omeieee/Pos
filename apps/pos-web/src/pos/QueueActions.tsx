import { useState } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useNow, useServices, useT } from '../ui/hooks.ts';
import { isOldEntry, type QueueItem } from './outbox-model.ts';
import { entryErrorText, stateKey } from './outbox-text.ts';
import { Callout, PayModal, SheetBody, SheetTitle } from './PayParts.tsx';

const TONE: Record<QueueItem['state'], { tone: 'warn' | 'bad' | 'mute'; icon: GiName }> = {
  queued: { tone: 'warn', icon: 'clock' },
  attention: { tone: 'bad', icon: 'warn' },
  blocked: { tone: 'mute', icon: 'clock' },
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
      <span className={`g-badge g-b-${tone}`}>
        <Gi n={icon} />
        {tr(stateKey(item))}
      </span>
      {isOldEntry(item.createdAt, now) ? (
        <span className="g-badge g-b-bad">
          <Gi n="clock" />
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
    <div style={s('display:flex;flex-direction:column;gap:10px;flex:none')}>
      {stuck ? null : (
        <Callout tone="bad" role="alert">
          {entryErrorText(tr, item.error)}
        </Callout>
      )}
      <div style={s('display:flex;gap:10px;flex-wrap:wrap')}>
        {stuck ? (
          <button type="button" className="g-btn g-btn-p" onClick={() => outbox.kick()}>
            {tr('outbox.sendNow')}
          </button>
        ) : null}
        {item.canRetry ? (
          <button
            type="button"
            className="g-btn g-btn-p"
            onClick={() => void outbox.retry(item.id)}
          >
            {tr('outbox.retry')}
          </button>
        ) : null}
        <button type="button" className="g-btn" onClick={() => setConfirming(true)}>
          {tr('outbox.discard')}
        </button>
      </div>
      {confirming ? (
        <PayModal labelledBy={`discard-${item.id}`} onClose={() => setConfirming(false)}>
          <SheetBody>
            <SheetTitle id={`discard-${item.id}`}>{tr('outbox.discard.title')}</SheetTitle>
            <p className="g-t-s" style={s('margin:0')}>
              {tr(
                stuck
                  ? 'outbox.discard.stuck'
                  : item.kind === 'order'
                    ? 'outbox.discard.order'
                    : item.method === 'promptpay'
                      ? 'outbox.discard.promptpay'
                      : 'outbox.discard.payment',
              )}
            </p>
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg g-btn-block"
              onClick={() => setConfirming(false)}
            >
              {tr('outbox.discard.keep')}
            </button>
            <button
              type="button"
              className="g-btn g-btn-block"
              style={s('color:var(--chili-ink)')}
              onClick={() => {
                setConfirming(false);
                void outbox.discard(item.id);
              }}
            >
              {tr('outbox.discard.confirm')}
            </button>
          </SheetBody>
        </PayModal>
      ) : null}
    </div>
  );
}
