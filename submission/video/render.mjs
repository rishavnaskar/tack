// Cuts a take from record.mjs into the demo video: long waits sped up and
// labelled, a caption bar under the app (with a small note for live model
// calls and sample data), a title card and a closing card.
//
//   PLAYWRIGHT=/abs/path/to/node_modules/playwright/index.mjs node submission/video/render.mjs [take]
//
// Needs ffmpeg on PATH. Writes submission/video/tack-demo.mp4 (1920x1080, H.264, 30 fps).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = join(ROOT, 'submission/video');
const STATE = process.env.TACK_STATE_DIR || join(ROOT, 'state/video');
const TAKE = process.argv[2] || 'take';
const DIR = join(STATE, 'takes', TAKE);
const WORK = join(DIR, 'render');
const OUT = process.env.TACK_VIDEO_OUT || join(HERE, 'tack-demo.mp4');
const FPS = 30;
const W = 1920;
const H = 1080;
const APP_H = 972;
const APP_W = 1556;
const APP_X = (W - APP_W) / 2;
const TITLE_S = 3;
const CLOSING_S = 6;

const SCENES = {
  1: 'Start',
  2: 'Read the market',
  3: 'Gap map',
  4: 'Market',
  5: 'Plan',
  6: 'Interview',
  7: 'Tracker',
  8: 'Progress',
};

const take = JSON.parse(readFileSync(join(DIR, 'take.json'), 'utf8'));
const frames = take.frames;
const marks = take.marks;
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------ timeline

const first = marks.find((m) => m.type === 'scene');
const end = marks.find((m) => m.type === 'end');
const T0 = first.t;
const T1 = (end?.t ?? frames.at(-1).t) + 0.4;

// Waits longer than their `keep` play faster, so each lasts about `keep` seconds.
const fast = marks
  .filter((m) => m.type === 'wait' && m.t1 - m.t0 > m.keep + 0.6)
  .map((m) => ({ a: m.t0, b: m.t1, speed: (m.t1 - m.t0) / m.keep, label: m.label }));

const pieces = [];
let cursor = T0;
for (const f of fast) {
  if (f.b <= T0 || f.a >= T1) continue;
  if (f.a > cursor) pieces.push({ a: cursor, b: f.a, speed: 1 });
  pieces.push({ a: Math.max(f.a, cursor), b: Math.min(f.b, T1), speed: f.speed });
  cursor = Math.min(f.b, T1);
}
if (cursor < T1) pieces.push({ a: cursor, b: T1, speed: 1 });

const out = [];
for (const p of pieces) {
  const n = Math.max(1, Math.round(((p.b - p.a) / p.speed) * FPS));
  for (let k = 0; k < n; k++) out.push({ src: p.a + (k * p.speed) / FPS, speed: p.speed });
}

const frameAt = (t) => {
  let lo = 0;
  let hi = frames.length - 1;
  if (t <= frames[0].t) return frames[0].file;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo].file;
};
const lastBefore = (type, t) => marks.filter((m) => m.type === type && m.t <= t).at(-1);

for (const o of out) {
  o.file = frameAt(o.src);
  o.scene = lastBefore('scene', o.src)?.id ?? 1;
  o.caption = lastBefore('cap', o.src)?.text ?? '';
  o.tag = lastBefore('tag', o.src)?.text ?? '';
  o.sped =o.speed > 1.05 ? (o.speed < 3 ? o.speed.toFixed(1) : String(Math.round(o.speed))) : 0;
}

// ------------------------------------------------------------ caption bars and cards

