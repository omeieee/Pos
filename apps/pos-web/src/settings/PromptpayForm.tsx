import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { FormCard } from '../ui/FormParts.tsx';
import { useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { PromptpayDialog } from './PromptpayDialog.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';
import './settings-glass.css';

/**
 * The PromptPay account behind the QR. It shows the masked account and nothing else: the full ID
 * is never on this screen (not even to the owner). Changing it is a short dialog (type, review,
 * confirm), then the owner's step-up, then the save.
 */
export function PromptpayForm({ loaded, editable, submit }: SectionBodyProps<'promptpay'>) {
  const tr = useT();
  const [changing, setChanging] = useState(false);
  const current = loaded.value;

  return (
    <div style={s('display:flex;flex-direction:column;gap:18px')}>
      <FormCard gap={12}>
        <div style={s('display:flex;align-items:center;gap:14px')}>
          <div
            className="g-ico"
            style={s('background:#2457b8;width:44px;height:44px;border-radius:14px')}
          >
            <Gi n="qr" />
          </div>
          <p className="gset-account">
            {current
              ? tr('settings.promptpay.shown', {
                  type: tr(`settings.promptpay.type.${current.idType}`),
                  masked: current.idMasked,
                })
              : tr('settings.promptpay.none')}
          </p>
        </div>
        <p className="g-t-s" style={s('margin:0')}>
          {tr('settings.promptpay.privacy')}
        </p>
      </FormCard>
      {editable ? (
        <>
          <Callout tone="info" icon="lock" role="note">
            {tr('settings.promptpay.ownerOnly')}
          </Callout>
          <div className="gsave">
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg"
              onClick={() => setChanging(true)}
            >
              {tr(current ? 'settings.promptpay.change' : 'settings.promptpay.set')}
            </button>
          </div>
        </>
      ) : null}
      {changing ? (
        <PromptpayDialog
          currentMasked={current?.idMasked ?? null}
          version={loaded.version}
          submit={submit}
          onClose={() => setChanging(false)}
        />
      ) : null}
    </div>
  );
}
