import { useEffect } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { FormCard, SwitchRow } from '../ui/FormParts.tsx';
import { useHasPermission, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import type { PushAlertsProblem } from './push-alerts-store.ts';
import { SettingsPage } from './SettingsPage.tsx';

const PROBLEM_KEYS = {
  dismissed: 'push.error.dismissed',
  enable: 'push.error.enable',
  disable: 'push.error.disable',
} as const satisfies Record<PushAlertsProblem, string>;

/**
 * Phone alerts of this device (`#/alerts`): one switch, and plain words for every reason it may not
 * be available. Open to every signed-in role (the kitchen has no Settings), reached from the
 * account menu and from Settings. The state and its rules are in push-alerts-store.ts; this only
 * shows them. The browser's permission prompt starts from the tap on the switch, never from opening
 * the page.
 */
export function PhoneAlertsScreen() {
  const tr = useT();
  const { pushAlerts, paymentPopup, lifecycle } = useServices();
  const state = useStoreState(pushAlerts);
  const popup = useStoreState(paymentPopup);
  const hasSettings = useHasPermission('settings.view');

  // Read when the page opens, and again when the person comes back from the system settings
  // (where they may have allowed notifications).
  useEffect(() => {
    void pushAlerts.load();
    return lifecycle.subscribe({ visible: () => void pushAlerts.load() });
  }, [pushAlerts, lifecycle]);

  const { status, busy, problem } = state;
  const retry = (key: 'push.retry' | 'push.denied.recheck') => (
    <button type="button" className="g-btn" onClick={() => void pushAlerts.load()}>
      {tr(key)}
    </button>
  );

  function body() {
    switch (status) {
      case 'idle':
      case 'loading':
        return (
          <p className="g-t-s" role="status" style={s('margin:0')}>
            {tr('push.state.loading')}
          </p>
        );
      case 'error':
        return (
          <Callout tone="warn" role="alert" action={retry('push.retry')}>
            {tr('push.error.load')}
          </Callout>
        );
      case 'not-configured':
        return (
          <Callout tone="info" role="status">
            {tr('push.notConfigured')}
          </Callout>
        );
      case 'unsupported':
        return (
          <Callout tone="warn" role="status">
            {tr('push.unsupported')}
          </Callout>
        );
      case 'no-device':
        return (
          <Callout tone="warn" role="status">
            {tr('push.deviceRequired')}
          </Callout>
        );
      case 'needs-install':
        return (
          <FormCard gap={12}>
            <h2 className="g-t-2" style={s('margin:0')}>
              {tr('push.needsInstall.title')}
            </h2>
            <p className="g-t-s" style={s('margin:0')}>
              {tr('push.needsInstall.body')}
            </p>
            <ol
              className="g-t-s"
              style={s('margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px')}
            >
              <li>{tr('push.needsInstall.step1')}</li>
              <li>{tr('push.needsInstall.step2')}</li>
              <li>{tr('push.needsInstall.step3')}</li>
              <li>{tr('push.needsInstall.step4')}</li>
            </ol>
          </FormCard>
        );
      case 'denied':
        return (
          <FormCard gap={12}>
            <h2 className="g-t-2" style={s('margin:0')}>
              {tr('push.denied.title')}
            </h2>
            <p className="g-t-s" style={s('margin:0')}>
              {tr('push.denied.body')}
            </p>
            <div>{retry('push.denied.recheck')}</div>
          </FormCard>
        );
      case 'off':
      case 'on':
        return (
          <>
            <FormCard>
              <SwitchRow
                label={tr('push.switch')}
                hint={tr('push.switchHint')}
                checked={status === 'on'}
                disabled={busy}
                onChange={(on) => void (on ? pushAlerts.enable() : pushAlerts.disable())}
              />
              <p className="g-t-s" style={s('margin:0;font-weight:500')} aria-live="polite">
                {busy
                  ? tr('push.state.working')
                  : tr(status === 'on' ? 'push.state.on' : 'push.state.off')}
              </p>
              <p className="g-t-c" style={s('margin:0')}>
                {tr('push.privacy')}
              </p>
            </FormCard>
            {problem ? (
              <Callout tone="warn" role="alert">
                {tr(PROBLEM_KEYS[problem])}
              </Callout>
            ) : null}
          </>
        );
    }
  }

  return (
    <SettingsPage labelledBy="push-title">
      <a className="g-btn gset-back" href={hasSettings ? '#/settings' : '#/orders'}>
        <Gi n="chevronLeft" size="sm" />
        <span>{tr(hasSettings ? 'settings.back' : 'push.back')}</span>
      </a>
      <header>
        <h1 id="push-title" className="g-t-1" style={s('margin:0')}>
          {tr('push.title')}
        </h1>
        <p className="g-t-s" style={s('margin:2px 0 0')}>
          {tr('push.desc')}
        </p>
      </header>
      {body()}
      <FormCard>
        <SwitchRow
          label={tr('payPopup.switch')}
          hint={tr('payPopup.switchHint')}
          checked={popup.enabled}
          onChange={(on) => void paymentPopup.setEnabled(on)}
        />
        <p className="g-t-s" style={s('margin:0;font-weight:500')} aria-live="polite">
          {tr(popup.enabled ? 'payPopup.state.on' : 'payPopup.state.off')}
        </p>
      </FormCard>
    </SettingsPage>
  );
}
