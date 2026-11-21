import type { HTMLAttributes, ReactNode } from 'react';
import { motion } from 'motion/react';
import { ease } from './motion';
import './Card.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: 'glass' | 'solid' | 'outline' | 'cream';
  pad?: 'none' | 'sm' | 'md' | 'lg';
  /** Mono micro-label in the card head, e.g. "Readiness". */
  label?: ReactNode;
  /** Index number shown before the label, e.g. "01". */
  index?: string;
  /** Right side of the card head. */
  aside?: ReactNode;
  interactive?: boolean;
  /** Animate in with a short settle. Pass a number to delay (seconds). */
  settle?: boolean | number;
  children?: ReactNode;
}

export function Card({
  tone = 'glass',
  pad = 'md',
  label,
  index,
  aside,
  interactive,
  settle,
  className,
  children,
  ...rest
}: CardProps) {
  const cls = ['card', `card--${tone}`, `card--pad-${pad}`, interactive && 'card--interactive', className]
    .filter(Boolean)
    .join(' ');
  const head =
    label || index || aside ? (
      <div className="card__head">
        <span className="t-label card__label">
          {index && <span className="card__index">{index}</span>}
          {label}
        </span>
        {aside && <span className="card__aside">{aside}</span>}
      </div>
    ) : null;

  if (settle) {
    const delay = typeof settle === 'number' ? settle : 0;
    return (
      <motion.div
        className={cls}
        initial={{ opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease, delay }}
        {...(rest as object)}
      >
        {head}
        {children}
      </motion.div>
    );
  }
  return (
    <div className={cls} {...rest}>
      {head}
      {children}
    </div>
  );
}
