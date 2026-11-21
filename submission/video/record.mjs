// Records the Tack demo against the real app: live job boards, the real model,
// a fresh state. Frames come from a CDP screencast; render.mjs cuts them into
// the final video.
//
//   PLAYWRIGHT=/abs/path/to/node_modules/playwright/index.mjs node submission/video/record.mjs [take]
//
// The coach runs on its own port with state in state/video, so the model and
// board caches survive between takes: record once to warm them, then again.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HERE = join(ROOT, 'submission/video');
const STATE = process.env.TACK_STATE_DIR || join(ROOT, 'state/video');
const TAKE = process.argv[2] || 'take';
const OUT = join(STATE, 'takes', TAKE);
const PORT = Number(process.env.TACK_VIDEO_PORT) || 4455;
const BASE = `http://127.0.0.1:${PORT}`;
const RESUME_PDF = join(HERE, 'avery-quinn-resume.pdf');
const SCALE = Number(process.env.TACK_VIDEO_DPR) || 1.5;
// Clean 1440x900 stills of the best moments, written when TACK_STILLS names a folder.
const STILLS = process.env.TACK_STILLS || '';

// Typed answers, one per kind of opening question; the take picks the one that fits.
const ANSWERS = [
  [/disagree|persuad|convinc|push ?back|align|conflict|stakeholder/i,
    'At Ledgerline, payouts were failing for 1.9% of merchants. I proposed smarter retries; ops disagreed and wanted ' +
    'merchants to re-confirm bank details instead. I pulled two weeks of failures in BigQuery and showed most were ' +
    'retries hitting stale details, then wrote a one-page comparison of both options. We agreed on one success ' +
    'measure: failed payouts under 0.5% with no rise in tickets. I shipped it behind a flag to 10% of merchants, ' +
    'and we reached 0.4% in six weeks.'],
  [/research|customer|user|insight|interview|feedback/i,
    'During the returns launch at Cartwheel I sat in on seller support calls for two weeks. Sellers said refunds were ' +
    'slow, but the real problem was that they could not see where a return was stuck. I tagged the calls, found three ' +
    'stuck states behind most complaints, and turned them into a prioritised fix list for the sprint, with a return ' +
    'status view first. I checked it with five sellers before we built it, and the workflow now serves 400 sellers.'],
  [/fail|mistake|wrong|miss|setback/i,
    'At Cartwheel I moved the catalogue sync from nightly batches to a Kafka pipeline. My first rollout replayed old ' +
    'events and briefly showed wrong stock to sellers. I rolled back within the hour, wrote up what happened, and ' +
    'added contract tests and a shadow run that compared both pipelines for a week before switching. The second ' +
    'rollout was clean, and stock mismatches fell by 70%. Since then I ship risky changes behind a comparison first.'],
];
const answerFor = (question) => (ANSWERS.find(([re]) => re.test(question)) ?? ANSWERS[0])[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// ------------------------------------------------------------ résumé PDF

async function makeResume(browser) {
  if (existsSync(RESUME_PDF)) return;
  const text = readFileSync(join(ROOT, 'coach/src/demo/resume.txt'), 'utf8').trim();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const [name, role, contact, ...rest] = text.split('\n');
  let body = '';
  let list = false;
  const dated = (l) => /^\w{3} \d{4} -/.test(l ?? '');
  rest.forEach((raw, i) => {
    const line = raw.trim();
    const close = () => { if (list) { body += '</ul>'; list = false; } };
    if (!line) return close();
    if (/^[A-Z ]+$/.test(line)) { close(); body += `<h2>${esc(line)}</h2>`; return; }
    if (line.startsWith('- ')) {
      if (!list) { body += '<ul>'; list = true; }
      body += `<li>${esc(line.slice(2))}</li>`;
      return;
    }
    close();
    const cls = dated(line) ? 'when' : dated(rest[i + 1]?.trim()) ? 'role' : 'text';
    body += `<p class="${cls}">${esc(line)}</p>`;
  });
  const html = `<!doctype html><meta charset="utf-8"><style>
    @page { size: A4; margin: 13mm 16mm; }
    body { font: 9.6pt/1.42 Helvetica, Arial, sans-serif; color: #1d1d1f; }
    h1 { font-size: 21pt; margin: 0; }
    .sub { font-size: 10.5pt; margin: 2px 0; color: #333; }
    .contact { font-size: 8.8pt; color: #666; margin: 0 0 8px; }
    h2 { font-size: 9pt; color: #555; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin: 12px 0 5px; }
    .text { margin: 0; }
    .role { margin: 7px 0 0; font-weight: 600; }
    .when { margin: 0 0 2px; color: #666; font-size: 8.8pt; }
    ul { margin: 2px 0 0; padding-left: 15px; }
    li { margin: 1px 0; }
  </style><h1>${esc(name)}</h1><p class="sub">${esc(role)}</p><p class="contact">${esc(contact)}</p>${body}`;
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: RESUME_PDF, format: 'A4', printBackground: true });
  await page.close();
  console.log(`wrote ${RESUME_PDF}`);
}

