import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ease } from '../../ui';

/* Hand-drawn SVG charts: hairline grid, mono axis labels, the accent only on the current value. */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const DAY = 86_400_000;
const fmtDay = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

interface Tip {
  x: number;
  y: number;
  title: ReactNode;
  value: ReactNode;
}

function Tooltip({ tip }: { tip?: Tip }) {
  if (!tip) return null;
  return (
    <div className="chart__tip" style={{ left: tip.x, top: tip.y }}>
      <span className="t-micro">{tip.title}</span>
      <span className="chart__tip-value t-num">{tip.value}</span>
    </div>
  );
}

function niceStep(range: number) {
  return range <= 30 ? 5 : range <= 60 ? 10 : 20;
}

/* readiness over time */

export interface ReadinessChartProps {
  points: { at: string; value: number }[];
  target: number;
  height?: number;
}

export function ReadinessChart({ points, target, height = 248 }: ReadinessChartProps) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const pts = points.map((p) => ({ t: Date.parse(p.at), v: p.value })).filter((p) => !Number.isNaN(p.t));
  const narrow = W < 480;
  const m = { top: 18, right: narrow ? 64 : 84, bottom: 30, left: 34 };
  const pw = Math.max(10, W - m.left - m.right);
  const ph = height - m.top - m.bottom;

  if (!pts.length) {
    return (
      <div className="chart chart--empty" ref={ref} style={{ height }}>
        <p className="chart__none">Readiness is recorded each time the gap map changes. Build the gap map to start the line.</p>
      </div>
    );
  }

  const now = Date.now();
  const t0 = pts[0].t;
  const last = pts[pts.length - 1];
  const t1 = Math.max(last.t, now, t0 + DAY);
  const vals = pts.map((p) => p.v);
  const lo = Math.max(0, Math.floor((Math.min(...vals, target) - 10) / 10) * 10);
  const hi = 100;
  const x = (t: number) => m.left + ((t - t0) / (t1 - t0)) * pw;
  const y = (v: number) => m.top + (1 - (v - lo) / (hi - lo)) * ph;
  const step = niceStep(hi - lo);
  const ticks: number[] = [];
  for (let v = hi; v >= lo; v -= step) ticks.push(v);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(last.t).toFixed(1)},${y(lo)} L${x(t0).toFixed(1)},${y(lo)} Z`;
  const tail = now - last.t > DAY / 2 ? `M${x(last.t)},${y(last.v)} L${x(t1)},${y(last.v)}` : '';
  const endX = x(tail ? t1 : last.t);

  // x labels: start, end, and the points between when there is room
  const labels: number[] = [t0];
  const minGap = narrow ? 64 : 76;
  for (const p of pts.slice(1, -1)) if (x(p.t) - x(labels[labels.length - 1]) > minGap && x(t1) - x(p.t) > minGap) labels.push(p.t);
  if (t1 !== t0) labels.push(t1);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    let best = 0;
    pts.forEach((p, i) => {
      if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best].t) - px)) best = i;
    });
    setHover(best);
  };
  const hp = hover !== undefined ? pts[hover] : undefined;

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {W > 0 && (
        <svg width={W} height={height} role="img" aria-label={`Readiness from ${pts[0].v} to ${last.v}; target ${target}`}>
          <defs>
            <linearGradient id="ready-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f7f6f4" stopOpacity="0.09" />
              <stop offset="1" stopColor="#f7f6f4" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line className="chart__grid" x1={m.left} x2={m.left + pw} y1={y(v)} y2={y(v)} />
              <text className="chart__axis" x={m.left - 10} y={y(v)} dy="0.32em" textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {labels.map((t, i) => (
            <text
              key={`${t}-${i}`}
              className="chart__axis"
              x={x(t)}
              y={height - 8}
              textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
            >
              {i === labels.length - 1 && t1 >= now - DAY / 2 ? 'Today' : fmtDay(t)}
            </text>
          ))}

          <line className="chart__target" x1={m.left} x2={m.left + pw} y1={y(target)} y2={y(target)} />
          <text className="chart__axis chart__axis--hi" x={m.left + pw + 10} y={y(target)} dy="0.32em">
            Target {target}
          </text>

          <motion.path d={area} fill="url(#ready-fill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, ease, delay: 0.4 }} />
          <motion.path className="chart__line" d={line} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease }} />
          {tail && <path className="chart__tail" d={tail} />}

          {pts.slice(0, -1).map((p, i) => (
            <circle key={i} className="chart__pt" cx={x(p.t)} cy={y(p.v)} r={hover === i ? 4 : 2.75} />
          ))}
          <motion.circle
            className="chart__now"
            cx={endX}
            cy={y(last.v)}
            r={4.5}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.6, ease, delay: 1.1 }}
          />
          <text className="chart__now-label t-num" x={endX + 10} y={y(last.v)} dy="0.32em">
            {last.v}
          </text>
          {pts.length > 1 && (
            <text className="chart__axis" x={x(t0) + 4} y={y(pts[0].v) + (pts[1].v >= pts[0].v ? 16 : -10)} textAnchor="start">
              Start {pts[0].v}
            </text>
          )}

          {hp && <line className="chart__cross" x1={x(hp.t)} x2={x(hp.t)} y1={m.top} y2={m.top + ph} />}
          <rect
            x={m.left}
            y={m.top}
            width={pw}
            height={ph}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(undefined)}
          />
        </svg>
      )}
      <Tooltip tip={hp ? { x: x(hp.t), y: y(hp.v) - 12, title: fmtDay(hp.t), value: `Readiness ${hp.v}` } : undefined} />
    </div>
  );
}

/* hours done vs planned by week */

export interface WeekHours {
  index: number;
  planned: number;
  done: number;
}

/** A bar with rounded top corners, anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 3) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function HoursChart({ weeks, budget, current, height = 220 }: { weeks: WeekHours[]; budget: number; current?: number; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const m = { top: 16, right: 12, bottom: 28, left: 34 };
  const pw = Math.max(10, W - m.left - m.right);
  const ph = height - m.top - m.bottom;
  const maxV = Math.max(budget, ...weeks.map((w) => Math.max(w.planned, w.done)), 1);
  const top = Math.ceil((maxV * 1.12) / 2) * 2;
  const y = (v: number) => m.top + (1 - v / top) * ph;
  const band = pw / Math.max(1, weeks.length);
  const bw = Math.max(6, Math.min(18, band * 0.44));
  const bx = (i: number) => m.left + i * band + (band - bw) / 2;
  const ticks = [0, Math.round(top / 2), top];
  const hw = hover !== undefined ? weeks[hover] : undefined;
  const thin = band < 26;

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {W > 0 && (
        <svg width={W} height={height} role="img" aria-label="Hours done and planned for each week">
          {ticks.map((v) => (
            <g key={v}>
              <line className="chart__grid" x1={m.left} x2={m.left + pw} y1={y(v)} y2={y(v)} />
              <text className="chart__axis" x={m.left - 10} y={y(v)} dy="0.32em" textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {weeks.map((w, i) => {
            const isNow = w.index === current;
            return (
              <g key={w.index} className={['chart__week', hover === i && 'is-hover'].filter(Boolean).join(' ')}>
                <path className="chart__planned" d={barPath(bx(i), y(w.planned), bw, y(0) - y(w.planned))} />
                <motion.path
                  className={isNow ? 'chart__done is-now' : 'chart__done'}
                  d={barPath(bx(i), y(w.done), bw, y(0) - y(w.done))}
                  initial={{ opacity: 0, scaleY: 0 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  style={{ transformOrigin: 'center bottom', transformBox: 'fill-box' }}
                  transition={{ duration: 0.9, ease, delay: 0.2 + i * 0.04 }}
                />
                {(!thin || i % 2 === 0 || isNow) && (
                  <text className={['chart__axis', isNow && 'chart__axis--now'].filter(Boolean).join(' ')} x={bx(i) + bw / 2} y={height - 8} textAnchor="middle">
                    {thin ? w.index : `W${w.index}`}
                  </text>
                )}
                <rect
                  x={m.left + i * band}
                  y={m.top}
                  width={band}
                  height={ph}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(undefined)}
                />
              </g>
            );
          })}
          <line className="chart__target" x1={m.left} x2={m.left + pw} y1={y(budget)} y2={y(budget)} />
        </svg>
      )}
      <Tooltip
        tip={
          hw && hover !== undefined
            ? {
                x: bx(hover) + bw / 2,
                y: y(Math.max(hw.planned, hw.done)) - 10,
                title: `Week ${hw.index}${hw.index === current ? ', this week' : ''}`,
                value: `${hw.done} of ${hw.planned} h`,
              }
            : undefined
        }
      />
    </div>
  );
}

/* interview average per session */

export function ScoreChart({ points, floor = 50, height = 150 }: { points: { at: string; value: number }[]; floor?: number; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const m = { top: 14, right: 26, bottom: 24, left: 28 };
  const pw = Math.max(10, W - m.left - m.right);
  const ph = height - m.top - m.bottom;
  const y = (v: number) => m.top + (1 - v / 100) * ph;
  const n = points.length;
  const x = (i: number) => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const hp = hover !== undefined ? points[hover] : undefined;

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {W > 0 && (
        <svg width={W} height={height} role="img" aria-label={`Interview averages: ${points.map((p) => p.value).join(', ')}`}>
          {[0, 50, 100].map((v) => (
            <text key={v} className="chart__axis" x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {v}
            </text>
          ))}
          <line className="chart__grid" x1={m.left} x2={m.left + pw} y1={y(0)} y2={y(0)} />
          <line className="chart__grid" x1={m.left} x2={m.left + pw} y1={y(100)} y2={y(100)} />
          <line className="chart__target" x1={m.left} x2={m.left + pw} y1={y(floor)} y2={y(floor)} />
          {n > 1 && <motion.path className="chart__line" d={line} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease }} />}
          {points.map((p, i) =>
            i === n - 1 ? (
              <circle key={i} className="chart__now" cx={x(i)} cy={y(p.value)} r={4.5} />
            ) : (
              <circle key={i} className="chart__pt" cx={x(i)} cy={y(p.value)} r={hover === i ? 4 : 2.75} />
            ),
          )}
          {points.map((_, i) => (
            <text key={`l${i}`} className="chart__axis" x={x(i)} y={height - 6} textAnchor="middle">
              {n > 6 && i % 2 && i !== n - 1 ? '' : `S${i + 1}`}
            </text>
          ))}
          {points.map((_, i) => (
            <rect
              key={`h${i}`}
              x={x(i) - Math.max(10, pw / Math.max(1, n) / 2)}
              y={m.top}
              width={Math.max(20, pw / Math.max(1, n))}
              height={ph}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(undefined)}
            />
          ))}
        </svg>
      )}
      <Tooltip tip={hp && hover !== undefined ? { x: x(hover), y: y(hp.value) - 12, title: `Session ${hover + 1}, ${fmtDay(Date.parse(hp.at))}`, value: `Average ${hp.value}` } : undefined} />
    </div>
  );
}

/** The streak as a row of days ending today. */
export function StreakTicks({ days, span = 14 }: { days: number; span?: number }) {
  const lit = Math.min(days, span);
  return (
    <span className="streak" role="img" aria-label={`${days} day streak`}>
      {Array.from({ length: span }, (_, i) => {
        const on = i >= span - lit;
        return <span key={i} className={['streak__day', on && 'is-on', on && i === span - 1 && 'is-today'].filter(Boolean).join(' ')} />;
      })}
    </span>
  );
}
