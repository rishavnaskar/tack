import { useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Icon } from './icons';
import './Field.css';

interface FieldShellProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id: string;
  children: ReactNode;
  className?: string;
}

function FieldShell({ label, hint, error, id, children, className }: FieldShellProps) {
  return (
    <div className={['field', error && 'has-error', className].filter(Boolean).join(' ')}>
      {label && (
        <label className="field__label t-label" htmlFor={id}>
          {label}
        </label>
      )}
      {children}
      {(error || hint) && (
        <span className={error ? 'field__error' : 'field__hint'} id={`${id}-note`}>
          {error || hint}
        </span>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Large display input (used for the target role). */
  large?: boolean;
}

export function TextField({ label, hint, error, large, className, id, ...rest }: TextFieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} id={fid} className={className}>
      <input
        id={fid}
        className={['input', large && 'input--large'].filter(Boolean).join(' ')}
        aria-invalid={!!error || undefined}
        aria-describedby={error || hint ? `${fid}-note` : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextArea({ label, hint, error, className, id, ...rest }: TextAreaProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} id={fid} className={className}>
      <textarea
        id={fid}
        className="input input--area"
        aria-invalid={!!error || undefined}
        aria-describedby={error || hint ? `${fid}-note` : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, hint, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={['toggle', checked && 'is-on'].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__track">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__text">
        <span className="toggle__label">{label}</span>
        {hint && <span className="toggle__hint">{hint}</span>}
      </span>
    </button>
  );
}

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
  unit?: string;
  hint?: ReactNode;
}

export function Stepper({ value, onChange, min = 0, max = 100, step = 1, label, unit, hint }: StepperProps) {
  const id = useId();
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <FieldShell label={label} hint={hint} id={id}>
      <div className="stepper">
        <button type="button" className="stepper__btn" aria-label="Decrease" onClick={() => onChange(clamp(value - step))} disabled={value <= min}>
          <Icon name="minus" size={15} />
        </button>
        <span className="stepper__value">
          <input
            id={id}
            className="stepper__input t-num"
            inputMode="numeric"
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''));
              if (!Number.isNaN(n)) onChange(clamp(n));
            }}
            aria-valuemin={min}
            aria-valuemax={max}
          />
          {unit && <span className="stepper__unit">{unit}</span>}
        </span>
        <button type="button" className="stepper__btn" aria-label="Increase" onClick={() => onChange(clamp(value + step))} disabled={value >= max}>
          <Icon name="plus" size={15} />
        </button>
      </div>
    </FieldShell>
  );
}

export interface DropZoneProps {
  accept?: string;
  onFile: (file: File) => void;
  title: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
}

export function DropZone({ accept = 'application/pdf', onFile, title, hint, disabled, busy }: DropZoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={['dropzone', over && 'is-over', busy && 'is-busy', disabled && 'is-disabled'].filter(Boolean).join(' ')}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !disabled) onFile(f);
      }}
    >
      <button type="button" className="dropzone__hit" onClick={() => input.current?.click()} disabled={disabled}>
        <span className="dropzone__icon">
          <Icon name={busy ? 'file' : 'upload'} size={20} />
        </span>
        <span className="dropzone__title">{title}</span>
        {hint && <span className="dropzone__hint">{hint}</span>}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
