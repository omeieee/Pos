import { useState } from 'react';
import { useActivityHold, useEntities, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
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

  return (
    <Modal labelledBy="pp-title" onClose={onClose} variant="options">
      <div className="mdialog">
        <header className="osheet__head">
          <h2 id="pp-title" className="sheet__title">
            {tr(
              step === 'edit'
                ? 'settings.promptpay.dialog.title'
                : 'settings.promptpay.dialog.confirmTitle',
            )}
          </h2>
          <button
            type="button"
            className="btn btn-soft"
            aria-label={tr('common.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>

        {step === 'edit' ? (
          <form
            className="mdialog"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              review();
            }}
          >
            <div className="osheet__body">
              <fieldset className="seg">
                <legend className="visually-hidden">{tr('settings.promptpay.dialog.kind')}</legend>
                {KINDS.map((kind) => (
                  <label
                    key={kind}
                    className={`seg__item${draft.idType === kind ? ' seg__item--on' : ''}`}
                  >
                    <input
                      className="visually-hidden"
                      type="radio"
                      name="promptpay-kind"
                      checked={draft.idType === kind}
                      onChange={() => setDraft({ ...draft, idType: kind })}
                    />
                    {tr(`settings.promptpay.type.${kind}`)}
                  </label>
                ))}
              </fieldset>
              <TextField
                label={tr('settings.promptpay.dialog.value')}
                value={draft.idValue}
                inputMode="numeric"
                autoComplete="off"
                maxLength={24}
                hint={tr('settings.promptpay.dialog.valueHint')}
                error={tried && !read.ok ? tr('settings.promptpay.dialog.error') : undefined}
                onChange={(idValue) => setDraft({ ...draft, idValue })}
              />
            </div>
            <footer className="osheet__foot">
              <div className="osheet__actions">
                <button type="button" className="btn btn-soft btn-lg" onClick={onClose}>
                  {tr('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary btn-lg osheet__confirm">
                  {tr('settings.promptpay.dialog.review')}
                </button>
              </div>
            </footer>
          </form>
        ) : (
          <>
            <div className="osheet__body">
              <p className="sset__account">
                {read.ok
                  ? tr('settings.promptpay.dialog.newAccount', { masked: previewMasked(read.id) })
                  : null}
              </p>
              <p className="muted">
                {currentMasked
                  ? tr('settings.promptpay.dialog.oldAccount', { masked: currentMasked })
                  : tr('settings.promptpay.dialog.noOld')}
              </p>
              <p className="notice" role="alert">
                <Icon name="alert" />
                <span>
                  {waiting > 0
                    ? tr('settings.promptpay.dialog.warnOpen', { count: waiting })
                    : tr('settings.promptpay.dialog.warnNone')}
                </span>
              </p>
              <p className="hint">{tr('settings.promptpay.dialog.alert')}</p>
            </div>
            <footer className="osheet__foot">
              <div className="error-slot" role="alert">
                {error ? <p className="error">{error}</p> : null}
              </div>
              <div className="osheet__actions">
                <button
                  type="button"
                  className="btn btn-soft btn-lg"
                  disabled={saving}
                  onClick={() => setStep('edit')}
                >
                  {tr('settings.promptpay.dialog.edit')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-lg osheet__confirm"
                  disabled={saving}
                  onClick={() => void confirm()}
                >
                  {saving
                    ? tr('settings.promptpay.dialog.changing')
                    : tr('settings.promptpay.dialog.confirm')}
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
