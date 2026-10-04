import { useEffect, useState } from 'react';
import { storefrontHoursText } from '../design/format.ts';
import { useNow, useServices } from '../ui/hooks.ts';

/**
 * Today's storefront hours ("10:00 – 15:00") for the order screen's sub-title. The opening hours
 * are a setting that is not synced with the menu, so they are read once when the screen opens;
 * when they cannot be read (offline, no permission) there is simply no hours line.
 */
export function useStorefrontHours(): string | null {
  const { api } = useServices();
  const now = useNow(60_000);
  const [hours, setHours] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    try {
      api.settings.openingHours
        .read()
        .then((answer) => {
          if (live) setHours(answer.value);
        })
        .catch(() => undefined);
    } catch {
      // no settings API here: no hours line
    }
    return () => {
      live = false;
    };
  }, [api]);
  return hours ? storefrontHoursText(hours, now) : null;
}
