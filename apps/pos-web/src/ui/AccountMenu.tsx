import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { SignOutGuard } from '../pos/SignOutGuard.tsx';
import { useAuthState, useAuthStore, useServices, useStoreState, useT } from './hooks.ts';

/**
 * The signed-in person, as a button that opens a small glass panel: who, role, which device, and
 * the sign-out. The design has no top bar any more, so these facts live behind the avatar (rail),
 * the user card (sidebar) or the profile row (phone settings). Signing out with orders still on
 * this device asks first (SignOutGuard).
 */
export function AccountMenu({
  className,
  style,
  placement,
  label,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  /** Where the panel opens: beside the rail, above the sidebar card, or below a settings row. */
  placement: 'right' | 'top' | 'bottom' | 'bottom-end';
  label: string;
  children: ReactNode;
}) {
  const auth = useAuthStore();
  const state = useAuthState();
  const tr = useT();
  const waiting = useStoreState(useServices().outbox).items.length;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const session = state.session;

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!session) return null;
  const place: React.CSSProperties =
    placement === 'right'
      ? { left: 'calc(100% + 12px)', bottom: 0 }
      : placement === 'top'
        ? { left: 0, right: 0, bottom: 'calc(100% + 8px)' }
        : placement === 'bottom-end'
          ? { right: 0, top: 'calc(100% + 8px)' }
          : { left: 0, right: 0, top: 'calc(100% + 8px)' };

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button
        type="button"
        className={className}
        style={style}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </button>
      {open ? (
        <div
          id={panelId}
          className="g-glass2 g-pop"
          style={{
            position: 'absolute',
            zIndex: 30,
            width: placement === 'right' || placement === 'bottom-end' ? 260 : undefined,
            minWidth: 220,
            padding: 16,
            borderRadius: 24,
            // solid enough to read over the page behind it (glass on glass turns grey)
            background: 'var(--menu-bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            ...place,
          }}
        >
          <div style={s('line-height:1.3')}>
            <div className="g-t-3">{session.staff.displayName}</div>
            <div className="g-t-c">{tr(`role.${session.staff.role}`)}</div>
          </div>
          {state.device ? (
            <div className="g-t-c">{tr('shell.device', { name: state.device.name })}</div>
          ) : null}
          <hr className="g-hair" />
          <button
            type="button"
            className="g-btn g-btn-block"
            onClick={() => {
              setOpen(false);
              if (waiting > 0) setConfirming(true);
              else void auth.signOut();
            }}
          >
            <Gi n="signOut" size="sm" />
            {tr('shell.signOut')}
          </button>
        </div>
      ) : null}
      {confirming ? (
        <SignOutGuard
          count={waiting}
          onCancel={() => setConfirming(false)}
          onSignOut={() => void auth.signOut()}
        />
      ) : null}
    </div>
  );
}
