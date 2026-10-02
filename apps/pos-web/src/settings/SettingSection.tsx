import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { failureText } from './outcome-text.ts';
import type { InputOf, Loaded, ResourceName, ValueOf } from './settings-store.ts';

export interface SectionBodyProps<K extends ResourceName> {
  loaded: Loaded<ValueOf<K>>;
  /** The person may change this setting (permission). */
  editable: boolean;
  /** A change to this setting is on its way. */
  saving: boolean;
  /** No connection, or a change is on its way: Save is off. */
  busy: boolean;
  /** Saves a change (null: the form found nothing changed). True when it worked. */
  submit(input: InputOf<K> | null): Promise<boolean>;
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

  useEffect(() => {
    if (!offline) void settingsEditor.load(name);
  }, [settingsEditor, name, offline]);

  const submit = useCallback(
    async (input: InputOf<K> | null): Promise<boolean> => {
      setMessage(null);
      if (input === null) {
        setMessage({ kind: 'info', text: tr('settings.noChange') });
        return false;
      }
      const outcome = await settingsEditor.save(name, input);
      if (outcome.ok) {
        setMessage({ kind: 'ok', text: tr('settings.saved') });
        return true;
      }
      const text = failureText(tr, outcome);
      if (text) setMessage({ kind: 'error', text });
      return false;
    },
    [settingsEditor, name, tr],
  );

  const saving = state.pending.includes(name);
  const busy = offline || saving;

  return (
    <div className="sset__body">
      {offline ? (
        <p className="notice" role="status">
          <Icon name="wifi-off" />
          <span>{tr('settings.offline')}</span>
        </p>
      ) : null}
      {editable ? null : (
        <p className="notice" role="status">
          <Icon name="info" />
          <span>{tr('settings.viewOnly')}</span>
        </p>
      )}
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
          {tr('settings.loading')}
        </p>
      ) : null}
      {slot.status === 'error' ? (
        <div className="notice" role="alert">
          <Icon name="alert" />
          <span>{tr('settings.loadFailed')}</span>
          <button
            type="button"
            className="btn btn-soft"
            disabled={offline}
            onClick={() => void settingsEditor.load(name)}
          >
            {tr('common.retry')}
          </button>
        </div>
      ) : null}
      {slot.loaded ? (
        <>
          {slot.loaded.version === 0 ? <p className="hint">{tr('settings.neverSaved')}</p> : null}
          <div key={slot.loaded.version}>
            {children({ loaded: slot.loaded, editable, saving, busy, submit })}
          </div>
        </>
      ) : null}
    </div>
  );
}
