import { motion, useReducedMotion } from 'motion/react';
import { ease } from './motion';
import './Wordmark.css';

export interface WordmarkProps {
  /** Animate letters rising in. */
  reveal?: boolean;
  className?: string;
}

/** The giant tight-tracked "Tack". Size comes from --fs-display; override with a class. */
export function Wordmark({ reveal = true, className }: WordmarkProps) {
  const reduce = useReducedMotion();
  const letters = 'Tack'.split('');
  return (
    <h1 className={['wordmark', className].filter(Boolean).join(' ')} aria-label="Tack">
      {letters.map((l, i) => (
        <span className="wordmark__clip" key={i} aria-hidden="true">
          <motion.span
            className="wordmark__letter"
            initial={reveal && !reduce ? { y: '105%' } : false}
            animate={{ y: '0%' }}
            transition={{ duration: 1.2, ease, delay: 0.1 + i * 0.07 }}
          >
            {l}
          </motion.span>
        </span>
      ))}
      <motion.span
        className="wordmark__dot"
        aria-hidden="true"
        initial={reveal && !reduce ? { scale: 0, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.9, ease, delay: 0.7 }}
      />
    </h1>
  );
}
