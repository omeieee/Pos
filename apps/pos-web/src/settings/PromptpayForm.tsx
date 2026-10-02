import { useState } from 'react';
import { useT } from '../ui/hooks.ts';
import { PromptpayDialog } from './PromptpayDialog.tsx';
import type { SectionBodyProps } from './SettingSection.tsx';

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
    <div className="sset__form">
      <p className="sset__account">
        {current
          ? tr('settings.promptpay.shown', {
              type: tr(`settings.promptpay.type.${current.idType}`),
              masked: current.idMasked,
            })
          : tr('settings.promptpay.none')}
      </p>
      <p className="hint">{tr('settings.promptpay.privacy')}</p>
      {editable ? (
        <>
          <p className="hint">{tr('settings.promptpay.ownerOnly')}</p>
          <div className="sset__actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
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
