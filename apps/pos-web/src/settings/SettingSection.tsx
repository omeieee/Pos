import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { s } from '../design/style.ts';
import { useEntities, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { failureText } from './outcome-text.ts';
import type { InputOf, Loaded, ResourceName, SaveOutcome, ValueOf } from './settings-store.ts';

/** The key a setting travels under in the realtime feed. */
const FEED_KEY: Record<ResourceName, string> = {
  shop: 'shop',
  hours: 'opening_hours',
  numbering: 'business_day',
  payments: 'payment_methods',
  delivery: 'delivery',
  lineOrdering: 'line_ordering',
  promptpay: 'promptpay',
  copay: 'gov_copay',
};

export interface SectionBodyProps<K extends ResourceName> {
  loaded: Loaded<ValueOf<K>>;
  /** The person may change this setting (permission). */
  editable: boolean;
  /** A change to this setting is on its way. */
  saving: boolean;
  /** No connection, or a change is on its way: Save is off. */
  busy: boolean;
  /**
   * Saves a change; `null` input means the form found nothing changed. Answers the outcome (null
   * when nothing was sent for lack of a change). The failure goes to the top of the page too,
   * unless `quiet` (a dialog that shows it itself).
   */
  submit(
    input: InputOf<K> | null,
    options?: { quiet?: boolean },
  ): Promise<SaveOutcome<ValueOf<K>> | null>;
}

type Message = { kind: 'ok' | 'info' | 'error'; text: string };

/**
 * The frame of one settings form: reads the setting when the page opens (and again when the
 * connection comes back), says plainly when the device is offline or the person may only look,
 * shows the first-read failure with a retry, and shows the outcome of a save. The form itself is
 * keyed by the saved version, so after a save (or a re-read after a conflict) it starts again from
 * what the server holds.
 */
export function SettingSection<K extends ResourceName>({
  name,
  editable,
  children,
}: {
  name: K;
  editable: boolean;
  children: (props: SectionBodyProps<K>) => ReactNode;
}) {
  const { settingsEditor, outbox } = useServices();
  const state = useStoreState(settingsEditor);
  const offline = useStoreState(outbox).offline;
  const tr = useT();
  const [message, setMessage] = useState<Message | null>(null);
  const slot = state.slots[name];
  const feed = useEntities().settings.get(FEED_KEY[name]);
  // Another device saved a newer version than the one on this screen. Nothing is replaced under a
  // half-typed form: the person is told and chooses to load it.
  const changedElsewhere =
    slot.loaded !== null && feed !== undefined && feed.version > slot.loaded.version;

  useEffect(() => {
    if (!offline) void settingsEditor.load(name);
  }, [settingsEditor, name, offline]);

  const submit = useCallback(
    async (
      input: InputOf<K> | null,
      options: { quiet?: boolean } = {},
    ): Promise<SaveOutcome<ValueOf<K>> | null> => {
      setMessage(null);
      if (input === null) {
        setMessage({ kind: 'info', text: tr('settings.noChange') });
        return null;
      }
      const outcome = await settingsEditor.save(name, input);
      if (outcome.ok) {
        setMessage({ kind: 'ok', text: tr('settings.saved') });
      } else if (!options.quiet || (outcome.reason === 'error' && outcome.refreshed)) {
        // A dialog that shows its own failure stays quiet here, except when the setting was read
        // again: that dialog closes, so the page says it.
        const text = failureText(tr, outcome);
        if (text) setMessage({ kind: 'error', text });
      }
      return outcome;
    },
    [settingsEditor, name, tr],
  );

  const saving = state.pending.includes(name);
  const busy = offline || saving;

  return (
    <div style={s('display:flex;flex-direction:column;gap:14px')}>
      {offline ? (
        <Callout tone="warn" role="status">
          {tr('settings.offline')}
        </Callout>
      ) : null}
      {editable ? null : (
        <Callout tone="info" role="status">
          {tr('settings.viewOnly')}
        </Callout>
      )}
      {changedElsewhere && !state.pending.includes(name) ? (
        <Callout
          tone="info"
          role="status"
          action={
            <button
              type="button"
              className="g-btn gbtn-row"
              disabled={offline}
              onClick={() => void settingsEditor.load(name)}
            >
              {tr('settings.reload')}
            </button>
          }
        >
          {tr('settings.changedElsewhere')}
        </Callout>
      ) : null}
      {message ? (
        <Callout
          tone={message.kind === 'error' ? 'bad' : message.kind === 'ok' ? 'ok' : 'info'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </Callout>
      ) : null}
      {slot.status === 'loading' ? (
        <p className="g-t-s" style={s('margin:0')} role="status">
          {tr('settings.loading')}
        </p>
      ) : null}
      {slot.status === 'error' ? (
        <Callout
          tone="bad"
          role="alert"
          action={
            <button
              type="button"
              className="g-btn gbtn-row"
              disabled={offline}
              onClick={() => void settingsEditor.load(name)}
            >
              {tr('common.retry')}
            </button>
          }
        >
          {tr('settings.loadFailed')}
        </Callout>
      ) : null}
      {slot.loaded ? (
        <>
          {slot.loaded.version === 0 ? (
            <p className="g-t-c" style={s('margin:0')}>
              {tr('settings.neverSaved')}
            </p>
          ) : null}
          <div key={slot.loaded.version}>
            {children({ loaded: slot.loaded, editable, saving, busy, submit })}
          </div>
        </>
      ) : null}
    </div>
  );
}
