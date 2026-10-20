/**
 * Loading hooks of the finance screens: the period, the expense ledger, the category list, the
 * profit-and-loss answer, the tax estimate and the owner's tax profile. Each keeps the last
 * answer of the request that is still wanted: changing the period or the year starts a new load
 * and an answer that arrives after that is dropped. Nothing here computes money.
 */
import type {
  ExpenseCategoryEntry,
  ExpenseList,
  PnlReport,
  TaxProfileResponse,
  TaxReport,
} from '@sds/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClientError } from '../../api/errors.ts';
import { useServices } from '../../ui/hooks.ts';
import type { DateRange } from '../reports/report-model.ts';
import { type RangeChoice, resolveRange } from './range-model.ts';

export type Load = 'loading' | 'ok' | 'error';

/** The period picker's state. `range` is null while a custom range is not a valid one. */
export function useRange(today: string, initial: RangeChoice = 'month') {
  const [choice, setChoice] = useState<RangeChoice>(initial);
  const [custom, setCustom] = useState<DateRange>({ from: '', to: '' });
  const result = useMemo(() => resolveRange(choice, today, custom), [choice, today, custom]);
  return { choice, setChoice, custom, setCustom, result, range: result.ok ? result.range : null };
}

/** One request that runs again when `key` changes or `reload` is called. */
function useRequest<T>(key: string | null, run: () => Promise<T>) {
  const [load, setLoad] = useState<Load>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` is the request of `key`; `attempt` re-runs it
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setLoad('loading');
    run().then(
      (answer) => {
        if (!live) return;
        setData(answer);
        setError(null);
        setLoad('ok');
      },
      (caught: unknown) => {
        if (!live) return;
        setError(caught);
        setLoad('error');
      },
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, data, error, reload };
}

export function useExpenses(range: DateRange | null) {
  const { api } = useServices();
  const key = range ? `${range.from}~${range.to}` : null;
  return useRequest<ExpenseList>(key, () =>
    range ? api.expenses.list(range) : Promise.reject(new ApiClientError('REQUEST_INVALID')),
  );
}

export interface CategoryState {
  load: Load;
  categories: ExpenseCategoryEntry[];
  /** The version the list was read at (0: never saved). */
  version: number;
  reload(): void;
  /** Replaces the whole list. Answers null when saved, else the error. */
  save(next: ExpenseCategoryEntry[]): Promise<unknown>;
}

/** The shop's expense categories, read once and replaced whole on a change. */
export function useExpenseCategories(): CategoryState {
  const { api } = useServices();
  const read = useRequest('categories', () => api.expenses.categories.read());
  const [saved, setSaved] = useState<{
    categories: ExpenseCategoryEntry[];
    version: number;
  } | null>(null);
  const answer =
    saved ??
    (read.data ? { categories: read.data.value.categories, version: read.data.version } : null);

  const save = useCallback(
    async (next: ExpenseCategoryEntry[]) => {
      try {
        const done = await api.expenses.categories.save({
          expectedVersion: answer?.version ?? 0,
          categories: next,
        });
        setSaved({ categories: done.value.categories, version: done.version });
        return null;
      } catch (caught) {
        // Someone else changed the list: read the latest, so the next try starts from it.
        if (caught instanceof ApiClientError && caught.code === 'VERSION_CONFLICT') {
          setSaved(null);
          read.reload();
        }
        return caught;
      }
    },
    [api, answer?.version, read],
  );

  return {
    load: answer ? 'ok' : read.load === 'ok' ? 'loading' : read.load,
    categories: answer?.categories ?? [],
    version: answer?.version ?? 0,
    reload: read.reload,
    save,
  };
}

export function usePnl(range: DateRange | null) {
  const { api } = useServices();
  const key = range ? `${range.from}~${range.to}` : null;
  return useRequest<PnlReport>(key, () =>
    range ? api.reports.pnl(range) : Promise.reject(new ApiClientError('REQUEST_INVALID')),
  );
}

export function useTax(year: number, period: 'annual' | 'half') {
  const { api } = useServices();
  return useRequest<TaxReport>(`${year}~${period}`, () => api.reports.tax({ year, period }));
}

export function useTaxProfile(year: number) {
  const { api } = useServices();
  const read = useRequest<TaxProfileResponse>(`profile~${year}`, () =>
    api.settings.taxProfile.read(year),
  );
  return read;
}
