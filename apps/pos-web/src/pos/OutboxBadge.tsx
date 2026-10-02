import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';

/**
 * The outbox in the top bar: how many orders and payments wait to be sent, and how many were refused
 * and need a person. Icon, words and colour together. It is a link to the orders page, where the
 * waiting entries are listed. Nothing shows when nothing waits. (Online or offline is the
 * connection badge next to it.)
 */
export function OutboxBadge() {
  const state = useStoreState(useServices().outbox);
  const tr = useT();
  const attention = state.items.filter((i) => i.state === 'attention').length;
  const waiting = state.items.length - attention;
  if (state.items.length === 0) return null;
  return (
    <a className="qbadge" href="#/orders" aria-label={tr('outbox.badge.label')}>
      {waiting > 0 ? (
        <span className="qbadge__part qbadge__part--waiting">
          <Icon name="sync" />
          <span>{tr('outbox.badge.waiting', { count: waiting })}</span>
        </span>
      ) : null}
      {attention > 0 ? (
        <span className="qbadge__part qbadge__part--attention">
          <Icon name="alert" />
          <span>{tr('outbox.badge.attention', { count: attention })}</span>
        </span>
      ) : null}
    </a>
  );
}