const fontDir = join(ROOT, 'ui/node_modules');
const fonts = `
  @font-face { font-family: 'Host Grotesk'; src: url('${pathToFileURL(join(fontDir, '@fontsource-variable/host-grotesk/files/host-grotesk-latin-wght-normal.woff2'))}') format('woff2'); font-weight: 300 800; }
  @font-face { font-family: 'JetBrains Mono'; src: url('${pathToFileURL(join(fontDir, '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'))}') format('woff2'); font-weight: 400; }
  @font-face { font-family: 'JetBrains Mono'; src: url('${pathToFileURL(join(fontDir, '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2'))}') format('woff2'); font-weight: 500; }
  * { margin: 0; box-sizing: border-box; }
  html, body { background: #0b0b0c; color: #f7f6f4; -webkit-font-smoothing: antialiased; }
  .mono { font-family: 'JetBrains Mono', monospace; text-transform: uppercase; letter-spacing: 0.09em; }
  .accent { color: #f0521c; }
`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const captionHtml = (scene, text, sped, tag) => `<!doctype html><meta charset="utf-8"><style>${fonts}
  body { width: ${W}px; height: ${H - APP_H}px; position: relative; overflow: hidden; }
  .bar { position: absolute; left: ${APP_X}px; right: ${APP_X}px; top: 0; bottom: 0; border-top: 1px solid rgba(247,246,244,.12);
         display: flex; flex-direction: column; justify-content: center; gap: 9px; }
  .top { display: flex; align-items: center; gap: 14px; font-size: 13px; color: rgba(247,246,244,.5); }
  .tag { margin-left: 10px; display: inline-flex; align-items: center; gap: 8px; color: rgba(247,246,244,.82); }
  .tag::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #f0521c; box-shadow: 0 0 0 3px rgba(240,82,28,.22); }
  .text { font-family: 'Host Grotesk', sans-serif; font-size: 27px; line-height: 1.2; letter-spacing: -0.012em; font-weight: 430;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: ${sped ? 190 : 0}px; }
  .sped { position: absolute; right: 0; bottom: 26px; font-size: 13px; color: #ff7a3d; border: 1px solid rgba(240,82,28,.6);
          border-radius: 999px; padding: 6px 12px; }
</style><div class="bar">
  <div class="top mono"><span class="accent">${String(scene).padStart(2, '0')}</span><span>/</span><span>${esc(SCENES[scene] ?? '')}</span>${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</div>
  <div class="text">${esc(text)}</div>
  ${sped ? `<div class="sped mono">Sped up ${sped}x</div>` : ''}
</div>`;

const wordmark = (size) => `<span class="mark" style="font-size:${size}px">Tack<span class="dot"></span></span>`;
const cardStyle = `
  body { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; font-family: 'Host Grotesk', sans-serif; }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(247,246,244,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(247,246,244,.035) 1px, transparent 1px); background-size: 48px 48px; }
  .glow { position: absolute; width: 1100px; height: 1100px; right: -380px; top: -420px; background: radial-gradient(closest-side, rgba(240,82,28,.10), transparent); }
  .mark { font-weight: 640; letter-spacing: -0.065em; line-height: 0.8; display: inline-flex; align-items: flex-end; }
  .dot { display: inline-block; width: 0.16em; height: 0.16em; border-radius: 50%; background: #f0521c; margin-left: 0.04em; margin-bottom: 0.02em; }
  .wrap { position: absolute; left: 182px; right: 182px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
  .label { font-size: 15px; color: rgba(247,246,244,.5); display: flex; align-items: center; gap: 16px; }
  .rule { flex: 1; height: 1px; background: rgba(247,246,244,.14); }
`;

