import { formatDate } from '@sds/i18n';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';

/**
 * Shown on the order screen when the menu on screen is the copy saved on this device (a reload
 * with no connection) and the device is still offline: with the time the copy was saved, so the
 * cashier knows how old the prices are. Prices here are only an estimate; the server prices the
 * order when it is sent. It disappears once the server has answered.
 */
export function CatalogueNotice() {
  const { catalogue, outbox } = useServices();
  const { fromCache, savedAt } = useStoreState(catalogue);
  const offline = useStoreState(outbox).offline;
  const tr = useT();
  const locale = useLocale();
  if (!fromCache || !offline || savedAt === null) return null;
  return (
    <p className="notice" role="status">
      <Icon name="wifi-off" />
      <span>{tr('catalogue.offline', { time: formatDate(savedAt, locale, 'dateTime') })}</span>
    </p>
  );
}
