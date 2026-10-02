import { type HTMLInputTypeAttribute, useId } from 'react';

type InputMode = 'text' | 'numeric' | 'decimal' | 'email';

/** A labelled input. 16 px text (see styles.css) keeps iOS Safari from zooming in on focus. */
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
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="field-group">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
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
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
