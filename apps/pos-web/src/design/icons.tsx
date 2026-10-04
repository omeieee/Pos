import type { ReactNode } from 'react';

/** Stroke icons of the design canvas (24x24 grid), by name. Drawn by `Gi`; the paths are the canvas paths. */
const ICONS = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  flame: (
    <>
      <path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .5 1.5 1.5 2 2 2 0-3-1-5 1-8z" />
    </>
  ),
  glass: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <path d="M8 14c2-3 6-3 8 0" />
    </>
  ),
  check: (
    <>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </>
  ),
  pending: (
    <>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  x: (
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  ),
  minus: (
    <>
      <path d="M5 12h14" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  cash: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  chevronRight: (
    <>
      <path d="M9 6l6 6-6 6" />
    </>
  ),
  chevronLeft: (
    <>
      <path d="M15 6l-6 6 6 6" />
    </>
  ),
  dot: (
    <>
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </>
  ),
  building: (
    <>
      <path d="M5 21V4h9v17M14 9h5v12M3 21h18" />
    </>
  ),
  note: (
    <>
      <path d="M5 4h14v12l-4 4H5zM15 20v-4h4" />
    </>
  ),
  store: (
    <>
      <path d="M4 9l1.5-5h13L20 9M4 9v11h16V9" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4l9 16H3zM12 10v4M12 17h.01" />
    </>
  ),
  home: (
    <>
      <path d="M3 11l9-8 9 8M5 10v10h14V10" />
    </>
  ),
  qrBig: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 20v-2M20 14v2" />
    </>
  ),
  bank: (
    <>
      <path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  backspace: (
    <>
      <path d="M20 5H9l-6 7 6 7h11zM13 9l4 6M17 9l-4 6" />
    </>
  ),
  warn2: (
    <>
      <path d="M12 3l9 16H3zM12 10v4M12 17h.01" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />
    </>
  ),
  bowl: (
    <>
      <path d="M3 11h18c0 5-4 9-9 9s-9-4-9-9zM8 6c1-1.5 1-2.5 0-4M13 6c1-1.5 1-2.5 0-4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  bag: (
    <>
      <path d="M5 7h14l-1.2 12H6.2zM9 7a3 3 0 0 1 6 0" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  shieldCheck: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  shop: (
    <>
      <path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M10 20v-5h4v5" />
    </>
  ),
  qr: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 18h2v2h-2z" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="3" />
      <path d="M11 18.5h2" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.4.8 3.5 2.8 3.5 6" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="2" />
      <rect x="14" y="3" width="7" height="5" rx="2" />
      <rect x="14" y="12" width="7" height="9" rx="2" />
      <rect x="3" y="16" width="7" height="5" rx="2" />
    </>
  ),
  bars: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  dollar: (
    <>
      <path d="M12 3v18M16.5 7.5c-1-1.2-2.6-1.8-4.5-1.8-2.5 0-4 1.1-4 2.8 0 4 8.5 1.5 8.5 5.8 0 1.7-1.7 2.9-4.5 2.9-2 0-3.7-.7-4.7-2" />
    </>
  ),
  doc: (
    <>
      <path d="M5 3h10l4 4v14H5zM14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  chevronUp: (
    <>
      <path d="M7 14l5-5 5 5" />
    </>
  ),
  receipt2: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6" />
    </>
  ),
  chevronDown2: (
    <>
      <path d="M7 10l5 5 5-5" />
    </>
  ),
  trend: (
    <>
      <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
    </>
  ),
  shieldCheck2: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM9 12l2 2 4-4" />
    </>
  ),
  more: (
    <>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
    </>
  ),
  chevronDown: (
    <>
      <path d="M6 9l6 6 6-6" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M8 6l1.5-2h5L16 6" />
      <circle cx="12" cy="12.5" r="3" />
    </>
  ),
  chat: (
    <>
      <path d="M4 5h16v11H9l-5 4z" />
    </>
  ),
  building2: (
    <>
      <path d="M5 21V4h9v17M14 9h5v12M3 21h18M9 9h1M9 13h1" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="9" cy="11" r="2" />
      <path d="M21 16l-5-4-7 7" />
    </>
  ),
  signOut: (
    <>
      <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18M10.6 5.2A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.7C3.7 8.6 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type GiName = keyof typeof ICONS;

/** One icon: `size` is the canvas `sm` (18px), default (22px) or `lg` (26px). Decorative, so hidden from screen readers. */
export function Gi({
  n,
  size,
  className,
  style,
}: {
  n: GiName;
  size?: 'sm' | 'lg';
  className?: string;
  style?: React.CSSProperties;
}) {
  const cls = ['g-i', size === 'sm' ? 'g-sm' : size === 'lg' ? 'g-lg' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={style}>
      {ICONS[n]}
    </svg>
  );
}
