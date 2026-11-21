import type { GapSkill } from '../../api/types';

/*
 * Deterministic constellation layout. Categories sit in a grid of cells; inside a cell
 * skills start on a golden-angle spiral (largest demand in the middle) and a fixed number
 * of box-overlap passes push them apart, label included. Same input, same picture.
 */

export const CATEGORY_ORDER = ['Product craft', 'AI and ML', 'Data and metrics', 'Engineering depth', 'Leadership', 'Go to market'];

export interface LaidNode {
  skill: GapSkill;
  x: number;
  y: number;
  r: number;
  lines: string[];
  cluster: number;
}

export interface LaidCluster {
  name: string;
  index: number;
  count: number;
  x: number;
  y: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: LaidNode[];
  clusters: LaidCluster[];
  links: [number, number][];
}

const CHAR_W = 6.6;
const LINE_H = 14;
const LABEL_GAP = 8;
const PAD = 16;

function splitLabel(name: string): string[] {
  if (name.length <= 15 || !name.includes(' ')) return [name];
  const mid = name.length / 2;
  let best = -1;
  for (let i = 0; i < name.length; i++) {
    if (name[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return [name.slice(0, best), name.slice(best + 1)];
}

export function radiusFor(demand: number) {
  return 8 + 27 * Math.sqrt(Math.max(0, Math.min(1, demand)));
}

const OFFSETS: [number, number][] = [
  [-0.03, 0.02],
  [0.04, -0.03],
  [-0.02, 0.04],
  [0.03, 0.03],
  [-0.04, -0.02],
  [0.02, 0.04],
];

export function layoutConstellation(skills: GapSkill[], cols: number, width = 1000): Layout {
  const present = [...new Set(skills.map((s) => s.category))];
  const cats = [
    ...CATEGORY_ORDER.filter((c) => present.includes(c)),
    ...present.filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  ];
  const rows = Math.max(1, Math.ceil(cats.length / cols));
  const cellW = width / cols;
  const cellH = cellW * (cols >= 3 ? 0.92 : 0.9);
  const height = Math.round(rows * cellH);

  const nodes: LaidNode[] = [];
  const clusters: LaidCluster[] = [];
  const links: [number, number][] = [];

  cats.forEach((cat, ci) => {
    const col = ci % cols;
    const row = Math.floor(ci / cols);
    const x0 = col * cellW;
    const y0 = row * cellH;
    const [ox, oy] = OFFSETS[ci % OFFSETS.length];
    const cx = x0 + cellW / 2 + ox * cellW;
    const cy = y0 + cellH / 2 + 14 + oy * cellH;
    const members = skills.filter((s) => s.category === cat).sort((a, b) => b.demand - a.demand || a.id.localeCompare(b.id));

    const local = members.map((skill, i) => {
      const r = radiusFor(skill.demand);
      const a = i * 2.39996 + ci * 0.9;
      const d = i === 0 ? 0 : 54 * Math.sqrt(i);
      const lines = splitLabel(skill.name);
      return {
        skill,
        x: cx + d * Math.cos(a),
        y: cy + d * Math.sin(a) * 0.8,
        r,
        lines,
        w: Math.max(2 * r, Math.max(...lines.map((l) => l.length)) * CHAR_W),
        h: 2 * r + LABEL_GAP + lines.length * LINE_H,
      };
    });

    // box centre is below the circle centre because the label hangs under it
    const boxCy = (n: (typeof local)[number]) => n.y - n.r + n.h / 2;
    const minX = x0 + 14;
    const maxX = x0 + cellW - 14;
    const minY = y0 + 40;
    const maxY = y0 + cellH - 8;

    for (let iter = 0; iter < 260; iter++) {
      for (const n of local) {
        n.x += (cx - n.x) * 0.006;
        n.y += (cy - n.y) * 0.006;
      }
      for (let i = 0; i < local.length; i++) {
        for (let j = i + 1; j < local.length; j++) {
          const a = local[i];
          const b = local[j];
          const dx = b.x - a.x;
          const dy = boxCy(b) - boxCy(a);
          const ox = (a.w + b.w) / 2 + PAD - Math.abs(dx);
          const oy = (a.h + b.h) / 2 + PAD - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const s = (dx === 0 ? (i % 2 ? 1 : -1) : Math.sign(dx)) * ox * 0.5;
            a.x -= s;
            b.x += s;
          } else {
            const s = (dy === 0 ? (j % 2 ? 1 : -1) : Math.sign(dy)) * oy * 0.5;
            a.y -= s;
            b.y += s;
          }
        }
      }
      for (const n of local) {
        n.x = Math.max(minX + n.w / 2, Math.min(maxX - n.w / 2, n.x));
        n.y = Math.max(minY + n.r, Math.min(maxY - (n.h - n.r), n.y));
      }
    }

    const base = nodes.length;
    local.forEach((n, i) => {
      nodes.push({ skill: n.skill, x: round(n.x), y: round(n.y), r: round(n.r), lines: n.lines, cluster: ci });
      if (i > 0) {
        let best = 0;
        let bd = Infinity;
        for (let k = 0; k < i; k++) {
          const d = (local[k].x - n.x) ** 2 + (local[k].y - n.y) ** 2;
          if (d < bd) {
            bd = d;
            best = k;
          }
        }
        links.push([base + best, base + i]);
      }
    });

    const top = Math.min(...local.map((n) => n.y - n.r));
    const left = Math.min(...local.map((n) => n.x - n.w / 2));
    clusters.push({
      name: cat,
      index: ci + 1,
      count: members.length,
      x: round(Math.max(x0 + 14, left)),
      y: round(Math.max(y0 + 22, top - 18)),
    });
  });

  return { width, height, nodes, clusters, links };
}

const round = (v: number) => Math.round(v * 10) / 10;
