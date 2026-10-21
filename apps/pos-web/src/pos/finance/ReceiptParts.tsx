import type { ExpenseDto } from '@sds/shared';
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiClientError, errorText } from '../../api/errors.ts';
import { Gi } from '../../design/icons.tsx';
import { DialogLayout } from '../../ui/DialogParts.tsx';
import { useActivityHold, useServices, useT } from '../../ui/hooks.ts';
import { PortalModal } from '../../ui/PortalModal.tsx';
import { FieldMessage } from '../../ui/TextField.tsx';
import { RECEIPT_ACCEPT, RECEIPT_PROBLEM_KEYS, receiptFileProblem } from './receipt-model.ts';

type ImageState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'failed'; error: unknown };

/**
 * The receipt picture of one expense. It is fetched with the session header (an `<img>` cannot send
 * one), shown from a blob URL, and the URL is revoked when the picture goes away. A failure (photo
 * storage not set up yet, no network) is told in words with a retry; nothing else on the screen
 * depends on it. `version` changes after a replace, so the new picture is read.
 */
export function ReceiptImage({ expenseId, version }: { expenseId: string; version: number }) {
  const tr = useT();
  const { api } = useServices();
  const [state, setState] = useState<ImageState>({ kind: 'loading' });
  const [tries, setTries] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tries` and `version` only re-run the read
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setState({ kind: 'loading' });
    api.expenses.receipt.read(expenseId).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setState({ kind: 'ready', url });
      },
      (error: unknown) => {
        if (live) setState({ kind: 'failed', error });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, expenseId, version, tries]);

  if (state.kind === 'ready') {
    return <img className="fin-receipt__img" src={state.url} alt={tr('exp.receipt.alt')} />;
  }
  if (state.kind === 'failed') {
    return (
      <div className="fin-receipt__state" role="alert">
        <p className="g-t-s" style={{ margin: 0 }}>
          {errorText(tr, state.error)}
        </p>
        <button type="button" className="g-btn" onClick={() => setTries((n) => n + 1)}>
          {tr('common.retry')}
        </button>
      </div>
    );
  }
  return (
    <p className="g-t-s fin-receipt__state" role="status" style={{ margin: 0 }}>
      {tr('exp.receipt.loading')}
    </p>
  );
}

/** Opens from the ledger row: the picture of any expense that has one, voided ones included. */
export function ReceiptViewerDialog({
  expense,
  onClose,
}: {
  expense: ExpenseDto;
  onClose: () => void;
}) {
  const tr = useT();
  useActivityHold(true);
  return (
    <PortalModal labelledBy="exp-receipt-title" onClose={onClose}>
      <DialogLayout
        titleId="exp-receipt-title"
        title={tr('exp.receipt.viewTitle')}
        onClose={onClose}
        actions={
          <button type="button" className="g-btn g-btn-p g-btn-lg" onClick={onClose}>
            {tr('exp.receipt.close')}
          </button>
        }
      >
        <div className="fin-receipt">
          <ReceiptImage expenseId={expense.id} version={expense.version} />
        </div>
      </DialogLayout>
    </PortalModal>
  );
}

/** A picture chosen but not yet uploaded, with the key that makes a retry of it safe. */
export interface PickedReceipt {
  file: File;
  requestId: string;
}

/**
 * The receipt part of the expense form. A picture is chosen here and uploaded when the form is
 * saved (an expense must exist first); a photo already on the expense is shown, replaced the same
 * way, or removed after a question. Removing is the only thing this part sends itself, and it is
 * not optimistic: the photo stays until the server says it is gone.
 */
export function ReceiptField({
  expense,
  picked,
  busy,
  onPick,
  onRemoved,
  onConflict,
}: {
  /** Absent: the expense is not saved yet. */
  expense: ExpenseDto | undefined;
  picked: PickedReceipt | null;
  /** The form is saving: nothing here may be started. */
  busy: boolean;
  onPick: (file: File | null) => void;
  onRemoved: (row: ExpenseDto) => void;
  onConflict: () => void;
}) {
  const tr = useT();
  const { api } = useServices();
  const inputId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);
  const hasPhoto = expense?.hasReceipt === true;
  const off = busy || removing;

  // The question opens at the bottom of a scrolling form: bring it into view.
  useEffect(() => {
    if (asking) askRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [asking]);

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // So the same file can be chosen again after a failure.
    event.target.value = '';
    if (!file) return;
    const why = receiptFileProblem(file);
    if (why) {
      setProblem(tr(RECEIPT_PROBLEM_KEYS[why]));
      return;
    }
    setProblem(null);
    onPick(file);
  }

  async function remove() {
    if (!expense || removing) return;
    setRemoving(true);
    setProblem(null);
    try {
      onRemoved(await api.expenses.receipt.remove(expense.id, expense.version));
      setAsking(false);
    } catch (caught) {
      setProblem(errorText(tr, caught));
      if (caught instanceof ApiClientError && caught.code === 'VERSION_CONFLICT') onConflict();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <fieldset className="gset fin-receipt-field">
      <legend>{tr('exp.receipt.title')}</legend>
      <p className="g-t-s" style={{ margin: 0 }} role="status">
        {hasPhoto ? tr('exp.receipt.has') : tr('exp.receipt.none')}
      </p>
      {expense && hasPhoto && !picked ? (
        <div className="fin-receipt">
          <ReceiptImage expenseId={expense.id} version={expense.version} />
        </div>
      ) : null}
      {picked ? (
        <p className="g-t-s fin-receipt-field__picked" style={{ margin: 0 }}>
          {tr('exp.receipt.picked', { name: picked.file.name })}
        </p>
      ) : null}
      <div className="fin-receipt-field__row">
        <input
          id={inputId}
          className="gvh fin-pick"
          type="file"
          accept={RECEIPT_ACCEPT}
          disabled={off}
          onChange={choose}
        />
        <label htmlFor={inputId} className="g-btn" aria-disabled={off}>
          <Gi n="camera" size="sm" />
          {hasPhoto || picked ? tr('exp.receipt.replace') : tr('exp.receipt.choose')}
        </label>
        {picked ? (
          <button type="button" className="g-btn" disabled={off} onClick={() => onPick(null)}>
            {tr('exp.receipt.unpick')}
          </button>
        ) : null}
        {hasPhoto && !asking ? (
          <button type="button" className="g-btn" disabled={off} onClick={() => setAsking(true)}>
            {tr('exp.receipt.remove')}
          </button>
        ) : null}
      </div>
      {asking ? (
        <div className="fin-receipt-field__ask" ref={askRef}>
          <p className="g-t-s" style={{ margin: 0 }}>
            {tr('exp.receipt.removeAsk')}
          </p>
          <div className="fin-receipt-field__row">
            <button
              type="button"
              className="g-btn"
              disabled={removing}
              onClick={() => setAsking(false)}
            >
              {tr('exp.receipt.removeKeep')}
            </button>
            <button
              type="button"
              className="g-btn g-btn-p"
              disabled={off}
              onClick={() => void remove()}
            >
              {removing ? tr('exp.receipt.removing') : tr('exp.receipt.removeConfirm')}
            </button>
          </div>
        </div>
      ) : null}
      <FieldMessage tone="hint">{tr('exp.receipt.hint')}</FieldMessage>
      {problem ? <FieldMessage tone="bad">{problem}</FieldMessage> : null}
    </fieldset>
  );
}
