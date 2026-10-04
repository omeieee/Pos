import { type ComponentProps, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal.tsx';

/**
 * The shared `Modal`, drawn at the top of the app. The panels of this screen are frosted glass, and
 * a frosted (backdrop-filter) parent becomes the frame of a `position: fixed` child, so a dialog
 * left inside one would open inside the card instead of over the page. The dialog goes into the
 * app root (the `g-root` the design styles hang from) and keeps the Modal's focus and Escape rules.
 */
export function PortalModal(props: ComponentProps<typeof Modal>) {
  const anchor = useRef<HTMLSpanElement>(null);
  // `undefined` until the first layout, then the app root, or null when there is none (a bare
  // render), in which case the dialog simply stays where it is.
  const [host, setHost] = useState<Element | null | undefined>(undefined);
  useLayoutEffect(() => {
    setHost(anchor.current?.closest('.g-root') ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {host === undefined ? null : host === null ? (
        <Modal {...props} />
      ) : (
        createPortal(<Modal {...props} />, host)
      )}
    </>
  );
}
