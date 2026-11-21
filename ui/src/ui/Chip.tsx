import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Level } from '../api/types';
import './Chip.css';

export type ChipTone = 'default' | 'accent' | 'olive' | 'cream' | 'mute';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  tone?: ChipTone;
  size?: 'sm' | 'md';
  /** Level glyph before the text (same marks as the gap constellation). */
  level?: Level;
  /** Filter chips: renders as a toggle button with aria-pressed. */
  selected?: boolean;
  count?: number;
  mono?: boolean;
  onClick?: () => void;
  children: ReactNode;
}

export function Chip({ tone = 'default', size = 'md', level, selected, count, mono, onClick, className, children, ...rest }: ChipProps) {
  const cls = [
    'chip',
    `chip--${tone}`,
    `chip--${size}`,
    mono && 'chip--mono',
    onClick && 'chip--button',
    selected && 'is-selected',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const content = (
    <>
      {level && <LevelGlyph level={level} size={size === 'sm' ? 9 : 10} />}
      <span className="chip__text">{children}</span>
      {count !== undefined && <span className="chip__count t-num">{count}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} aria-pressed={selected} onClick={onClick} {...rest}>
        {content}
      </button>
    );
  }
  return <span className={cls}>{content}</span>;
}

/** The three skill marks: solid paper, half-filled ring, accent outline. */
export function LevelGlyph({ level, size = 10 }: { level: Level; size?: number }) {
  const r = size / 2 - 1;
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="level-glyph">
      {level === 'strong' && <circle cx={c} cy={c} r={r} fill="var(--paper)" />}
      {level === 'partial' && (
        <>
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--paper)" strokeWidth={1.2} />
          <path d={`M ${c - r} ${c} A ${r} ${r} 0 0 0 ${c + r} ${c} Z`} fill="var(--paper)" />
        </>
      )}
      {level === 'missing' && <circle cx={c} cy={c} r={r} fill="none" stroke="var(--accent)" strokeWidth={1.4} />}
    </svg>
  );
}

export const levelLabel: Record<Level, string> = {
  strong: 'Strong',
  partial: 'Partial',
  missing: 'Missing',
};
