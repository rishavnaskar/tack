import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import type { GapSkill } from '../../api/types';
import { LevelGlyph, levelLabel, ease } from '../../ui';
import { pct } from '../../lib/format';
import { layoutConstellation } from './layout';

export interface ConstellationProps {
  skills: GapSkill[];
  /** skill id to 1-based rank, for the "top five to close" marks */
  ranks: Map<string, number>;
  selected?: string;
  onSelect: (id: string) => void;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Constellation({ skills, ranks, selected, onSelect }: ConstellationProps) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const cols = width && width < 700 ? 2 : 3;
  const layout = useMemo(() => layoutConstellation(skills, cols, cols === 3 ? 1000 : 640), [skills, cols]);
  const [hover, setHover] = useState<string>();
  const active = hover ?? selected;
  const activeNode = layout.nodes.find((n) => n.skill.id === hover);
  const activeCluster = layout.nodes.find((n) => n.skill.id === active)?.cluster;

  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div className="constellation" ref={wrap}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="constellation__svg"
        role="group"
        aria-label="Skills by category. Size is demand; fill is how much of it your résumé shows."
      >
        {layout.clusters.map((c, i) => (
          <motion.g
            key={c.name}
            className={['cl', activeCluster !== undefined && activeCluster !== i && 'is-dim'].filter(Boolean).join(' ')}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, ease, delay: 0.1 + i * 0.08 }}
          >
            <text x={c.x} y={c.y} className="cl__label">
              <tspan className="cl__index">{String(c.index).padStart(2, '0')}</tspan>
              <tspan dx="8">{c.name.toUpperCase()}</tspan>
              <tspan dx="8" className="cl__count">
                {c.count}
              </tspan>
            </text>
          </motion.g>
        ))}

        {layout.links.map(([a, b], i) => {
          const na = layout.nodes[a];
          const nb = layout.nodes[b];
          const lit = active && (na.skill.id === active || nb.skill.id === active);
          // stop short of both circles so lines never cross a node
          const dx = nb.x - na.x;
          const dy = nb.y - na.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          if (len < na.r + nb.r + 12) return null;
          return (
            <motion.line
              key={`${a}-${b}`}
              x1={na.x + ux * (na.r + 6)}
              y1={na.y + uy * (na.r + 6)}
              x2={nb.x - ux * (nb.r + 6)}
              y2={nb.y - uy * (nb.r + 6)}
              className={['link', lit && 'is-lit'].filter(Boolean).join(' ')}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 1.2, ease, delay: 0.4 + i * 0.03 }}
            />
          );
        })}

        {layout.nodes.map((n, i) => {
          const s = n.skill;
          const rank = ranks.get(s.id);
          const dim = active && activeCluster !== n.cluster;
          const isSel = selected === s.id;
          return (
            <g
              key={s.id}
              transform={`translate(${n.x} ${n.y})`}
              className={['node', `node--${s.level}`, dim && 'is-dim', isSel && 'is-selected', hover === s.id && 'is-hover'].filter(Boolean).join(' ')}
              tabIndex={0}
              role="button"
              aria-label={`${s.name}: ${levelLabel[s.level]}, asked for in ${pct(s.demand)} of postings${rank ? `, number ${rank} to close` : ''}`}
              onMouseEnter={() => setHover(s.id)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(s.id)}
              onBlur={() => setHover(undefined)}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => onKey(e, s.id)}
            >
              <motion.g
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.9, ease, delay: 0.25 + n.cluster * 0.08 + i * 0.012 }}
              >
                <circle r={n.r + 12} className="node__hit" />
                <circle r={n.r + 6} className="node__ring" />
                {s.level === 'strong' && <circle r={n.r} className="node__fill" />}
                {s.level === 'partial' && (
                  <>
                    <circle r={n.r - 0.75} className="node__outline" />
                    <path d={`M ${-n.r + 0.75} 0 A ${n.r - 0.75} ${n.r - 0.75} 0 0 0 ${n.r - 0.75} 0 Z`} className="node__half" />
                  </>
                )}
                {s.level === 'missing' && <circle r={n.r - 0.75} className="node__miss" />}
                {rank && (
                  <g transform={`translate(${n.r * 0.78 + 4} ${-n.r * 0.78 - 4})`} className="node__rank">
                    <circle r={8.5} />
                    <text dy="3.4">{rank}</text>
                  </g>
                )}
                <text className="node__label" y={n.r + 8 + 11}>
                  {n.lines.map((l, k) => (
                    <tspan key={k} x={0} dy={k === 0 ? 0 : 14}>
                      {l}
                    </tspan>
                  ))}
                </text>
              </motion.g>
            </g>
          );
        })}
      </svg>

      {activeNode && (
        <div
          className="constellation__tip"
          style={{
            left: `${(activeNode.x / layout.width) * 100}%`,
            top: `${((activeNode.y - activeNode.r) / layout.height) * 100}%`,
          }}
          role="tooltip"
        >
          <span className="tip__name">
            <LevelGlyph level={activeNode.skill.level} size={10} />
            {activeNode.skill.name}
          </span>
          <span className="tip__line t-mono">
            {pct(activeNode.skill.demand)} of postings <span className="t-faint">·</span> must in {pct(activeNode.skill.mustShare)}
          </span>
          <span className="tip__line t-mono">
            have {activeNode.skill.have} <span className="t-faint">/</span> need {activeNode.skill.need}
            <span className="t-faint"> · </span>priority {activeNode.skill.priority}
          </span>
          <span className="tip__hint t-micro">Click for evidence</span>
        </div>
      )}
    </div>
  );
}
