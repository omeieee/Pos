import { defaultBrand } from '@sds/ui';

/**
 * The wordmark. The name is brand data (`defaultBrand` until the settings API exists), never a
 * string typed into a component.
 */
export function Brand() {
  return (
    <span className="wordmark">
      <span className="mark">
        <span className="i i-bowl" aria-hidden="true" />
      </span>
      {defaultBrand.name}
    </span>
  );
}
