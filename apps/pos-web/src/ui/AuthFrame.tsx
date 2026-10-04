import type { ReactNode } from 'react';
import { Brand } from './Brand.tsx';
import { useT } from './hooks.ts';
import './glass-forms.css';

/**
 * The full-screen frame of every sign-in screen (design: iphone-login). A warm backdrop with two
 * soft colour orbs, the brand opening at the top and the glass card below it. On a phone the card
 * sits at the bottom of the screen as in the design; on an iPad or a laptop the same column is
 * centred on the backdrop.
 */
export function AuthFrame({
  children,
  footer,
  compactHero,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /** Drops the tagline (a screen that needs the room for its own controls). */
  compactHero?: boolean;
}) {
  const tr = useT();
  return (
    <div className="g-root g-bg gauth">
      <span className="gauth__orb gauth__orb--a" aria-hidden="true" />
      <span className="gauth__orb gauth__orb--b" aria-hidden="true" />
      <main className="gauth__col">
        <div className="gauth__top" />
        {compactHero ? (
          <Brand hero />
        ) : (
          <Brand hero tagline={tr('auth.hero.tagline')} cta={tr('auth.hero.cta')} />
        )}
        <div className="gauth__gap" />
        {children}
        {footer}
      </main>
    </div>
  );
}

/** The glass card of the design: big radius, a strong frosted surface, rising from below. */
export function AuthCard({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section
      className="g-glass2 g-slide-up gauth__card"
      style={{ ['--d' as string]: '.1s' }}
      aria-label={label}
    >
      {children}
    </section>
  );
}
