import { type ReactNode, useId } from 'react';
import { s } from '../design/style.ts';
import { FieldMessage } from './TextField.tsx';
import './glass-forms.css';

/** A glass card that holds one group of fields. */
export function FormCard({
  children,
  gap = 16,
  className,
}: {
  children: ReactNode;
  gap?: number;
  className?: string;
}) {
  return (
    <div
      className={`g-glass ${className ?? ''}`.trim()}
      style={s(`padding:22px;display:flex;flex-direction:column;gap:${gap}px;border-radius:28px`)}
    >
      {children}
    </div>
  );
}

/** Two fields side by side on a wide screen, stacked on a phone. */
export function FieldPair({ children }: { children: ReactNode }) {
  return <div className="gdlg__pair">{children}</div>;
}

/** A labelled group of controls (a fieldset with a legend). */
export function FieldGroup({
  legend,
  hint,
  error,
  title,
  children,
}: {
  legend: string;
  /** The legend is a heading of its own (16 px, strong) rather than a small field label. */
  title?: boolean;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset className={title ? 'gset gset--title' : 'gset'}>
      <legend>{legend}</legend>
      {hint ? <FieldMessage tone="hint">{hint}</FieldMessage> : null}
      {children}
      {error ? <FieldMessage tone="bad">{error}</FieldMessage> : null}
    </fieldset>
  );
}

/** A pill that is on or off (a checkbox underneath): closed weekdays, channels, option groups. */
export function CheckChip({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`g-chip${disabled ? ' gchip--off' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** A segmented control (radio buttons underneath): the staff role, the PromptPay ID type, the tabs. */
export function SegRadio<T extends string>({
  legend,
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="g-seg">
      <legend className="gvh">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={`g-chip${value === option.value ? ' g-on' : ''}${disabled ? ' gchip--off' : ''}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A switch with its words: the label on the left (and a quiet line under it), the switch on the
 * right. The switch is a real checkbox named by the label, so it works with keyboard and VoiceOver.
 */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="gswitch">
      <div className="gswitch__text">
        <span id={`${id}-l`} className="g-t-3" style={s('font-weight:500')}>
          {label}
        </span>
        {hint ? (
          <span id={`${id}-h`} className="g-t-c">
            {hint}
          </span>
        ) : null}
      </div>
      <input
        type="checkbox"
        className="g-sw"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-l`}
        aria-describedby={hint ? `${id}-h` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}
