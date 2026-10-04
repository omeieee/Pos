import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useServices, useStoreState, useT } from './hooks.ts';

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
    <div
      className="g-glass2 g-pop banner banner--info"
      role="status"
      style={s('display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:999px')}
    >
      <Gi n="info" size="sm" />
      <span className="banner__text g-t-s" style={s('flex-grow:1;color:var(--ink)')}>
        {tr('app.update.ready')}
      </span>
      <button type="button" className="g-btn g-btn-sm" onClick={onApply}>
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