// ------------------------------------------------------------ coach

async function startCoach() {
  const env = { ...process.env, TACK_STATE_DIR: STATE, TACK_PORT: String(PORT) };
  const child = spawn(process.execPath, ['--no-warnings', join(ROOT, 'coach/bin/serve.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return { child, log };
    } catch { /* not up yet */ }
    await sleep(250);
  }
  child.kill();
  throw new Error(`coach did not start:\n${log.join('')}`);
}

const api = async (path, method = 'GET') => {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
  return res.json();
};

// ------------------------------------------------------------ recording helpers

const CURSOR = () => {
  const make = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2.5v16.2l4.6-4.3 3.1 6.7 2.9-1.3-3.1-6.6 6.3-.3z" fill="#f7f6f4" stroke="#0b0b0c" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(-100px, -100px)', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.45))',
    });
    const ring = document.createElement('div');
    ring.id = '__ring';
    Object.assign(ring.style, {
      position: 'fixed', left: '0', top: '0', width: '34px', height: '34px', marginLeft: '-17px', marginTop: '-17px',
      borderRadius: '50%', border: '2px solid rgba(240,82,28,.9)', zIndex: '2147483646', pointerEvents: 'none', opacity: '0',
    });
    document.documentElement.append(ring, c);
    addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ring.animate([{ opacity: 1, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(1.4)' }], { duration: 520, easing: 'ease-out' });
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
};

function recorder(page) {
  const marks = [];
  let mx = 720;
  let my = 450;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const mark = (type, extra = {}) => marks.push({ type, t: now(), ...extra });
  const still = async (name) => {
    if (!STILLS) return;
    mkdirSync(STILLS, { recursive: true });
    await page.screenshot({ path: join(STILLS, `${name}.png`), scale: 'css', style: '#__cursor, #__ring { display: none !important; }' }).catch((e) => console.log(`still ${name}: ${e.message}`));
  };
  const caption = (text) => mark('cap', { text });

  async function moveTo(x, y, ms) {
    const dist = Math.hypot(x - mx, y - my);
    const dur = ms ?? Math.min(800, 280 + dist * 0.5);
    const steps = Math.max(10, Math.round(dur / 16));
    const sx = mx;
    const sy = my;
    for (let i = 1; i <= steps; i++) {
      const e = ease(i / steps);
      await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
      await sleep(dur / steps);
    }
    mx = x;
    my = y;
  }

  async function scrollTo(target, block = 'center', wait = 1000) {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.evaluate((el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }), block);
    await sleep(wait * 0.8);
  }

  async function scrollBy(dy, wait = 1000, inside) {
    if (inside) await page.locator(inside).first().evaluate((el, d) => el.scrollBy({ top: d, behavior: 'smooth' }), dy);
    else await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy);
    await sleep(wait);
  }

  async function point(target, { scroll = true } = {}) {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 60_000 });
    if (scroll) {
      const box = await loc.boundingBox();
      const vh = page.viewportSize().height;
      if (!box || box.y < 70 || box.y + box.height > vh - 40) await scrollTo(loc, 'center', 850);
    }
    const b = await loc.boundingBox();
    await moveTo(b.x + b.width / 2, b.y + b.height / 2);
    return loc;
  }

  async function click(target, opts) {
    const loc = await point(target, opts);
    await sleep(100);
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
    await sleep(120);
    return loc;
  }

  // A wait the cut can speed up; `keep` is about how long it lasts on screen.
  async function wait(label, keep, work) {
    const t0 = now();
    try {
      return await work();
    } finally {
      marks.push({ type: 'wait', label, t0, t1: now(), keep });
    }
  }

  return { marks, mark, caption, still, moveTo, scrollTo, scrollBy, point, click, wait, pos: () => ({ x: mx, y: my }) };
}

