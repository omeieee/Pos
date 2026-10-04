import type { ReactNode } from 'react';
import { useLayout } from '../design/layout.ts';
import './settings-glass.css';

/**
 * The scrolling frame of every Settings page. On a phone it is the full-screen design (side
 * gutters of 20 px, content running under the floating tab bar); on an iPad or a laptop the content
 * is a centred column (at most 720 px) inside the shell's page area.
 */
export function SettingsPage({
  labelledBy,
  children,
  maxWidth = 720,
}: {
  labelledBy: string;
  children: ReactNode;
  /** Width of the centred column on a wide screen. */
  maxWidth?: number;
}) {
  const layout = useLayout();
  return (
    <section
      className={`gset-page g-scroll${layout === 'phone' ? ' gset-page--phone' : ''}`}
      aria-labelledby={labelledBy}
    >
      <div className="gset-col" style={{ maxWidth }}>
        {children}
      </div>
    </section>
  );
}
