import type { ExpenseCategoryEntry, ExpenseDto } from '@sds/shared';
import { useRef, useState } from 'react';
import { newClientRequestId } from '../../api/client.ts';
import { ApiClientError, errorText } from '../../api/errors.ts';
import { DialogLayout } from '../../ui/DialogParts.tsx';
import { useActivityHold, useLocale, useServices, useT } from '../../ui/hooks.ts';
import { PortalModal } from '../../ui/PortalModal.tsx';
import { SelectField, TextField } from '../../ui/TextField.tsx';
import {
  buildExpenseCreate,
  buildExpensePatch,
  categoryName,
  categoryOptions,
  type ExpenseField,
  emptyExpenseForm,
  expenseFormFrom,
  validateExpenseForm,
} from './expense-model.ts';
import { type PickedReceipt, ReceiptField } from './ReceiptParts.tsx';

/** Runs one save for a dialog: keeps the failure inside the dialog and ignores a second tap meanwhile. */
function useSave(onConflict: () => void) {
  const tr = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  async function run(call: () => Promise<boolean>) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await call();
    } catch (caught) {
      setError(errorText(tr, caught));
      if (caught instanceof ApiClientError && caught.code === 'VERSION_CONFLICT') onConflict();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return { saving, error, setError, run };
}

/**
 * Add an expense, or correct one. A new expense carries one idempotency key for the content on
 * screen: a retry after a lost answer sends the same key (the server returns the row it already
 * made), and a changed amount or date is a different request with a new key. A correction sends
 * only what changed, with the version the row had when the screen read it.
 *
 * A receipt picture is chosen in the form and uploaded after the row is saved: the row is created
 * (or corrected) first, then the picture is attached with the version that answer carried. If the
 * picture then fails the row is already saved, so the dialog becomes the edit dialog of that row
 * (a retry attaches only, never creates again) and closing it still reads the list again.
 */
