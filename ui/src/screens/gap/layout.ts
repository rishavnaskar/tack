import type { GapSkill } from '../../api/types';

/*
 * Deterministic constellation layout. Categories sit in a grid of cells; inside a cell
 * each skill, largest demand first, takes the first free spot on a spiral where neither
 * its circle nor its label touches another. Same input, same picture.
 */

export const CATEGORY_ORDER = [
  'product', 'ai', 'data', 'technical', 'collaboration', 'business',
  'Product craft', 'AI and ML', 'Data and metrics', 'Engineering depth', 'Leadership', 'Go to market',
];

/** Most a cell holds before labels collide, and most the whole map draws; the rest stay in the list view. */
export const PER_CATEGORY = 9;
export const MAX_NODES = 30;

/** The skills the map draws: ranked ones always, then by demand, within both caps. */
export function visibleSkills(skills: GapSkill[], keep: Set<string> = new Set()): GapSkill[] {
  const order = [...skills].sort((a, b) => Number(keep.has(b.id)) - Number(keep.has(a.id)) || b.demand - a.demand || a.id.localeCompare(b.id));
  const perCat = new Map<string, number>();
  const out: GapSkill[] = [];
  for (const s of order) {
    if (out.length >= MAX_NODES) break;
    const n = perCat.get(s.category) ?? 0;
    if (n >= PER_CATEGORY && !keep.has(s.id)) continue;
    perCat.set(s.category, n + 1);
    out.push(s);
  }
  return out;
}

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
const PAD = 18;

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

type Placed = { skill: GapSkill; x: number; y: number; r: number; lines: string[]; w: number; h: number };

// box centre is below the circle centre because the label hangs under it
const boxCy = (n: Placed) => n.y - n.r + n.h / 2;

function clash(a: Placed, b: Placed, pad: number) {
  return (a.w + b.w) / 2 + pad - Math.abs(b.x - a.x) > 0 && (a.h + b.h) / 2 + pad - Math.abs(boxCy(b) - boxCy(a)) > 0;
}

// Null when the cell is too small for every label to clear the others; the row then grows.
function placeCell(members: GapSkill[], ci: number, x0: number, y0: number, cellW: number, cellH: number): Placed[] | null {
  const [ox, oy] = OFFSETS[ci % OFFSETS.length];
  const cx = x0 + cellW / 2 + ox * cellW;
  const cy = y0 + cellH / 2 + 14 + oy * cellH;
  const minX = x0 + 14;
  const maxX = x0 + cellW - 14;
  const minY = y0 + 40;
  const maxY = y0 + cellH - 8;

  const placed: Placed[] = [];
  for (const skill of members) {
    const r = radiusFor(skill.demand);
    const lines = splitLabel(skill.name);
    const n: Placed = {
      skill, r, lines, x: cx, y: cy,
      w: Math.max(2 * r, Math.max(...lines.map((l) => l.length)) * CHAR_W),
      h: 2 * r + LABEL_GAP + lines.length * LINE_H,
    };
    let found = false;
    for (let k = 0; k < 2400 && !found; k++) {
      const a = k * 2.39996 + ci * 0.9;
      const d = 5 * Math.sqrt(k);
      n.x = cx + d * Math.cos(a);
      n.y = cy + d * Math.sin(a) * 0.8;
      if (n.x - n.w / 2 < minX || n.x + n.w / 2 > maxX || n.y - n.r < minY || n.y - n.r + n.h > maxY) continue;
      found = placed.every((p) => !clash(p, n, PAD));
    }
    if (!found) return null;
    placed.push(n);
  }
  return placed;
}

export function layoutConstellation(skills: GapSkill[], cols: number, width = 1000): Layout {
  const present = [...new Set(skills.map((s) => s.category))];
  const cats = [
    ...CATEGORY_ORDER.filter((c) => present.includes(c)),
    ...present.filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  ];
  const rows = Math.max(1, Math.ceil(cats.length / cols));
  const cellW = width / cols;
  const baseH = cellW * (cols >= 3 ? 0.92 : 0.9);
  const membersOf = (cat: string) => skills.filter((s) => s.category === cat).sort((a, b) => b.demand - a.demand || a.id.localeCompare(b.id));

  const nodes: LaidNode[] = [];
  const clusters: LaidCluster[] = [];
  const links: [number, number][] = [];
  let y0 = 0;

  for (let row = 0; row < rows; row++) {
    const rowCats = cats.slice(row * cols, row * cols + cols);
    const most = Math.max(0, ...rowCats.map((c) => membersOf(c).length));
    // A row with a crowded category gets taller instead of stacking labels, until nothing overlaps.
    let cellH = baseH * Math.max(1, Math.sqrt(most / 7));
    const tryRow = () => rowCats.map((cat, k) => placeCell(membersOf(cat), row * cols + k, k * cellW, y0, cellW, cellH));
    let placed = tryRow();
    for (let grow = 0; grow < 12 && placed.some((p) => !p); grow++) {
      cellH *= 1.1;
      placed = tryRow();
    }

    placed.forEach((cell, k) => {
      const local = cell ?? [];
      const ci = row * cols + k;
      const x0 = k * cellW;
      const base = nodes.length;
      local.forEach((n, i) => {
        nodes.push({ skill: n.skill, x: round(n.x), y: round(n.y), r: round(n.r), lines: n.lines, cluster: ci });
        if (i > 0) {
          let best = 0;
          let bd = Infinity;
          for (let q = 0; q < i; q++) {
            const d = (local[q].x - n.x) ** 2 + (local[q].y - n.y) ** 2;
            if (d < bd) {
              bd = d;
              best = q;
            }
          }
          links.push([base + best, base + i]);
        }
      });
      if (!local.length) return;
      const top = Math.min(...local.map((n) => n.y - n.r));
      const left = Math.min(...local.map((n) => n.x - n.w / 2));
      clusters.push({
        name: rowCats[k],
        index: ci + 1,
        count: local.length,
        x: round(Math.max(x0 + 14, left)),
        y: round(Math.max(y0 + 22, top - 18)),
      });
    });
    y0 += cellH;
  }

  return { width, height: Math.round(y0), nodes, clusters, links };
}

const round = (v: number) => Math.round(v * 10) / 10;
