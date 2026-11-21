import { Fragment, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ease } from './motion';
import './PageHeader.css';

export interface RevealWordsProps {
  text: string;
  /** Seconds before the first word moves. */
  delay?: number;
  step?: number;
  className?: string;
}

/** Word-by-word rise for headings. Renders plain text for reduced motion. */
export function RevealWords({ text, delay = 0, step = 0.06, className }: RevealWordsProps) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={className}>{text}</span>;
  const words = text.split(' ');
  return (
    <span className={['reveal', className].filter(Boolean).join(' ')} aria-label={text}>
      {words.map((w, i) => (
        <Fragment key={`${w}-${i}`}>
          <span className="reveal__word" aria-hidden="true">
            <motion.span
              className="reveal__inner"
              initial={{ y: '108%' }}
              animate={{ y: '0%' }}
              transition={{ duration: 0.95, ease, delay: delay + i * step }}
            >
              {w}
            </motion.span>
          </span>
          {i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </span>
  );
}

export interface PageHeaderProps {
  /** Two-digit screen index, e.g. "02". */
  index: string;
  /** Section name shown next to the index, e.g. "Gap map". */
  section: string;
  title: string;
  /** One line on what this screen is for. */
  purpose?: ReactNode;
  actions?: ReactNode;
  /** Extra row under the purpose (meta chips, stats). */
  children?: ReactNode;
}

export function PageHeader({ index, section, title, purpose, actions, children }: PageHeaderProps) {
  return (
    <header className="page-header">
      <motion.div
        className="page-header__eyebrow"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, ease }}
      >
        <span className="t-label">
          <span className="page-header__index">{index}</span>
          <span className="page-header__slash">/</span>
          {section}
        </span>
        <motion.span
          className="page-header__rule"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 1.4, ease, delay: 0.1 }}
        />
      </motion.div>
      <div className="page-header__main">
        <div className="page-header__titles">
          <h1 className="page-header__title" key={title}>
            <RevealWords text={title} delay={0.08} />
          </h1>
          {purpose && (
            <motion.p
              className="page-header__purpose"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, ease, delay: 0.35 }}
            >
              {purpose}
            </motion.p>
          )}
        </div>
        {actions && (
          <motion.div
            className="page-header__actions"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease, delay: 0.45 }}
          >
            {actions}
          </motion.div>
        )}
      </div>
      {children && <div className="page-header__extra">{children}</div>}
    </header>
  );
}