const recordedOn = new Date(take.started * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const titleHtml = `<!doctype html><meta charset="utf-8"><style>${fonts}${cardStyle}
  .promise { font-size: 54px; line-height: 1.12; letter-spacing: -0.025em; font-weight: 420; max-width: 1220px; margin-top: 64px; }
</style><div class="grid"></div><div class="glow"></div><div class="wrap">
  <div class="label mono" style="margin-bottom:72px"><span class="accent">00</span><span>/</span><span>Demo</span><span class="rule"></span><span>Recorded live, ${recordedOn}</span></div>
  ${wordmark(250)}
  <p class="promise">The career pivot coach that reads the market, plans the move, and learns from who replies.</p>
</div>`;

const closingHtml = `<!doctype html><meta charset="utf-8"><style>${fonts}${cardStyle}
  ol { list-style: none; padding: 0; margin-top: 56px; display: grid; gap: 0; max-width: 1280px; }
  li { display: grid; grid-template-columns: 90px 1fr; align-items: baseline; padding: 19px 0; border-top: 1px solid rgba(247,246,244,.12); font-size: 38px; letter-spacing: -0.02em; font-weight: 430; }
  li:last-child { border-bottom: 1px solid rgba(247,246,244,.12); }
  li .mono { font-size: 16px; }
</style><div class="grid"></div><div class="glow"></div><div class="wrap">
  ${wordmark(130)}
  <ol>
    <li><span class="mono accent">01</span><span>Live postings from 60 real company boards</span></li>
    <li><span class="mono accent">02</span><span>Every claim quoted from its source</span></li>
    <li><span class="mono accent">03</span><span>Numbers computed in code</span></li>
    <li><span class="mono accent">04</span><span>Applies in parallel through a real browser</span></li>
    <li><span class="mono accent">05</span><span>Reads replies and relearns</span></li>
    <li><span class="mono accent">06</span><span>Desktop app and MCP server</span></li>
  </ol>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
async function png(html, file, height = H) {
  const src = join(WORK, `${file}.html`);
  writeFileSync(src, html);
  await page.setViewportSize({ width: W, height });
  await page.goto(pathToFileURL(src).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(WORK, `${file}.png`) });
  return join(WORK, `${file}.png`);
}

const runs = [];
for (const o of out) {
  const key = `${o.scene}|${o.caption}|${o.sped}|${o.tag}`;
  const last = runs.at(-1);
  if (last && last.key === key) last.n++;
  else runs.push({ key, scene: o.scene, caption: o.caption, sped: o.sped, tag: o.tag, n: 1 });
}
const capFiles = new Map();
for (const r of runs) {
  if (!capFiles.has(r.key)) capFiles.set(r.key, await png(captionHtml(r.scene, r.caption, r.sped, r.tag), `cap-${capFiles.size}`, H - APP_H));
  r.file = capFiles.get(r.key);
}
const titlePng = await png(titleHtml, 'title');
const closingPng = await png(closingHtml, 'closing');
await browser.close();

// ------------------------------------------------------------ ffmpeg

const q = (p) => `file '${p.replace(/'/g, "'\\''")}'`;
const frameList = [];
for (const o of out) frameList.push(q(join(DIR, 'frames', o.file)), `duration ${(1 / FPS).toFixed(6)}`);
frameList.push(q(join(DIR, 'frames', out.at(-1).file)));
writeFileSync(join(WORK, 'frames.txt'), frameList.join('\n'));
const capList = [];
for (const r of runs) capList.push(q(r.file), `duration ${(r.n / FPS).toFixed(6)}`);
capList.push(q(runs.at(-1).file));
writeFileSync(join(WORK, 'caps.txt'), capList.join('\n'));

const mainS = out.length / FPS;
const fadeOut = (d) => `fade=t=out:st=${(d - 0.45).toFixed(2)}:d=0.45`;
const filter = [
  `[0:v]fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.5,${fadeOut(TITLE_S)},setsar=1[t]`,
  `[1:v]fps=${FPS},scale=${APP_W}:${APP_H}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,pad=${W}:${H}:${APP_X}:0:color=0x0b0b0c,setsar=1[app]`,
  `[2:v]fps=${FPS},setsar=1[cap]`,
  `[app][cap]overlay=0:${APP_H}:eof_action=repeat:shortest=1,format=yuv420p,fade=t=in:st=0:d=0.35,${fadeOut(mainS)}[m]`,
  `[3:v]fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${CLOSING_S - 0.8}:d=0.8,setsar=1[c]`,
  '[t][m][c]concat=n=3:v=1:a=0,format=yuv420p[v]',
].join(';');

const args = [
  '-y', '-loglevel', 'error', '-stats',
  '-loop', '1', '-framerate', String(FPS), '-t', String(TITLE_S), '-i', titlePng,
  '-f', 'concat', '-safe', '0', '-i', join(WORK, 'frames.txt'),
  '-f', 'concat', '-safe', '0', '-i', join(WORK, 'caps.txt'),
  '-loop', '1', '-framerate', String(FPS), '-t', String(CLOSING_S), '-i', closingPng,
  '-filter_complex', filter, '-map', '[v]',
  '-c:v', 'libx264', '-preset', process.env.TACK_VIDEO_PRESET || 'slow', '-crf', process.env.TACK_VIDEO_CRF || '20', '-pix_fmt', 'yuv420p',
  '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  '-r', String(FPS), '-movflags', '+faststart', OUT,
];
execFileSync('ffmpeg', args, { stdio: 'inherit' });

const total = TITLE_S + mainS + CLOSING_S;
const mb = statSync(OUT).size / 1e6;
const sped = fast.map((f) => `${f.label} ${(f.b - f.a).toFixed(1)}s at ${f.speed.toFixed(1)}x`).join(', ');
console.log(`${OUT}: ${total.toFixed(1)} s, ${mb.toFixed(1)} MB, ${runs.length} caption runs; sped up: ${sped || 'nothing'}`);
