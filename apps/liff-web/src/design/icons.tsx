import type { ReactNode } from 'react';

/** The stroke icons of the design canvas (24x24 grid) that the customer app uses; same paths as the staff app. */
const ICONS = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
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
  chevronDown: (
    <>
      <path d="M6 9l6 6 6-6" />
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
  warn: (
    <>
      <path d="M12 4l9 16H3zM12 10v4M12 17h.01" />
    </>
  ),
  bank: (
    <>
      <path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />
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
  shieldCheck: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
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
  more: (
    <>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
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
