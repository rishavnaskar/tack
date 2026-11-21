import type { ReactNode } from 'react';
import './Stat.css';

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  /** One short line under the figure. */
  note?: ReactNode;
  /** Signed change; positive renders in paper with a +, negative in accent. */
  delta?: number;
  size?: 'sm' | 'md' | 'lg';
  index?: string;
}

export function Stat({ label, value, unit, note, delta, size = 'md', index }: StatProps) {
  return (
    <div className={`stat stat--${size}`}>
      <span className="t-label stat__label">
        {index && <span className="t-faint">{index}</span>}
        {label}
      </span>
      <span className="stat__value t-num">
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
        {delta !== undefined && delta !== 0 && (
          <span className={`stat__delta ${delta < 0 ? 'is-down' : ''}`}>
            {delta > 0 ? '+' : ''}
            {delta}
          </span>
        )}
      </span>
      {note && <span className="stat__note">{note}</span>}
    </div>
  );
}
