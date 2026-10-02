import { useEffect } from 'react';
import { startSessionKeepalive } from '../lib/keepalive.ts';
import { useAuthState, useServices } from '../ui/hooks.ts';

/**
 * What a wall-mounted kitchen display needs while the kitchen view is open: the screen stays awake
 * (through the platform wake-lock seam, re-acquired when the page returns to the front, a no-op
 * where the browser has none), and the session stays signed in (see `startSessionKeepalive` for the
 * idle-limit trade-off). Both stop when the view closes.
 *
 * The keepalive is for a PIN session only (the staff PIN on a shop device). An owner's password
 * session keeps its short idle limit (30 minutes) on purpose: that login is reachable from the
 * internet, and an open tab must not stretch it to the 8-hour absolute limit.
 */
export function useKitchenDisplay(): void {
  const { wakeLock, api, lifecycle } = useServices();
  const method = useAuthState().session?.method;

  useEffect(() => wakeLock.keepAwake(), [wakeLock]);

  useEffect(
    () =>
      method === 'pin'
        ? startSessionKeepalive({ ping: () => api.auth.me(), lifecycle })
        : undefined,
    [api, lifecycle, method],
  );
}
