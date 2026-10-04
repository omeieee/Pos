import type { CSSProperties, ReactNode } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import { type Layout, useLayout } from '../design/layout.ts';
import { s } from '../design/style.ts';
import { useT } from '../ui/hooks.ts';
import { PortalModal } from '../ui/PortalModal.tsx';
import './pay-glass.css';

/**
 * Pieces the payment screens share, all in the design's glass language: the numbered steps of the
 * "ipad-payment" board, a notice block, a sheet body for dialogs and the widths the board gives its
 * columns (full size on the laptop, a little narrower beside the iPad's rail, stacked on a phone).
 */

export interface PayDims {
  layout: Layout;
  /** The order summary column. */
  aside: number;
  /** The white PromptPay card. */
  qr: number;
  /** The cash keypad. */
  keypad: number;
  /** Padding of the glass panel. */
  pad: number;
  /** Gap between the two columns of a panel. */
  gap: number;
}

export function payDims(layout: Layout): PayDims {
  if (layout === 'side') return { layout, aside: 380, qr: 320, keypad: 330, pad: 26, gap: 28 };
  if (layout === 'rail') return { layout, aside: 340, qr: 270, keypad: 284, pad: 22, gap: 20 };
  return { layout, aside: 0, qr: 320, keypad: 0, pad: 18, gap: 16 };
}

export function usePayDims(): PayDims {
  return payDims(useLayout());
}

export interface Step {
  state: 'done' | 'now' | 'todo';
  title: ReactNode;
  sub?: ReactNode;
}

