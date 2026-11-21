// Draws the app icon (a bold lowercase "t" on a dark tile) and packs it into
// build/icon.icns. No dependencies: shapes are rasterised with supersampling,
// encoded as PNG with zlib, then handed to iconutil.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

const INK_TOP = [0x16, 0x15, 0x14];
const INK = [0x0b, 0x0b, 0x0c];
const ACCENT = [0xf0, 0x52, 0x1c];

// Everything below is in a 1024 canvas. The tile follows the macOS grid: 824 square, 100 margin.
const TILE = { x0: 100, y0: 100, x1: 924, y1: 924, r: 186 };

function roundedRectDist(x, y, { x0, y0, x1, y1, r }) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Bold geometric "t": a stem with a sheared top, a crossbar and a hooked foot.
const S = { x0: 416, x1: 576 };
const STEM_TOP_LEFT = 300, STEM_TOP_RIGHT = 226;
const BAR = { x0: 316, x1: 708, y0: 392, y1: 504 };
const HOOK = { cx: 650, cy: 616, ri: 650 - S.x1, ro: 650 - S.x0 };
const TAIL_END = 722;

// The glyph is drawn in its own coordinates and scaled into the middle of the tile.
const GLYPH_SCALE = 0.8, GLYPH_CX = 519, GLYPH_CY = 538;

function inGlyph(px, py) {
  const x = (px - 512) / GLYPH_SCALE + GLYPH_CX;
  const y = (py - 512) / GLYPH_SCALE + GLYPH_CY;
  if (x >= BAR.x0 && x <= BAR.x1 && y >= BAR.y0 && y <= BAR.y1) return true;
  if (x >= S.x0 && x <= S.x1 && y <= HOOK.cy) {
    const t = (x - S.x0) / (S.x1 - S.x0);
    return y >= STEM_TOP_LEFT + (STEM_TOP_RIGHT - STEM_TOP_LEFT) * t;
  }
  if (y > HOOK.cy && x <= HOOK.cx) {
    const d = Math.hypot(x - HOOK.cx, y - HOOK.cy);
    return d >= HOOK.ri && d <= HOOK.ro;
  }
  return x > HOOK.cx && x <= TAIL_END && y >= HOOK.cy + HOOK.ri && y <= HOOK.cy + HOOK.ro;
}

function render(size) {
  const k = 1024 / size;
  const ss = size <= 64 ? 8 : size <= 256 ? 6 : 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let tile = 0, glyph = 0, edge = 0, shade = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxi + (sx + 0.5) / ss) * k;
          const y = (py + (sy + 0.5) / ss) * k;
          const d = roundedRectDist(x, y, TILE);
          if (d > 0) continue;
          tile++;
          shade += (y - TILE.y0) / (TILE.y1 - TILE.y0);
          if (inGlyph(x, y)) glyph++;
          else if (d > -5) edge++;
        }
      }
      const n = ss * ss;
      const cx = (pxi + 0.5) * k, cy = (py + 0.5) * k;
      // Soft drop shadow under the tile, so it sits on light and dark docks alike.
      const sd = roundedRectDist(cx, cy - 14, TILE);
      const shadowA = 0.3 * Math.min(1, Math.max(0, 1 - (sd + 6) / 34));

      const a = tile / n;
      let r = 0, g = 0, b = 0;
      if (tile) {
        const t = shade / tile;
        const ink = INK_TOP.map((c, i) => c + (INK[i] - c) * t);
        const plain = (tile - glyph - edge) / n, lit = edge / n, acc = glyph / n;
        const rim = ink.map((c) => c + (247 - c) * 0.06);
        r = ink[0] * plain + rim[0] * lit + ACCENT[0] * acc;
        g = ink[1] * plain + rim[1] * lit + ACCENT[1] * acc;
        b = ink[2] * plain + rim[2] * lit + ACCENT[2] * acc;
      }
      const under = shadowA * (1 - a);
      const alpha = a + under;
      const o = (py * size + pxi) * 4;
      if (alpha > 0) {
        px[o] = Math.round(r / alpha);
        px[o + 1] = Math.round(g / alpha);
        px[o + 2] = Math.round(b / alpha);
      }
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'tack-icon-'));
const iconset = join(work, 'icon.iconset');
mkdirSync(iconset);
const cache = new Map();
const at = (size) => {
  if (!cache.has(size)) cache.set(size, render(size));
  return cache.get(size);
};
for (const base of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${base}x${base}.png`), at(base));
  writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), at(base * 2));
}
writeFileSync(join(OUT, 'icon.png'), at(1024));
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT, 'icon.icns')]);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(OUT, 'icon.icns')} and icon.png`);
