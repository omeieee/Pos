import { useMemo } from 'react';
import { qrPath } from '../pos/local-qr.ts';

/**
 * A QR drawn on the device as one inline SVG path (no network, no image URL, nothing for the CSP
 * to block). White background and a quiet zone so a phone's authenticator app reads it in dark mode.
 * The text is the authenticator secret: nothing here keeps it or logs it.
 */
export function QrSvg({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      style={{ width: 'min(100%, 220px)', height: 'auto', alignSelf: 'center', borderRadius: 12 }}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
