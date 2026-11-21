import { motion } from 'motion/react';
import { useTrace } from '../../api/events';
import { ease } from '../../ui';

/** The newest trace line that arrived after `since` (ms epoch). */
export function useLatestSince(since: number) {
  const t = useTrace();
  if (!since) return undefined;
  const last = t.events[t.events.length - 1];
  return last && Date.parse(last.at) >= since - 50 ? last : undefined;
}

/** Five pips for a 1-5 score. Low scores use the accent. */
export function Pips({ score, size = 'md', animate = false, delay = 0 }: { score: number; size?: 'sm' | 'md'; animate?: boolean; delay?: number }) {
  const low = score <= 2;
  return (
    <span className={['pips', `pips--${size}`, low && 'is-low'].filter(Boolean).join(' ')} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) =>
        animate ? (
          <motion.i
            key={n}
            className={n <= score ? 'is-on' : undefined}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.5, ease, delay: delay + n * 0.06 }}
          />
        ) : (
          <i key={n} className={n <= score ? 'is-on' : undefined} />
        ),
      )}
    </span>
  );
}

/** Session scores over time, with a dashed line at 50. */
export function Trend({ values, labels }: { values: number[]; labels?: string[] }) {
  const W = 320;
  const H = 96;
  const pad = 12;
  // a padded window around the scores, always including 50 so the reference line shows
  const lo = Math.max(0, Math.min(50, ...values) - 15);
  const hi = Math.min(100, Math.max(50, ...values) + 12);
  const yOf = (v: number) => H - pad - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - pad * 2);
  const pts = values.map((v, i) => ({
    x: values.length === 1 ? W / 2 : 8 + (i * (W - 40)) / (values.length - 1),
    y: yOf(v),
    v,
  }));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const y50 = yOf(50);
  return (
    <div className="trend" role="img" aria-label={values.length ? `Session scores: ${values.join(', ')}` : 'No session scores yet'}>
      <motion.svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        initial={{ clipPath: 'inset(0 100% 0 0)' }}
        animate={{ clipPath: 'inset(0 0% 0 0)' }}
        transition={{ duration: 1.4, ease, delay: 0.3 }}
      >
        <line x1={0} x2={W} y1={y50} y2={y50} className="trend__mid" vectorEffect="non-scaling-stroke" />
        {pts.length > 1 && (
          <path d={d} className="trend__line" vectorEffect="non-scaling-stroke" />
        )}
      </motion.svg>
      <span className="trend__label trend__label--mid t-micro" style={{ top: `${(y50 / H) * 100}%` }}>
        50
      </span>
      {pts.map((p, i) => (
        <motion.span
          key={i}
          className={['trend__dot', i === pts.length - 1 && 'is-last'].filter(Boolean).join(' ')}
          style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
          title={`${labels?.[i] ?? ''} ${p.v}`.trim()}
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease, delay: 0.4 + i * 0.12 }}
        >
          {i === pts.length - 1 && <span className="trend__value t-num">{p.v}</span>}
        </motion.span>
      ))}
    </div>
  );
}

