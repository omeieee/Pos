import { useEffect, useMemo } from 'react';
import { qrPath } from './local-qr.ts';

/**
 * The QR as an inline SVG, drawn from the text on this device (see `local-qr.ts`). It is its own
 * file so the drawing library loads only when an offline QR is shown (`LocalQr` imports it lazily);
 * the service worker still has it in its precache, so it is there with no connection.
 *
 * The text is the PromptPay payload and holds the ID: it is read here and turned into a path, never
 * put in the page as text, an attribute, a label or a title. `label` is the amount only. Black on
 * white with the quiet zone of the QR specification, whatever the theme: a scanner needs the contrast.
 */
export default function QrSvg({
  payload,
  label,
  onFailed,
}: {
  payload: string;
  label: string;
  onFailed: () => void;
}) {
  const drawn = useMemo(() => {
    try {
      return qrPath(payload);
    } catch {
      return null;
    }
  }, [payload]);
  useEffect(() => {
    if (drawn === null) onFailed();
  }, [drawn, onFailed]);
  if (drawn === null) return null;
  return (
    <svg
      className="qr qr--local"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${drawn.size} ${drawn.size}`}
      shapeRendering="crispEdges"
    >
      <rect width={drawn.size} height={drawn.size} fill="#fff" />
      <path d={drawn.d} fill="#000" />
    </svg>
  );
}