// ------------------------------------------------------------ the storyboard

async function storyboard(page, r) {
  const { mark, caption, still, click, point, scrollTo, scrollBy, wait, moveTo } = r;
  const nav = (label) => click(page.locator('nav.rail a', { hasText: label }).first(), { scroll: false });
  const top = async (ms = 900) => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await sleep(ms);
  };
  // The rail opens itself for a long run and closes itself a while after; close it now instead.
  const closeTrace = async () => {
    for (let i = 0; i < 3; i++) {
      if (!(await page.locator('.trace.is-open').count())) return;
      await sleep(i ? 450 : 300);
      const b = await page.locator('.trace.is-open button[aria-label="Close trace"]').boundingBox({ timeout: 800 }).catch(() => null);
      if (!b) return;
      await moveTo(b.x + b.width / 2, b.y + b.height / 2, 450);
      await page.mouse.down();
      await sleep(50);
      await page.mouse.up();
      await sleep(450);
    }
  };

  // 1 Start
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.mouse.move(980, 620);
  mark('scene', { id: 1 });
  caption('Tack: a career pivot coach. Start with a résumé.');
  await sleep(2500);
  await scrollTo('.intake', 'center', 1100);
  caption('Upload the résumé PDF. Every skill Tack finds keeps the line that proves it.');
  const chooser = page.waitForEvent('filechooser');
  await click(page.locator('.intake .dropzone__hit').first());
  await (await chooser).setFiles(RESUME_PDF);
  await wait('resume', 2.5, () => page.getByRole('heading', { name: 'Profile' }).first().waitFor({ timeout: 180_000 }));
  await closeTrace();
  await sleep(500);
  await scrollTo(page.getByRole('heading', { name: 'Profile' }).first(), 'start', 1200);
  await moveTo(560, 640);
  await sleep(900);
  await scrollBy(320, 1300);
  await sleep(300);

  await closeTrace();
  caption('Set the target: AI Product Manager in Bengaluru, 10 hours a week for 12 weeks.');
  const role = page.getByLabel('Target role');
  await click(role);
  await role.fill('');
  await role.pressSequentially('AI Product Manager', { delay: 30 });
  const loc = page.getByLabel('Location');
  await click(loc);
  await loc.fill('');
  await loc.pressSequentially('Bengaluru', { delay: 35 });
  const more = page.getByRole('button', { name: 'Increase' }).first();
  await click(more, { scroll: false });
  await sleep(200);
  await click(more, { scroll: false });
  await scrollTo('.target .roles, .target', 'center', 1100);
  await wait('roles', 1.5, () => page.locator('.roles .role').first().waitFor({ timeout: 90_000 }));
  await sleep(1300);

  // 2 Read the market
  mark('scene', { id: 2 });
  caption('Read the market: open roles straight from 60 public company job boards.');
  await scrollTo(page.getByRole('heading', { name: 'Read the market' }).first(), 'start', 1100);
  await click(page.getByRole('button', { name: /^Read the market/ }).first());
  await sleep(1200);
  caption('The trace shows the agent at work: boards listed, 40 live postings read.');
  await wait('harvest', 7, () => page.getByText('Extracting skills').first().waitFor({ timeout: 300_000 }));
  caption('Then the model pulls out each skill with the exact line it came from.');
  await wait('extract', 3, () => page.waitForURL('**/gap', { timeout: 600_000 }));
  await sleep(900);

  // 3 Gap map
  mark('scene', { id: 3 });
  await closeTrace();
  await top(600);
  caption('The gap map: readiness weighted by how often each skill is asked for.');
  await sleep(2200);
  await scrollTo('.constellation', 'center', 1300);
  caption('Size is demand; fill is how much of it the résumé shows. Numbers are computed in code.');
  await moveTo(800, 520);
  await still('01-gap-map');
  await sleep(2000);
  await scrollTo(page.getByText('Top five to close').first(), 'start', 1100);
  caption('Open the top gap: the résumé against what real postings say, company by company.');
  await click(page.locator('.top5 .close-card').first());
  await sleep(1700);
  await moveTo(1180, 640);
  await scrollBy(340, 1700, '.drawer__body');
  await still('02-evidence-drawer');
  await sleep(700);
  await page.keyboard.press('Escape');
  await sleep(700);

  // 4 Market
  await closeTrace();
  mark('scene', { id: 4 });
  caption('The market: every posting Tack read, from real companies, with fit against the résumé.');
  await nav('Market');
  await sleep(1700);
  await scrollTo('.wall', 'start', 1200);
  await still('03-live-market');
  await sleep(400);
  await click(page.locator('button.win').first());
  await sleep(1300);
  caption('Each skill is highlighted on the exact line of the posting it came from.');
  const chip = page.locator('.pd__chips button').first();
  if (await chip.isVisible().catch(() => false)) await click(chip, { scroll: false });
  await sleep(2200);
  await page.keyboard.press('Escape');
  await sleep(700);

  // 5 Plan
  await closeTrace();
  mark('scene', { id: 5 });
  caption('The plan: 12 weeks inside 10 hours a week, biggest gaps first, a checkpoint every week.');
  await nav('Plan');
  await sleep(700);
  const build = page.getByRole('button', { name: 'Build my plan' }).first();
  if (await build.isVisible().catch(() => false)) {
    await click(build);
    await wait('plan', 2, () => page.locator('.week__tasks').first().waitFor({ timeout: 180_000 }));
    await closeTrace();
  }
  await sleep(300);
  await scrollTo('.plan-legend', 'start', 1100);
  await sleep(600);
  caption('Tick a task and pass the checkpoint: the week\'s skills are credited and readiness moves.');
  await click(page.locator('.task__tick').first());
  await sleep(600);
  await click(page.getByRole('button', { name: 'Passed' }).first());
  await sleep(2100);
  caption('Mark it not yet instead, then replan: a repair block goes in and the card says what moved and why.');
  await click(page.getByRole('button', { name: 'Not yet' }).first(), { scroll: false });
  await sleep(1200);
  await top(700);
  await click(page.getByRole('button', { name: /^Replan/ }).first());
  await sleep(700);
  await click(page.locator('.modal').getByRole('button', { name: /Replan/ }).last(), { scroll: false });
  await wait('replan', 1.5, () => page.locator('[aria-label="What moved and why"]').first().waitFor({ timeout: 60_000 }));
  await closeTrace();
  await scrollTo('[aria-label="What moved and why"]', 'center', 1100);
  await moveTo(900, 470);
  await sleep(2700);

  // 6 Portfolio
  await closeTrace();
  mark('scene', { id: 6 });
  caption('Portfolio projects matched to the open gaps, placed on the plan weeks.');
  await nav('Portfolio');
  await sleep(500);
  const suggest = page.getByRole('button', { name: 'Suggest projects' });
  if (await suggest.isVisible().catch(() => false)) {
    await click(suggest);
    await wait('portfolio', 2, () => page.getByText('Why it counts').first().waitFor({ timeout: 180_000 }));
    await closeTrace();
  }
  await sleep(400);
  await scrollTo(page.locator('.project__head').first(), 'start', 1200);
  await sleep(1600);
  caption('Each project is tied to lines from real postings that ask for those skills.');
  await scrollTo(page.getByText('Why it counts').first(), 'center', 1200);
  await sleep(2200);

  // 7 Interview
  await closeTrace();
  mark('scene', { id: 7 });
  caption('Mock interviews: questions drawn from the target postings and the open gaps.');
  await nav('Interview');
  await sleep(700);
  await click(page.getByRole('button', { name: /Start the session/ }));
  const box = page.locator('textarea').first();
  await wait('question', 2, () => box.waitFor({ timeout: 120_000 }));
  await closeTrace();
  await sleep(2000);
  const question = (await page.locator('.stage__q').first().textContent().catch(() => '')) || '';
  await click(box);
  await wait('typing', 3.5, () => box.pressSequentially(answerFor(question), { delay: 6 }));
  await sleep(400);
  await click(page.getByRole('button', { name: 'Score this answer' }));
  caption('Scored on a five-part rubric. Every score quotes the candidate\'s own words.');
  await wait('judge', 2.5, () => page.locator('.crits__list').first().waitFor({ timeout: 180_000 }));
  await closeTrace();
  await scrollTo('.fb', 'start', 1000);
  await sleep(1300);
  await scrollTo('.crits', 'start', 1100);
  await point(page.locator('.crits__list li').nth(1), { scroll: false }).catch(() => {});
  await still('04-interview-feedback');
  await sleep(2400);
  caption('Then a stronger answer built only from what was said, and the follow-up to expect.');
  await scrollTo(page.getByText(/stronger version/i).first(), 'start', 1200);
  await moveTo(900, 700);
  await sleep(3300);

  // 8 Tracker
  await closeTrace();
  mark('scene', { id: 8 });
  caption('The tracker learns which kinds of roles reply. A new profile has no history yet.');
  await nav('Tracker');
  await sleep(1300);
  await click(page.getByRole('button', { name: 'Load the demo person' }));
  await sleep(800);
  caption('So load the demo person: 24 sample applications, marked sample on screen.');
  await click(page.getByRole('button', { name: 'Load Avery Quinn' }), { scroll: false });
  await wait('demo', 1.5, () => page.getByText('What gets replies').first().waitFor({ timeout: 60_000 }));
  await sleep(700);
  await scrollTo(page.getByText('What gets replies').first(), 'start', 1100);
  caption('What gets replies: lessons written by code from reply rates per kind of role.');
  await moveTo(960, 520);
  await still('05-tracker-lessons');
  await sleep(3200);
  await scrollTo(page.getByRole('heading', { name: 'Apply next' }).first(), 'start', 1200);
  caption('Apply next ranks postings by fit and by how often that kind of role replies.');
  await sleep(1700);
  await click(page.getByRole('button', { name: 'Prepare application' }).first());
  caption('Prepare application: tailored bullets, each shown with the résumé line it comes from.');
  // the sheet sits over the trace rail, so the rail is left alone here
  await wait('kit', 2, () => page.locator('.kit__bullets').first().waitFor({ timeout: 180_000 }));
  await sleep(800);
  await scrollTo('.kit__bullets', 'start', 1200);
  await moveTo(1100, 560);
  await still('06-application-kit');
  await sleep(2800);
  await page.keyboard.press('Escape');
  await sleep(500);
  await closeTrace();

  // 9 Progress
  mark('scene', { id: 9 });
  caption('Progress and the daily brief: the three things worth doing today.');
  await nav('Progress');
  await sleep(3200);
  await scrollTo('.nums', 'start', 1200);
  caption('Readiness over time, hours against the plan, streak and interview scores.');
  await sleep(2800);
  mark('end');
}

