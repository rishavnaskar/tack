import { useEffect, useState } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { ease } from './motion';
import './Dial.css';

export interface DialProps {
  /** 0-100 */
  value: number;
  size?: number;
  label?: string;
  /** Small line under the figure, e.g. "of the market's asks". */
  caption?: string;
  ticks?: number;
}

const SWEEP = 280;

export function Dial({ value, size = 220, label = 'Readiness', caption, ticks = 64 }: DialProps) {
  const reduce = useReducedMotion();
  const target = Math.max(0, Math.min(100, value));
  const [shown, setShown] = useState(reduce ? target : 0);

  useEffect(() => {
    if (reduce) {
      setShown(target);
      return;
    }
    const controls = animate(0, target, { duration: 1.6, ease, onUpdate: (v) => setShown(v) });
    return () => controls.stop();
  }, [target, reduce]);

  const c = size / 2;
  const rOuter = size / 2 - 4;
  const lit = Math.round((shown / 100) * (ticks - 1));
  const start = -90 - SWEEP / 2;

  return (
    <div className="dial" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} ${Math.round(target)} out of 100`}>
        {Array.from({ length: ticks }, (_, i) => {
          const a = ((start + (SWEEP * i) / (ticks - 1)) * Math.PI) / 180;
          const isTip = i === lit && shown > 0.5;
          const on = i <= lit && shown > 0.5;
          const major = i % 8 === 0;
          const len = isTip ? 18 : major ? 11 : 7;
          const r1 = rOuter;
          const r2 = rOuter - len;
          return (
            <line
              key={i}
              x1={c + r1 * Math.cos(a)}
              y1={c + r1 * Math.sin(a)}
              x2={c + r2 * Math.cos(a)}
              y2={c + r2 * Math.sin(a)}
              stroke={isTip ? 'var(--accent)' : on ? 'var(--paper)' : 'rgba(247,246,244,.16)'}
              strokeWidth={isTip ? 2.2 : 1.2}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <div className="dial__center">
        <span className="t-label dial__label">{label}</span>
        <span className="dial__figure t-num">
          {Math.round(shown)}
          <span className="dial__unit">/100</span>
        </span>
        {caption && <span className="dial__caption">{caption}</span>}
      </div>
    </div>
  );
}
