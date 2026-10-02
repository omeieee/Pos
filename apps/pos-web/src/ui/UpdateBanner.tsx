import { useServices, useStoreState, useT } from './hooks.ts';
import { Icon } from './Icon.tsx';

export function UpdateBannerView({
  needRefresh,
  onApply,
}: {
  needRefresh: boolean;
  onApply: () => void;
}) {
  const tr = useT();
  if (!needRefresh) return null;
  return (
    <div className="banner banner--info" role="status">
      <Icon name="sync" />
      <span className="banner__text">{tr('app.update.ready')}</span>
      <button type="button" className="btn btn-soft" onClick={onApply}>
        {tr('app.update.apply')}
      </button>
    </div>
  );
}

/** A waiting service-worker version. Applying reloads the page, so the person chooses the moment. */
export function UpdateBanner() {
  const { updates } = useServices();
  const { needRefresh } = useStoreState(updates);
  return <UpdateBannerView needRefresh={needRefresh} onApply={() => void updates.apply()} />;
}
