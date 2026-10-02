import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { isolateSiblings } from '../lib/isolate.ts';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]';

/**
 * A dialog over a dimmed page. Focus moves into it and returns afterwards, Tab stays inside, and
 * Escape closes it. A tap on the dimmed area does nothing: a sensitive prompt must be dismissed
 * on purpose.
 */
export function Modal({
  labelledBy,
  onClose,
  variant,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  /** A layout variant (`options`, `cart`): a wide card on iPad, a bottom sheet on a phone. */
  variant?: 'options' | 'cart';
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement;
    // The page behind the dialog cannot be focused, tapped or read out while it is open, so a
    // tap on the dimmed area (focus falls to the body) cannot let Tab reach it.
    const parent = overlay.current?.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((el): el is HTMLElement => el instanceof HTMLElement)
      : [];
    const release = overlay.current ? isolateSiblings(siblings, overlay.current) : undefined;
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      release?.();
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !sheet.current) return;
    const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div ref={overlay} className={variant ? `overlay overlay--${variant}` : 'overlay'}>
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={variant ? `sheet sheet--${variant}` : 'sheet'}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
