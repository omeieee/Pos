import { type HTMLInputTypeAttribute, type ReactNode, useId } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import './glass-forms.css';

type InputMode = 'text' | 'numeric' | 'decimal' | 'email';

/** The message under a field: a hint, or what is wrong (read out with the field). */
export function FieldMessage({
  id,
  tone,
  children,
}: {
  id?: string | undefined;
  tone: 'hint' | 'bad';
  children: ReactNode;
}) {
  return tone === 'bad' ? (
    <p id={id} className="gfield__msg gfield__msg--bad" role="alert">
      <Gi n="warn" />
      <span>{children}</span>
    </p>
  ) : (
    <p id={id} className="gfield__msg">
      {children}
    </p>
  );
}

/**
 * A labelled input in the design's field style (a glass well with an optional leading icon and a
 * trailing control). 16 px text keeps iOS Safari from zooming in on focus.
 */
export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  inputMode,
  autoComplete,
  maxLength,
  placeholder,
  hint,
  error,
  disabled,
  icon,
  end,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: HTMLInputTypeAttribute;
  inputMode?: InputMode;
  autoComplete?: string;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  /** What is wrong with the value: shown under the field and read out with it. */
  error?: string | undefined;
  disabled?: boolean;
  /** A design icon at the start of the field. */
  icon?: GiName;
  /** A control at the end of the field (the show-password eye). */
  end?: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="gfield">
      <label className="gfield__label" htmlFor={id}>
        {label}
      </label>
      <span className={error ? 'g-field gfield__box--bad' : 'g-field'}>
        {icon ? <Gi n={icon} /> : null}
        <input
          id={id}
          type={type}
          value={value}
          inputMode={inputMode}
          autoComplete={autoComplete}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={
            [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
          }
          aria-invalid={error ? true : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {end}
      </span>
      {hint ? (
        <FieldMessage id={hintId} tone="hint">
          {hint}
        </FieldMessage>
      ) : null}
      {error ? (
        <FieldMessage id={errorId} tone="bad">
          {error}
        </FieldMessage>
      ) : null}
    </div>
  );
}

/** A labelled drop-down in the same field style. */
export function SelectField({
  label,
  value,
  onChange,
  error,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="gfield">
      <label className="gfield__label" htmlFor={id}>
        {label}
      </label>
      <span className={error ? 'g-field gfield__box--bad' : 'g-field'}>
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
        >
          {children}
        </select>
        <Gi n="chevronDown" size="sm" />
      </span>
      {error ? (
        <FieldMessage id={errorId} tone="bad">
          {error}
        </FieldMessage>
      ) : null}
    </div>
  );
}
