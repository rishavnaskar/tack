import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Button } from './Button';
import { Icon } from './icons';
import { ease } from './motion';
import './States.css';

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  /** Usually one or two Buttons. */
  action?: ReactNode;
  /** Mono label above the title, e.g. "Nothing here yet". */
  eyebrow?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ title, body, action, eyebrow = 'Nothing here yet', compact }: EmptyStateProps) {
  return (
    <motion.div
      className={['empty', compact && 'empty--compact'].filter(Boolean).join(' ')}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease }}
    >
      {!compact && <BlueprintMark />}
      <div className="empty__text">
        {eyebrow && <span className="t-label">{eyebrow}</span>}
        <h3 className="empty__title">{title}</h3>
        {body && <p className="empty__body">{body}</p>}
        {action && <div className="empty__actions">{action}</div>}
      </div>
    </motion.div>
  );
}

function BlueprintMark() {
  return (
    <svg className="empty__mark" viewBox="0 0 120 120" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <g key={i}>
          <line x1={i * 20} y1="0" x2={i * 20} y2="120" />
          <line x1="0" y1={i * 20} x2="120" y2={i * 20} />
        </g>
      ))}
      <rect x="20" y="40" width="40" height="40" className="empty__mark-box" />
      <circle cx="80" cy="40" r="4" className="empty__mark-dot" />
      <path d="M60 60 L80 40" className="empty__mark-box" />
    </svg>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  /** The error text; rendered in mono. */
  message?: ReactNode;
  onRetry?: () => void;
  action?: ReactNode;
  compact?: boolean;
}

export function ErrorState({ title = 'Something did not load', message, onRetry, action, compact }: ErrorStateProps) {
  return (
    <motion.div
      role="alert"
      className={['error-state', compact && 'error-state--compact'].filter(Boolean).join(' ')}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease }}
    >
      <span className="error-state__icon">
        <Icon name="warning" size={18} />
      </span>
      <div className="error-state__text">
        <h3 className="error-state__title">{title}</h3>
        {message && <p className="error-state__message t-mono">{message}</p>}
      </div>
      {(onRetry || action) && (
        <div className="error-state__actions">
          {action}
          {onRetry && (
            <Button variant="ghost" size="sm" iconLeft="refresh" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  /** Render this many text lines instead of one block. */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 14, radius = 6, lines, className, style }: SkeletonProps) {
  if (lines) {
    return (
      <span className={['skeleton-lines', className].filter(Boolean).join(' ')} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className="skeleton"
            style={{ width: i === lines - 1 && lines > 1 ? '62%' : '100%', height, borderRadius: radius }}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      className={['skeleton', className].filter(Boolean).join(' ')}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

export interface BlueprintLoaderProps {
  label?: ReactNode;
  /** Latest step from the trace, shown in mono under the label. */
  detail?: ReactNode;
  /** Ordered stage names; the current one is lit. */
  stages?: string[];
  stage?: number;
  height?: number;
}

const CELL = 26;

function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

export function BlueprintLoader({ label = 'Working', detail, stages, stage = 0, height = 260 }: BlueprintLoaderProps) {
  const [grid, box] = useBox<HTMLDivElement>();
  const cols = Math.max(1, Math.floor(box.w / CELL));
  const rows = Math.max(1, Math.floor(box.h / CELL));
  const ox = (box.w - cols * CELL) / 2;
  const oy = (box.h - rows * CELL) / 2;
  return (
    <div className="blueprint" role="status" aria-live="polite">
      <div className="blueprint__grid" style={{ height }} ref={grid}>
        {box.w > 0 && (
          <svg width={box.w} height={box.h} aria-hidden="true">
            {Array.from({ length: cols + 1 }, (_, i) => (
              <line key={`v${i}`} x1={ox + i * CELL} y1={0} x2={ox + i * CELL} y2={box.h} className={i % 4 === 0 ? 'major' : ''} />
            ))}
            {Array.from({ length: rows + 1 }, (_, i) => (
              <line key={`h${i}`} x1={0} y1={oy + i * CELL} x2={box.w} y2={oy + i * CELL} className={i % 4 === 0 ? 'major' : ''} />
            ))}
            {Array.from({ length: cols * rows }, (_, i) => {
              const x = i % cols;
              const y = Math.floor(i / cols);
              // deterministic scatter so the pattern reads as reading, not noise
              const lit = (x * 7 + y * 11) % 9 === 0 || (x * 3 + y * 5) % 17 === 0;
              if (!lit) return null;
              const hot = (x + y * 3) % 7 === 0;
              return (
                <rect
                  key={i}
                  x={ox + x * CELL + 4}
                  y={oy + y * CELL + 4}
                  width={CELL - 8}
                  height={CELL - 8}
                  rx={2}
                  className={hot ? 'blueprint__cell is-hot' : 'blueprint__cell'}
                  style={{ animationDelay: `${((x / Math.max(cols, 1)) * 3.2).toFixed(2)}s` }}
                />
              );
            })}
          </svg>
        )}
        <span className="blueprint__scan" />
        <span className="blueprint__corner blueprint__corner--tl" />
        <span className="blueprint__corner blueprint__corner--br" />
      </div>
      <div className="blueprint__caption">
        <span className="blueprint__label">
          <span className="pulse-dot" />
          {label}
        </span>
        {detail && <span className="blueprint__detail t-mono">{detail}</span>}
      </div>
      {stages && stages.length > 0 && (
        <ol className="blueprint__stages">
          {stages.map((s, i) => (
            <li key={s} className={i < stage ? 'is-done' : i === stage ? 'is-current' : ''}>
              <span className="t-num">{String(i + 1).padStart(2, '0')}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
