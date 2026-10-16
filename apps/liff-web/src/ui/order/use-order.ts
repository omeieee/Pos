/**
 * Order page: loads one order and polls it while it is not final.
 */
import type { MyOrder } from '@sds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPollDelayMs } from '../../model/poll.ts';
import { slipPollDelayMs } from '../../model/slip-progress.ts';
import { useApp } from '../app-context.tsx';

/** An order page that follows the order: asks the server every few seconds while it is open. */
export function useOrder(id: string) {
  const { api } = useApp();
  const [order, setOrder] = useState<MyOrder | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const failures = useRef(0);
  const latest = useRef<MyOrder | null>(null);
  /** When the customer sent a slip in this visit: the page asks faster for a while after it. */
  const fastSince = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tickRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    try {
      const next = await api.order(id);
      latest.current = next;
      failures.current = 0;
      setFailure(null);
      setOrder(next);
    } catch (e) {
      failures.current += 1;
      setFailure(e);
    }
  }, [api, id]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      await load();
      if (stopped) return;
      const normal = nextPollDelayMs(latest.current, document.hidden, failures.current);
      const fast =
        fastSince.current === null
          ? null
          : slipPollDelayMs(Date.now() - fastSince.current, latest.current, failures.current);
      // A closed order stops the page whatever the slip says; otherwise the quicker rate wins.
      const delay = normal === null ? null : (fast ?? normal);
      clearTimeout(timerRef.current);
      if (delay !== null) timerRef.current = setTimeout(() => void tick(), delay);
    };
    tickRef.current = () => void tick();
    void tick();
    // Coming back to the app shows the newest state at once.
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timerRef.current);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /** A slip was just sent: poll quickly for a while (the page's own rate takes over after). */
  const speedUp = useCallback((startedAt: number) => {
    fastSince.current = startedAt;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => tickRef.current(), 2000);
  }, []);

  return { order, setOrder, failure, reload: load, speedUp };
}