/** The numbered steps of the design: done (green tick), now (chili, ringed), later (grey). */
export function PaySteps({ steps, gap = 12 }: { steps: readonly Step[]; gap?: number }) {
  return (
    <ol className="pay-steps" style={{ gap }}>
      {steps.map((step, index) => (
        <li
          // The steps of a screen are fixed and in order, so the position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          className={`pay-stp${step.state === 'done' ? ' pay-done' : step.state === 'now' ? ' pay-now' : ''}`}
          aria-current={step.state === 'now' ? 'step' : undefined}
        >
          <div className="pay-n">
            {step.state === 'done' ? <Gi n="check" size="sm" /> : <span>{index + 1}</span>}
          </div>
          <div style={s('min-width:0')}>
            <div className="g-t-3" style={s('font-size:15px')}>
              {step.title}
            </div>
            {step.sub ? <div className="g-t-c">{step.sub}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

type Tone = 'warn' | 'bad' | 'info' | 'ok';

const TONE: Record<Tone, { bg: string; fg: string; icon: GiName }> = {
  warn: { bg: 'var(--amber-soft)', fg: 'var(--amber-ink)', icon: 'warn' },
  bad: { bg: 'var(--chili-soft)', fg: 'var(--chili-ink)', icon: 'warn' },
  info: { bg: 'var(--sky-soft)', fg: 'var(--sky-ink)', icon: 'info' },
  ok: { bg: 'var(--jade-soft)', fg: 'var(--jade-ink)', icon: 'check' },
};

/** A message block (a notice, a refusal, a reminder): colour + icon + words, never colour alone. */
export function Callout({
  tone,
  icon,
  role,
  children,
  style,
}: {
  tone: Tone;
  icon?: GiName;
  role?: 'alert' | 'status';
  children: ReactNode;
  style?: CSSProperties;
}) {
  const look = TONE[tone];
  return (
    <div
      role={role}
      style={{
        ...s(
          `display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:14px;background:${look.bg};color:${look.fg};font-size:14px;font-weight:600;line-height:1.5`,
        ),
        ...style,
      }}
    >
      <Gi n={icon ?? look.icon} size="sm" style={s('margin-top:2px;flex:none')} />
      <span style={s('min-width:0')}>{children}</span>
    </div>
  );
}

/** The body of a dialog (the shared Modal brings no padding of its own). */
export function SheetBody({ children }: { children: ReactNode }) {
  return (
    <div
      style={s(
        'display:flex;flex-direction:column;gap:16px;padding:24px 24px calc(22px + env(safe-area-inset-bottom, 0px));min-height:0',
      )}
    >
      {children}
    </div>
  );
}

/** A labelled single-line field of the design (`g-field`). */
export function TextRow({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  compact = false,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Quiet label, for a field that is optional and shares a tight column. */
  compact?: boolean;
}) {
  return (
    <div style={s(`display:flex;flex-direction:column;gap:${compact ? 4 : 6}px`)}>
      <label
        className={compact ? 'g-t-c' : 'g-t-3'}
        style={s(compact ? '' : 'font-size:15px')}
        htmlFor={id}
      >
        {label}
      </label>
      <div className="g-field">
        <input
          id={id}
          type="text"
          maxLength={200}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

/** The title row of a dialog: a heading and, if given, a close button. */
export function SheetTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="g-t-1" style={s('margin:0')}>
      {children}
    </h2>
  );
}

/** The shared `Modal` drawn at the top of the app (see `PortalModal`); the payment screens' name for it. */
export const PayModal = PortalModal;

/**
 * The right column of the payment screen: the title with its quiet line and the method switch on
 * the same row, then one frosted panel that holds whatever the payment needs. The order page and
 * the page of an order still on this device both wear it.
 */
export function PayFrame({
  title,
  notes,
  switcher,
  amountLabel,
  amountText,
  notice,
  disabled = false,
  after,
  children,
}: {
  title: ReactNode;
  /** Small lines under the title (why a method is off). */
  notes?: ReactNode;
  /** The method switch, on the right of the title. */
  switcher?: ReactNode;
  /** The amount due in words for a screen reader (the big figure is drawn in the cards). */
  amountLabel?: string;
  amountText?: string | undefined;
  /** Above the panel (another order's payment is being saved). */
  notice?: ReactNode;
  /** Every control inside the panel is off. */
  disabled?: boolean;
  /** Below the panel (the history of past payments). */
  after?: ReactNode;
  children: ReactNode;
}) {
  const tr = useT();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
  return (
    <section
      aria-labelledby="pay-title"
      className="pay-page"
      style={s(
        `flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:16px;${phone ? '' : 'min-height:0;'}`,
      )}
    >
      <header
        style={s(
          `display:flex;align-items:${phone ? 'stretch' : 'center'};gap:${phone ? 12 : 16}px;${phone ? 'flex-direction:column;' : ''}flex:none`,
        )}
      >
        <div style={s('flex-grow:1;min-width:0')}>
          <h2 id="pay-title" className="g-t-1" style={s('margin:0')}>
            {title}
          </h2>
          <div className="g-t-s">{tr('payment.staffConfirms')}</div>
          {amountLabel && amountText ? (
            <span className="visually-hidden">
              <span>{amountLabel}</span>
              <span>{amountText}</span>
            </span>
          ) : null}
        </div>
        {switcher}
      </header>
      {notes}
      {notice}
      {/* A call for another order is still running: the server calls here would be refused, so
          the controls are off (a disabled fieldset disables every button inside it). */}
      <fieldset
        className={phone ? 'g-glass2' : 'g-glass2 g-scroll'}
        disabled={disabled}
        style={s(
          `flex:${phone ? 'none' : '1 1 0'};min-width:0;min-height:${phone ? 'auto' : '0'};margin:0;border-radius:${phone ? 28 : 32}px;padding:${dims.pad}px;display:flex;flex-direction:column`,
        )}
      >
        {children}
      </fieldset>
      {after}
    </section>
  );
}

/** The page of an order is the payment screen: the order on the left, the payment on the right. */
export function PayPage({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const phone = useLayout() === 'phone';
  return (
    <section
      aria-labelledby={labelledBy}
      className={`pay-page${phone ? ' g-scroll' : ''}`}
      style={s(
        phone
          ? 'flex:1;min-height:0;display:flex;flex-direction:column;gap:16px;padding:calc(env(safe-area-inset-top, 0px) + 16px) 16px 0'
          : 'flex:1;min-height:0;display:flex;gap:18px',
      )}
    >
      {children}
    </section>
  );
}

/** A short message in the middle of the page (loading, not found, failed). */
export function PageNote({ children }: { children: ReactNode }) {
  return (
    <section
      className="g-glass pay-page"
      style={s(
        'margin:auto;width:min(420px,calc(100% - 32px));border-radius:28px;padding:28px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center',
      )}
    >
      {children}
    </section>
  );
}
