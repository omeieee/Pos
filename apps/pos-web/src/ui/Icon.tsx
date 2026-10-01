import type { IconName } from '../app/routes.ts';

/** Decorative icon (a CSS mask in styles.css). The text next to it carries the meaning. */
export function Icon({ name }: { name: IconName }) {
  return <span className={`i i-${name}`} aria-hidden="true" />;
}
