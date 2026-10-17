import type { CustomersReport, HeatmapReport, ItemsReport, RevenueReport } from '@sds/shared';
import { useCallback, useEffect, useState } from 'react';
import { useServices } from '../../ui/hooks.ts';
import { type Period, periodRanges } from './report-model.ts';

export type ReportLoad = 'loading' | 'ok' | 'error';

export interface ReportData {
  revenue: RevenueReport;
  /** The same stretch one step back (the day before, last week, ...), for the comparison. */
  previous: RevenueReport;
  items: ItemsReport;
  heatmap: HeatmapReport;
}

/**
 * Loads the overview's figures for a period: this period's revenue, items and heatmap, and the
 * revenue of the period before it. All four calls must succeed, so the screen never shows a
 * comparison against half a picture. Changing the period or the day starts a new load; an answer
 * that arrives after that is dropped.
 */
export function useReportData(period: Period, today: string) {
  const { api } = useServices();
  const [load, setLoad] = useState<ReportLoad>('loading');
  const [data, setData] = useState<ReportData | null>(null);
  const [attempt, setAttempt] = useState(0);

  // `attempt` re-runs the load when the person taps "try again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    const { current, previous } = periodRanges(period, today);
    setLoad('loading');
    Promise.all([
      api.reports.revenue(current),
      api.reports.revenue(previous),
      api.reports.items(current),
      api.reports.heatmap(current),
    ]).then(
      ([revenue, before, items, heatmap]) => {
        if (!live) return;
        setData({ revenue, previous: before, items, heatmap });
        setLoad('ok');
      },
      () => {
        if (live) setLoad('error');
      },
    );
    return () => {
      live = false;
    };
  }, [api, period, today, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, data, reload };
}

/** The customer list for the owner. Loads once; `enabled` false never calls the API. */
export function useCustomersReport(enabled: boolean) {
  const { api } = useServices();
  const [load, setLoad] = useState<ReportLoad>('loading');
  const [data, setData] = useState<CustomersReport | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoad('loading');
    api.reports.customers().then(
      (report) => {
        if (!live) return;
        setData(report);
        setLoad('ok');
      },
      () => {
        if (live) setLoad('error');
      },
    );
    return () => {
      live = false;
    };
  }, [api, enabled, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { load, data, reload };
}
