import { useEffect } from 'react';
import { startSessionKeepalive } from '../lib/keepalive.ts';
import { useServices } from '../ui/hooks.ts';

/**
 * What a wall-mounted kitchen display needs while the kitchen view is open: the screen stays awake
 * (through the platform wake-lock seam, re-acquired when the page returns to the front, a no-op
 * where the browser has none), and the session stays signed in (see `startSessionKeepalive` for the
 * idle-limit trade-off). Both stop when the view closes.
 */
export function useKitchenDisplay(): void {
  const { wakeLock, api, lifecycle } = useServices();

  useEffect(() => wakeLock.keepAwake(), [wakeLock]);

  useEffect(
    () => startSessionKeepalive({ ping: () => api.auth.me(), lifecycle }),
    [api, lifecycle],
  );
}
