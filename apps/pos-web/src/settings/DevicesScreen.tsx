import { formatDate } from '@sds/i18n';
import type { DeviceDto } from '@sds/shared';
import { useEffect, useState } from 'react';
import { useAuthState, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { AdminFrame, type AdminMessage } from './AdminFrame.tsx';
import { deviceKey } from './admin-store.ts';
import { adminFailureText } from './admin-text.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

/**
 * The registered devices (owner only; the list needs a fresh step-up). A device is removed after a
 * question, which ends what is open on it. The device in use cannot be removed from here. A new
 * device is registered on that device itself (the first-run screen), so this page only says so.
 */
export function DevicesScreen() {
  const { adminEditor, outbox } = useServices();
  const state = useStoreState(adminEditor);
  const offline = useStoreState(outbox).offline;
  const currentId = useAuthState().device?.id ?? null;
  const tr = useT();
  const locale = useLocale();
  const [message, setMessage] = useState<AdminMessage | null>(null);
  const [removing, setRemoving] = useState<DeviceDto | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!offline) void adminEditor.loadDevices();
  }, [adminEditor, offline]);

  async function confirmRevoke() {
    if (!removing) return;
    setDialogError(null);
    const outcome = await adminEditor.revokeDevice(removing.id);
    if (outcome.ok) {
      setRemoving(null);
      setMessage({ kind: 'ok', text: tr('settings.devices.removed') });
      return;
    }
    const text = adminFailureText(tr, outcome);
    if (text) setDialogError(text);
  }

  const time = (iso: string) => formatDate(iso, locale, 'dateTime');

  return (
    <>
      <AdminFrame
        slot={state.devices}
        offline={offline}
        message={message}
        onLoad={() => void adminEditor.loadDevices()}
      >
        <p className="hint">{tr('settings.devices.registerHint')}</p>
        {currentId === null ? (
          <p className="notice" role="note">
            <span>{tr('settings.devices.unknownSelf')}</span>
          </p>
        ) : null}
        {state.devices.items.length === 0 ? (
          <p className="muted">{tr('settings.devices.empty')}</p>
        ) : (
          <ul className="sset__list">
            {state.devices.items.map((device) => {
              const here = device.id === currentId;
              const revoked = device.revokedAt !== null;
              return (
                <li key={device.id} className={`sset__row${revoked ? ' sset__row--off' : ''}`}>
                  <div className="sset__row-main">
                    <span className="sset__row-name">{device.name}</span>
                    <span className="sset__row-meta">
                      <span className="tag">{tr(`settings.devices.kind.${device.kind}`)}</span>
                      {here ? (
                        <span className="tag tag--req">{tr('settings.devices.thisDevice')}</span>
                      ) : null}
                      <span className="muted">
                        {device.lastSeenAt
                          ? tr('settings.devices.lastSeen', { time: time(device.lastSeenAt) })
                          : tr('settings.devices.neverSeen')}
                      </span>
                      {device.revokedAt ? (
                        <span className="muted">
                          {tr('settings.devices.revokedAt', { time: time(device.revokedAt) })}
                        </span>
                      ) : null}
                    </span>
                    {here ? (
                      <span className="hint">{tr('settings.devices.revokeCurrent')}</span>
                    ) : null}
                  </div>
                  {!revoked && !here && currentId !== null ? (
                    <button
                      type="button"
                      className="btn btn-soft"
                      aria-label={tr('settings.devices.revoke', { name: device.name })}
                      disabled={offline || state.pending.includes(deviceKey(device.id))}
                      onClick={() => {
                        setMessage(null);
                        setDialogError(null);
                        setRemoving(device);
                      }}
                    >
                      {tr('settings.devices.revokeConfirm')}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </AdminFrame>
      {removing ? (
        <ConfirmDialog
          title={tr('settings.devices.revokeTitle')}
          body={tr('settings.devices.revokeBody', { name: removing.name })}
          confirmLabel={tr('settings.devices.revokeConfirm')}
          busy={state.pending.includes(deviceKey(removing.id))}
          error={dialogError}
          onConfirm={() => void confirmRevoke()}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}
