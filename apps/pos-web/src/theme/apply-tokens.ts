import type { DeviceKind } from '@sds/shared';
import { useEffect } from 'react';
import { useViewport } from '../ui/hooks.ts';
import { pickDevice, tokensCss } from './device.ts';

/** Writes the design tokens for this device (A4) onto the page. `kind`: the registered device, if any. */
export function useApplyTokens(kind: DeviceKind | null): void {
  const viewport = useViewport();
  const device = pickDevice(kind, viewport);
  useEffect(() => {
    let style = document.getElementById('sds-tokens');
    if (!style) {
      style = document.createElement('style');
      style.id = 'sds-tokens';
      document.head.append(style);
    }
    style.textContent = tokensCss(device);
    document.documentElement.dataset.device = device;
  }, [device]);
}
