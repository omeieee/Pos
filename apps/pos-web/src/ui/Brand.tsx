import { defaultBrand } from '@sds/ui';
import { s } from '../design/style.ts';
import './glass-forms.css';

/**
 * The brand. `hero` is the sign-in opening of the design: the app mark, the name in display size
 * and a line under it. Without it, a small mark and the name in a row. The name is brand data
 * (`defaultBrand` until the settings API exists), never a string typed into a component.
 */
export function Brand({ hero, tagline, cta }: { hero?: boolean; tagline?: string; cta?: string }) {
  if (!hero) {
    return (
      <span className="g-t-3" style={s('display:inline-flex;align-items:center;gap:10px')}>
        <img src="/mark.svg" alt="" width={32} height={32} style={s('border-radius:10px')} />
        {defaultBrand.name}
      </span>
    );
  }
  return (
    <div
      className="g-rise"
      style={s('display:flex;flex-direction:column;gap:12px;align-items:flex-start;padding:0 4px')}
    >
      <img
        src="/mark.svg"
        alt=""
        width={68}
        height={68}
        style={s(
          'width:68px;height:68px;border-radius:22px;box-shadow:0 16px 32px rgba(198,40,40,.35)',
        )}
      />
      <div className="g-t-d" style={s('margin-top:8px')}>
        {defaultBrand.name}
      </div>
      {tagline || cta ? (
        <div className="g-t-m" style={s('font-size:16px;line-height:1.6')}>
          {tagline}
          {tagline && cta ? <br /> : null}
          {cta}
        </div>
      ) : null}
    </div>
  );
}
