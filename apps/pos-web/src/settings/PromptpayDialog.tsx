import { useState } from 'react';
import { DialogLayout } from '../ui/DialogParts.tsx';
import { SegRadio } from '../ui/FormParts.tsx';
import { useActivityHold, useEntities, useT } from '../ui/hooks.ts';
import { Callout } from '../ui/Notice.tsx';
import { PortalModal } from '../ui/PortalModal.tsx';
import { TextField } from '../ui/TextField.tsx';
import { failureText } from './outcome-text.ts';
import {
  buildPromptpayInput,
  openPromptpayCount,
  type PromptpayDraft,
  previewMasked,
  readPromptpayDraft,
} from './promptpay-model.ts';
import type { SectionBodyProps } from './SettingSection.tsx';
import './settings-glass.css';

const KINDS = ['phone', 'national_id', 'ewallet'] as const;

/**
 * Changing the PromptPay account in two steps. Step 1: the kind and the number, checked against
 * the shared rule. Step 2: the new account shown MASKED beside the current one, a plain warning
 * about PromptPay payments still waiting, and the confirm button, which asks for the owner's
 * step-up and then saves. The typed number lives in this component's state only: it is not on the
 * review step's page, not in any store, and gone when the dialog closes.
 */
export function PromptpayDialog({
  currentMasked,
  version,
  submit,
  onClose,
}: {
  currentMasked: string | null;
  version: number;
  submit: SectionBodyProps<'promptpay'>['submit'];
  onClose: () => void;
}) {
  const tr = useT();
  useActivityHold(true);
  const waiting = openPromptpayCount(useEntities().payments);
  const [draft, setDraft] = useState<PromptpayDraft>({ idType: 'phone', idValue: '' });
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = readPromptpayDraft(draft);

  function review() {
    setTried(true);
    if (read.ok) setStep('confirm');
  }

  async function confirm() {
    if (!read.ok || saving) return;
    setSaving(true);
    setError(null);
    const outcome = await submit(buildPromptpayInput(version, read.id), { quiet: true });
    setSaving(false);
    if (outcome?.ok) {
      onClose();
    } else if (outcome) {
      const text = failureText(tr, outcome);
      // A conflict means the account changed elsewhere meanwhile: the page has re-read it, and
      // this review was about the old one, so it ends here.
      if (outcome.ok === false && outcome.reason === 'error' && outcome.refreshed) onClose();
      else setError(text);
    }
  }

  const title = tr(
    step === 'edit' ? 'settings.promptpay.dialog.title' : 'settings.promptpay.dialog.confirmTitle',
  );

  return (
    <PortalModal labelledBy="pp-title" onClose={onClose}>
      {step === 'edit' ? (
        <DialogLayout
          titleId="pp-title"
          title={title}
          onClose={onClose}
          onSubmit={review}
          actions={
            <>
              <button type="button" className="g-btn g-btn-lg" onClick={onClose}>
                {tr('common.cancel')}
              </button>
              <button type="submit" className="g-btn g-btn-p g-btn-lg">
                {tr('settings.promptpay.dialog.review')}
              </button>
            </>
          }
        >
          <SegRadio
            legend={tr('settings.promptpay.dialog.kind')}
            name="promptpay-kind"
            value={draft.idType}
            options={KINDS.map((kind) => ({
              value: kind,
              label: tr(`settings.promptpay.type.${kind}`),
            }))}
            onChange={(idType) => setDraft({ ...draft, idType })}
          />
          <TextField
            icon="qr"
            label={tr('settings.promptpay.dialog.value')}
            value={draft.idValue}
            inputMode="numeric"
            autoComplete="off"
            maxLength={24}
            hint={tr('settings.promptpay.dialog.valueHint')}
            error={tried && !read.ok ? tr('settings.promptpay.dialog.error') : undefined}
            onChange={(idValue) => setDraft({ ...draft, idValue })}
          />
        </DialogLayout>
      ) : (
        <DialogLayout
          titleId="pp-title"
          title={title}
          onClose={onClose}
          error={error}
          actions={
            <>
              <button
                type="button"
                className="g-btn g-btn-lg"
                disabled={saving}
                onClick={() => setStep('edit')}
              >
                {tr('settings.promptpay.dialog.edit')}
              </button>
              <button
                type="button"
                className="g-btn g-btn-p g-btn-lg"
                disabled={saving}
                onClick={() => void confirm()}
              >
                {saving
                  ? tr('settings.promptpay.dialog.changing')
                  : tr('settings.promptpay.dialog.confirm')}
              </button>
            </>
          }
        >
          <div className="g-sunk" style={{ padding: 16 }}>
            <p className="gset-account">
              {read.ok
                ? tr('settings.promptpay.dialog.newAccount', { masked: previewMasked(read.id) })
                : null}
            </p>
            <p className="g-t-s" style={{ margin: '4px 0 0' }}>
              {currentMasked
                ? tr('settings.promptpay.dialog.oldAccount', { masked: currentMasked })
                : tr('settings.promptpay.dialog.noOld')}
            </p>
          </div>
          <Callout tone="warn" role="alert">
            {waiting > 0
              ? tr('settings.promptpay.dialog.warnOpen', { count: waiting })
              : tr('settings.promptpay.dialog.warnNone')}
          </Callout>
          <p className="g-t-c" style={{ margin: 0 }}>
            {tr('settings.promptpay.dialog.alert')}
          </p>
        </DialogLayout>
      )}
    </PortalModal>
  );
}
