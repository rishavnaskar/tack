import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { ease } from './motion';
import './Meter.css';

export interface MeterProps {
  value: number;
  max?: number;
  /** Optional target tick, in the same units as value (e.g. "need"). */
  marker?: number;
  tone?: 'paper' | 'accent' | 'olive' | 'cream';
  variant?: 'bar' | 'segments';
  /** Segment count for variant="segments". */
  segments?: number;
  size?: 'xs' | 'sm' | 'md';
  label?: ReactNode;
  /** Right side text; defaults to the rounded value when showValue is set. */
  valueLabel?: ReactNode;
  showValue?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Meter({
  value,
  max = 100,
  marker,
  tone = 'paper',
  variant = 'bar',
  segments = 10,
  size = 'sm',
  label,
  valueLabel,
  showValue,
  className,
  ...aria
}: MeterProps) {
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  const markerPct = marker !== undefined ? Math.max(0, Math.min(1, marker / max)) : undefined;
  const right = valueLabel ?? (showValue ? Math.round(value) : null);

  return (
    <div className={['meter', `meter--${size}`, `meter--${tone}`, className].filter(Boolean).join(' ')}>
      {(label || right !== null) && (
        <div className="meter__top">
          {label && <span className="meter__label">{label}</span>}
          {right !== null && <span className="meter__value t-num">{right}</span>}
        </div>
      )}
      <div
        className="meter__track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 10) / 10}
        aria-label={aria['aria-label'] ?? (typeof label === 'string' ? label : undefined)}
      >
        {variant === 'segments' ? (
          <div className="meter__segments">
            {Array.from({ length: segments }, (_, i) => (
              <span key={i} className={i < Math.round(pct * segments) ? 'is-on' : undefined} />
            ))}
          </div>
        ) : (
          <motion.div
            className="meter__fill"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: pct }}
            transition={{ duration: 1.1, ease }}
          />
        )}
        {markerPct !== undefined && <span className="meter__marker" style={{ left: `${markerPct * 100}%` }} />}
      </div>
    </div>
  );
}

export interface BarProps {
  label: ReactNode;
  value: number;
  max: number;
  /** Right side figure; defaults to value. */
  figure?: ReactNode;
  highlight?: boolean;
  delay?: number;
}

/** A labelled distribution row: label, hairline bar, figure. */
export function Bar({ label, value, max, figure, highlight, delay = 0 }: BarProps) {
  const pct = max ? Math.max(0.02, Math.min(1, value / max)) : 0;
  return (
    <div className={['bar', highlight && 'bar--hi'].filter(Boolean).join(' ')}>
      <span className="bar__label">{label}</span>
      <span className="bar__track">
        <motion.span
          className="bar__fill"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: pct }}
          transition={{ duration: 1, ease, delay }}
        />
      </span>
      <span className="bar__figure t-num">{figure ?? value}</span>
    </div>
  );
}