export function ExpenseDialog({
  expense: opened,
  categories,
  today,
  onClose,
  onDone,
  onConflict,
}: {
  /** Absent: a new expense. */
  expense?: ExpenseDto;
  categories: readonly ExpenseCategoryEntry[];
  today: string;
  onClose: () => void;
  onDone: () => void;
  onConflict: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const { api } = useServices();
  // The row as the server last answered; every receipt step and save carries its version on.
  const [expense, setExpense] = useState(opened);
  const [form, setForm] = useState(() =>
    opened ? expenseFormFrom(opened) : emptyExpenseForm(today, categories),
  );
  const [picked, setPicked] = useState<PickedReceipt | null>(null);
  const changed = useRef(false);
  const [tried, setTried] = useState(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const { saving, error, setError, run } = useSave(onConflict);
  useActivityHold(true);

  const problems: ExpenseField[] = tried ? validateExpenseForm(form) : [];
  const fieldError = (field: ExpenseField) =>
    problems.includes(field) ? tr(`exp.error.${field}`) : undefined;
  const options = categoryOptions(categories, expense?.category);

  function saved(row: ExpenseDto) {
    changed.current = true;
    setExpense(row);
  }
  /** Closing after a save or a photo change that went through still reads the list again. */
  const close = () => (changed.current ? onDone() : onClose());
  const pickFile = (file: File | null) =>
    setPicked(file ? { file, requestId: newClientRequestId() } : null);

  async function submit() {
    setTried(true);
    if (validateExpenseForm(form).length > 0) return;
    await run(async () => {
      let row = expense;
      if (row) {
        const patch = buildExpensePatch(row, form);
        if (!patch && !picked) {
          setError(tr('exp.noChange'));
          return false;
        }
        if (patch) {
          row = await api.expenses.patch(row.id, patch);
          saved(row);
        }
      } else {
        const body = buildExpenseCreate(form);
        const signature = JSON.stringify(body);
        if (attempt.current?.signature !== signature) {
          attempt.current = { signature, id: newClientRequestId() };
        }
        row = (await api.expenses.create(body, { clientRequestId: attempt.current.id })).row;
        saved(row);
      }
      if (picked && row) {
        try {
          const done = await api.expenses.receipt.attach(row.id, picked.file, {
            expectedVersion: row.version,
            requestId: picked.requestId,
          });
          saved(done.row);
          setPicked(null);
        } catch (caught) {
          setError(tr('exp.receipt.attachFailed', { reason: errorText(tr, caught) }));
          if (caught instanceof ApiClientError && caught.code === 'VERSION_CONFLICT') onConflict();
          return false;
        }
      }
      onDone();
      return true;
    });
  }

  return (
    <PortalModal labelledBy="exp-title" onClose={close}>
      <DialogLayout
        titleId="exp-title"
        title={expense ? tr('exp.dialog.editTitle') : tr('exp.dialog.addTitle')}
        onClose={close}
        onSubmit={() => void submit()}
        error={error}
        actions={
          <>
            <button type="button" className="g-btn g-btn-lg" onClick={close}>
              {tr('common.cancel')}
            </button>
            <button type="submit" className="g-btn g-btn-p g-btn-lg" disabled={saving}>
              {saving
                ? picked
                  ? tr('exp.receipt.uploading')
                  : tr('exp.saving')
                : tr('common.save')}
            </button>
          </>
        }
      >
        <TextField
          type="date"
          label={tr('exp.field.date')}
          hint={tr('exp.field.dateHint')}
          value={form.date}
          error={fieldError('date')}
          onChange={(date) => setForm({ ...form, date })}
        />
        <SelectField
          label={tr('exp.field.category')}
          value={form.category}
          error={fieldError('category')}
          onChange={(category) => setForm({ ...form, category })}
        >
          {options.map((c) => (
            <option key={c.key} value={c.key}>
              {c.active
                ? categoryName(categories, c.key, locale)
                : tr('exp.field.categoryOff', { name: categoryName(categories, c.key, locale) })}
            </option>
          ))}
        </SelectField>
        <TextField
          label={tr('exp.field.amount')}
          inputMode="decimal"
          value={form.amount}
          error={fieldError('amount')}
          onChange={(amount) => setForm({ ...form, amount })}
        />
        <TextField
          label={tr('exp.field.vendor')}
          value={form.vendor}
          error={fieldError('vendor')}
          onChange={(vendor) => setForm({ ...form, vendor })}
        />
        <TextField
          label={tr('exp.field.note')}
          value={form.note}
          error={fieldError('note')}
          onChange={(note) => setForm({ ...form, note })}
        />
        <ReceiptField
          expense={expense}
          picked={picked}
          busy={saving}
          onPick={pickFile}
          onRemoved={saved}
          onConflict={onConflict}
        />
      </DialogLayout>
    </PortalModal>
  );
}

/** Void an expense: a reason is required, and the row stays in the ledger struck through. */
export function VoidExpenseDialog({
  expense,
  onClose,
  onDone,
  onConflict,
}: {
  expense: ExpenseDto;
  onClose: () => void;
  onDone: () => void;
  onConflict: () => void;
}) {
  const tr = useT();
  const { api } = useServices();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const { saving, error, run } = useSave(onConflict);
  useActivityHold(true);

  async function submit() {
    setTried(true);
    const text = reason.trim();
    if (text === '') return;
    await run(async () => {
      await api.expenses.void(expense.id, { expectedVersion: expense.version, reason: text });
      onDone();
      return true;
    });
  }

  return (
    <PortalModal labelledBy="exp-void-title" onClose={onClose}>
      <DialogLayout
        titleId="exp-void-title"
        title={tr('exp.void.title')}
        onClose={onClose}
        onSubmit={() => void submit()}
        error={error}
        actions={
          <>
            <button type="button" className="g-btn g-btn-lg" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button type="submit" className="g-btn g-btn-p g-btn-lg" disabled={saving}>
              {saving ? tr('exp.saving') : tr('exp.void.confirm')}
            </button>
          </>
        }
      >
        <p className="g-t-b" style={{ margin: 0 }}>
          {tr('exp.void.explain')}
        </p>
        <TextField
          label={tr('exp.void.reason')}
          placeholder={tr('exp.void.reasonPlaceholder')}
          value={reason}
          maxLength={200}
          error={tried && reason.trim() === '' ? tr('exp.void.error.reason') : undefined}
          onChange={setReason}
        />
      </DialogLayout>
    </PortalModal>
  );
}
