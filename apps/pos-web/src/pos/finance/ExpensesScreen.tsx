import { formatBaht } from '@sds/i18n';
import type { ExpenseDto } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { useEntities, useLocale, useNow, useT } from '../../ui/hooks.ts';
import { currentBusinessDay } from '../orders/order-board.ts';
import { CategoriesPanel } from './CategoriesPanel.tsx';
import { ExpenseDialog, VoidExpenseDialog } from './ExpenseDialogs.tsx';
import { categoryName } from './expense-model.ts';
import { FinancePage, LoadState, RangePicker, useDayText } from './FinanceParts.tsx';
import { useExpenseCategories, useExpenses, useRange } from './use-finance.ts';

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; expense: ExpenseDto }
  | { kind: 'void'; expense: ExpenseDto };

/**
 * The expense ledger (`#/expenses`, owner and manager). Rows of the chosen period with the total
 * the server worked out (voided rows are listed, struck through and labelled, and left out of that
 * total). An expense is added, corrected, or voided with a reason; nothing is deleted. Dates may
 * be in the future. The categories are edited at the bottom of the page.
 */
export function ExpensesScreen() {
  const tr = useT();
  const locale = useLocale();
  const dayText = useDayText();
  const now = useNow(60_000);
  const today = currentBusinessDay(useEntities().settings, now);
  const period = useRange(today);
  const expenses = useExpenses(period.range);
  const categories = useExpenseCategories();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const money = (satang: number) => formatBaht(satang, locale);
  const list = expenses.data;
  const voidedCount = list ? list.expenses.filter((e) => e.voided).length : 0;
  const keptCount = list ? list.expenses.length - voidedCount : 0;

  const done = () => {
    setDialog(null);
    expenses.reload();
  };

  return (
    <FinancePage
      id="expenses-title"
      title={tr('exp.title')}
      subtitle={tr('exp.subtitle')}
      controls={
        <button type="button" className="g-btn g-btn-p" onClick={() => setDialog({ kind: 'add' })}>
          <Gi n="plus" size="sm" />
          {tr('exp.add')}
        </button>
      }
    >
      <RangePicker
        name="exp-range"
        choice={period.choice}
        custom={period.custom}
        result={period.result}
        onChoice={period.setChoice}
        onCustom={period.setCustom}
      />
      <LoadState load={expenses.load} hasData={list !== null} onRetry={expenses.reload} />

      {list ? (
        <div className="g-glass fin-card">
          <div className="fin-card__head">
            <div className="g-t-2 fin-card__title">{tr('exp.total')}</div>
            <span className="g-t-s">{tr('exp.count', { count: keptCount })}</span>
          </div>
          <div className="fin-big">{money(list.totalSatang)}</div>
          <div className="g-t-c">{tr('exp.totalHint')}</div>
          {voidedCount > 0 ? (
            <div className="g-t-c">{tr('exp.voidedCount', { count: voidedCount })}</div>
          ) : null}
          {list.expenses.length === 0 ? (
            <p className="g-t-s fin-note">{tr('exp.none')}</p>
          ) : (
            <ul className="fin-list" aria-label={tr('exp.title')}>
              {list.expenses.map((e) => {
                const category = categoryName(categories.categories, e.category, locale);
                const amount = money(e.amountSatang);
                return (
                  <li key={e.id} className="fin-item">
                    <div className={`fin-item__main${e.voided ? ' fin-struck' : ''}`}>
                      <span className="g-t-s">{dayText(e.businessDate)}</span>
                      <span className="fin-item__what">
                        <span className="g-t-3">{category}</span>
                        {e.vendor || e.note ? (
                          <span className="g-t-c">
                            {' '}
                            · {[e.vendor, e.note].filter(Boolean).join(' · ')}
                          </span>
                        ) : null}
                      </span>
                      <span className="fin-item__amount">{amount}</span>
                    </div>
                    {e.voided ? (
                      <div className="fin-item__voided">
                        <span className="g-badge g-b-mute">{tr('exp.voided')}</span>
                        {e.voidReason ? (
                          <span className="g-t-c">
                            {tr('exp.voidedReason', { reason: e.voidReason })}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="fin-item__actions">
                        <button
                          type="button"
                          className="g-btn"
                          aria-label={tr('exp.rowEdit', { category, amount })}
                          onClick={() => setDialog({ kind: 'edit', expense: e })}
                        >
                          {tr('common.edit')}
                        </button>
                        <button
                          type="button"
                          className="g-btn"
                          aria-label={tr('exp.rowVoid', { category, amount })}
                          onClick={() => setDialog({ kind: 'void', expense: e })}
                        >
                          {tr('exp.void.action')}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      <CategoriesPanel state={categories} />

      {dialog?.kind === 'add' || dialog?.kind === 'edit' ? (
        <ExpenseDialog
          {...(dialog.kind === 'edit' ? { expense: dialog.expense } : {})}
          categories={categories.categories}
          today={today}
          onClose={() => setDialog(null)}
          onDone={done}
          onConflict={expenses.reload}
        />
      ) : null}
      {dialog?.kind === 'void' ? (
        <VoidExpenseDialog
          expense={dialog.expense}
          onClose={() => setDialog(null)}
          onDone={done}
          onConflict={expenses.reload}
        />
      ) : null}
    </FinancePage>
  );
}
