import type { ReactNode } from 'react';
import { s } from './style.ts';

/**
 * The header every page of the design opens with: a title with a quiet line under it, and on
 * the right whatever the page puts there (search, sync pill, buttons).
 */
export function PageHeader({
  id,
  title,
  subtitle,
  children,
  wrap = false,
}: {
  id?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  wrap?: boolean;
}) {
  return (
    <header style={s(`display:flex;align-items:center;gap:16px;${wrap ? 'flex-wrap:wrap;' : ''}`)}>
      <div
        style={s(
          `flex-grow:1;display:flex;flex-direction:column;${wrap ? 'min-width:240px;' : 'min-width:0;'}`,
        )}
      >
        <h1 id={id} className="g-t-1" style={s('margin:0')}>
          {title}
        </h1>
        {subtitle ? <div className="g-t-s">{subtitle}</div> : null}
      </div>
      {children}
    </header>
  );
}