// ------------------------------------------------------------ main

const { child, log } = await startCoach();
let browser;
try {
  browser = await chromium.launch();
  await makeResume(browser);
  await api('/reset', 'POST');
  const state = await api('/state');
  console.log(`coach on ${BASE}: engine ${state.engine.available ? 'on' : 'off'} (${state.engine.note}), model ${state.model.name}`);
  if (!state.engine.available || !state.model.configured) throw new Error('the video needs the engine on and a model key');

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'frames'), { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE, colorScheme: 'dark' });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = `f${String(frames.length).padStart(6, '0')}.jpg`;
    frames.push({ file, t: metadata.timestamp });
    writes.push(writeFile(join(OUT, 'frames', file), Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: Math.round(1440 * SCALE), maxHeight: Math.round(900 * SCALE), everyNthFrame: 1 });

  const r = recorder(page);
  const started = now();
  try {
    await storyboard(page, r);
  } finally {
    await sleep(600);
    await cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(writes);
    await page.screenshot({ path: join(OUT, 'last.png') }).catch(() => {});
    writeFileSync(join(OUT, 'take.json'), JSON.stringify({ started, scale: SCALE, frames, marks: r.marks }, null, 1));
    console.log(`${frames.length} frames over ${(now() - started).toFixed(1)} s in ${OUT}`);
  }
} finally {
  await browser?.close();
  child.kill();
  if (process.env.TACK_VIDEO_LOG) console.log(log.join(''));
}
