import type { CSSProperties, ReactNode } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';

/**
 * The frame of every customer screen, taken from the LINE boards of the design: a warm glass
 * backdrop filling the LIFF window, a glass header bar, a scrolling body and, when a screen needs
 * one, a floating glass dock at the bottom. The window never scrolls; the body does.
 */
export function Frame({ children }: { children: ReactNode }) {
  return <div className="g-root g-bg liff-frame">{children}</div>;
}

/** A 44px round icon button inside the header bar (the design draws 40px; the hit area is 44). */
export function BarButton({
  icon,
  label,
  onClick,
  expanded,
}: {
  icon: GiName;
  label: string;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="g-btn g-btn-icon"
      style={s('width:44px;height:44px;background:transparent;box-shadow:none;flex:none')}
      aria-label={label}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Gi n={icon} />
    </button>
  );
}

export function Header({
  left,
  title,
  right,
  children,
}: {
  left?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
  /** More header rows under the bar (the menu's delivery card and category chips). */
  children?: ReactNode;
}) {
  return (
    <header
      style={s(
        'padding:calc(env(safe-area-inset-top, 0px) + 14px) 14px 0;flex:none;display:flex;flex-direction:column;gap:12px;position:relative;z-index:3',
      )}
    >
      <div
        className="g-glass2"
        style={s('height:52px;border-radius:26px;display:flex;align-items:center;padding:0 8px')}
      >
        {left ?? <span style={s('width:44px;flex:none')} />}
        <h1
          className="g-t-3"
          style={s(
            'flex-grow:1;min-width:0;margin:0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          )}
        >
          {title}
        </h1>
        {right ?? <span style={s('width:44px;flex:none')} />}
      </div>
      {children}
    </header>
  );
}

/** The scrolling area between the header and the bottom of the window. */
export function Body({
  children,
  bottom = 28,
  fade,
  label,
  style,
}: {
  children: ReactNode;
  /** Space kept under the content, so the last row clears the dock. */
  bottom?: number;
  /** Height of the paper fade at the bottom edge (the design fades the list under the dock). */
  fade?: number;
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <main
      aria-label={label}
      style={s('flex-grow:1;min-height:0;position:relative;overflow:hidden')}
    >
      <div
        className="g-scroll liff-scroll"
        style={{
          ...s('position:absolute;inset:0;padding:14px 14px 0'),
          paddingBottom: `calc(${bottom}px + env(safe-area-inset-bottom, 0px))`,
          ...style,
        }}
      >
        {children}
      </div>
      {fade ? <div className="g-fade-b" style={{ height: fade }} /> : null}
    </main>
  );
}

/** The floating glass bar at the bottom of the window (cart bar on the menu, total on checkout). */
export function Dock({
  children,
  style,
  label,
}: {
  children: ReactNode;
  style?: CSSProperties;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className="g-glass2 g-slide-up"
      style={{
        ...s(
          'position:absolute;left:14px;right:14px;bottom:max(26px, calc(env(safe-area-inset-bottom, 0px) + 12px));z-index:4;display:flex;align-items:center;gap:12px;--d:.2s',
        ),
        ...style,
      }}
    >
      {children}
    </section>
  );
}

type Tone = 'info' | 'ok' | 'warn' | 'bad';
const TONE_COLOR: Record<Tone, string> = {
  info: 'var(--ink2)',
  ok: 'var(--jade)',
  warn: 'var(--amber-ink)',
  bad: 'var(--chili)',
};

/** A sunk note with an icon: guidance, confirmations and errors. Errors are announced at once. */
export function Notice({
  tone = 'info',
  icon = 'info',
  alert,
  children,
}: {
  tone?: Tone;
  icon?: GiName;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="g-sunk"
      role={alert ? 'alert' : 'status'}
      style={s('padding:12px 16px;display:flex;gap:10px;align-items:flex-start')}
    >
      <Gi n={icon} size="sm" style={{ marginTop: 3, color: TONE_COLOR[tone] }} />
      <div className="g-t-s" style={s('line-height:1.55;color:var(--ink);min-width:0;flex:1')}>
        {children}
      </div>
    </div>
  );
}

/** A label above a glass section ("รายการของคุณ"), as in the checkout board. */
export function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} className="g-t-c" style={s('padding:0 10px 6px')}>
      {children}
    </div>
  );
}
