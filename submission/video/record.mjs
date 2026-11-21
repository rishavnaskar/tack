// Records the Tack demo against the real app: live job boards, live model calls, a
// fresh state, and Tack's own engine applying to the local practice form. The model
// cache is never read (TACK_LLM_CACHE=refresh), but every answer is kept, so a take
// cut short by the provider can be finished later with TACK_LLM_CACHE=on and those
// scenes captioned as replayed. Frames come from a CDP screencast; render.mjs cuts
// them into the final video.
//
//   PLAYWRIGHT=/abs/path/to/node_modules/playwright/index.mjs node submission/video/record.mjs [take]
//
// The coach runs on its own port with state in state/video. Exits with code 3
// when the parallel apply did not end with every run confirmed.

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
const CACHE_MODE = process.env.TACK_LLM_CACHE || 'refresh';
// A later take can carry on from a scene with the state the last one left (no reset).
const FROM = Number(process.env.TACK_VIDEO_FROM) || 1;
// With the cache read, answers come from the earlier live run: every caption bar says so.
const REPLAY = CACHE_MODE === 'on';

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
  // A full take starts the engine fresh too: it remembers what it sent before and will not send it twice.
  if (FROM === 1) {
    rmSync(join(STATE, 'engine'), { recursive: true, force: true });
    // and reads the job boards afresh rather than from the half-hour board cache
    rmSync(join(STATE, 'engine-cache'), { recursive: true, force: true });
  }
  const env = { ...process.env, TACK_STATE_DIR: STATE, TACK_PORT: String(PORT), TACK_LLM_CACHE: CACHE_MODE };
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
  // A replayed take never claims a call happened just now.
  const caption = (text) => mark('cap', { text: REPLAY ? text.replace(' reads it now;', ' read it;').replace('Judged live on', 'Judged on') : text });
  // A small note in the caption bar's top line, until the next tag ('' clears it).
  const tag = (text) => mark('tag', { text: REPLAY ? [/not cached/.test(text) ? '' : text, 'Answers replayed from an earlier live run'].filter(Boolean).join(' · ') : text });

  async function moveTo(x, y, ms) {
    const dist = Math.hypot(x - mx, y - my);
    const dur = ms ?? Math.min(600, 220 + dist * 0.4);
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
    await sleep(wait * 0.7);
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
    await sleep(80);
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.up();
    await sleep(90);
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

  return { marks, mark, caption, tag, still, moveTo, scrollTo, scrollBy, point, click, wait, pos: () => ({ x: mx, y: my }) };
}

// ------------------------------------------------------------ the storyboard

async function storyboard(page, r) {
  const { mark, caption, tag, still, click, point, scrollTo, scrollBy, wait, moveTo } = r;
  let result;
  if (REPLAY) tag('');
  if (FROM > 1) await page.goto(BASE, { waitUntil: 'networkidle' });
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
  // Leaves the rail up long enough to read the call that just finished and how long it took.
  const showCall = async (ms = 1600) => {
    if (await page.locator('.trace.is-open').count()) await sleep(ms);
  };

  // 1 Start
  if (FROM <= 1) {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.mouse.move(980, 620);
    mark('scene', { id: 1 });
    caption('Tack: a career pivot coach. Start with a résumé.');
    await sleep(1800);
    await scrollTo('.intake', 'center', 1100);
    caption('Upload the résumé PDF. The model reads it now; every skill keeps the line that proves it.');
    const chooser = page.waitForEvent('filechooser');
    await click(page.locator('.intake .dropzone__hit').first());
    tag('Model calls are live, not cached');
    await (await chooser).setFiles(RESUME_PDF);
    await wait('resume', 2, () => page.getByRole('heading', { name: 'Profile' }).first().waitFor({ timeout: 180_000 }));
    await showCall(1500);
    await closeTrace();
    await sleep(200);
    await scrollTo(page.getByRole('heading', { name: 'Profile' }).first(), 'start', 1200);
    await moveTo(560, 640);
    await sleep(600);
    await scrollBy(320, 1100);
    await sleep(300);

    await closeTrace();
    caption('Set the target: AI Product Manager in Bengaluru, 10 hours a week for 12 weeks.');
    const role = page.getByLabel('Target role');
    await click(role);
    await role.fill('');
    await role.pressSequentially('AI Product Manager', { delay: 30 });
    tag('');
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
    await sleep(900);
  }

  // 2 Read the market
  if (FROM <= 2) {
    mark('scene', { id: 2 });
    caption('Read the market: open roles straight from 60 public company job boards.');
    await scrollTo(page.getByRole('heading', { name: 'Read the market' }).first(), 'start', 1100);
    await click(page.getByRole('button', { name: /^Read the market/ }).first());
    await sleep(1200);
    caption('The trace shows the agent at work: boards listed, 40 live postings read.');
    await wait('harvest', 5, () => page.getByText('Extracting skills').first().waitFor({ timeout: 300_000 }));
    caption('Then the model reads them in 8 batches of 5, each skill kept with the exact line it came from.');
    await wait('extract', 5, () => page.waitForURL('**/gap', { timeout: 600_000 }));
    await showCall(1000);
  }

  // 3 Gap map
  if (FROM <= 3) {
    mark('scene', { id: 3 });
    await closeTrace();
    await top(600);
    caption('The gap map: readiness weighted by how often each skill is asked for.');
    await sleep(1700);
    await scrollTo('.constellation', 'center', 1300);
    caption('Size is demand; fill is how much of it the résumé shows. Numbers are computed in code.');
    await moveTo(800, 520);
    await still('01-gap-map');
    await sleep(1500);
    await scrollTo(page.getByText('Top five to close').first(), 'start', 1100);
    caption('Open the top gap: the résumé against what real postings say, company by company.');
    await click(page.locator('.top5 .close-card').first());
    await sleep(1400);
    await moveTo(1180, 640);
    await scrollBy(340, 1500, '.drawer__body');
    await still('02-evidence-drawer');
    await sleep(700);
    await page.keyboard.press('Escape');
    await sleep(700);
  }

  // 4 Market
  if (FROM <= 4) {
    await closeTrace();
    mark('scene', { id: 4 });
    caption('The market: the 40 postings Tack read from real companies, each with its fit.');
    await nav('Market');
    await sleep(1300);
    await scrollTo('.wall', 'start', 1100);
    await still('03-live-market');
    await sleep(1800);
  }

  // 5 Plan
  if (FROM <= 5) {
    await closeTrace();
    mark('scene', { id: 5 });
    caption('The plan: 12 weeks inside 10 hours a week, biggest gaps first. The model only words the tasks.');
    await nav('Plan');
    await sleep(700);
    const build = page.getByRole('button', { name: 'Build my plan' }).first();
    if (await build.isVisible().catch(() => false)) {
      await click(build);
      await wait('plan', 2, () => page.locator('.week__tasks').first().waitFor({ timeout: 180_000 }));
      await showCall(1100);
      await closeTrace();
    }
    await sleep(300);
    await scrollTo('.plan-legend', 'start', 1100);
    await sleep(300);
    caption('Tick a task and pass the checkpoint: the week\'s skills are credited and readiness moves.');
    await click(page.locator('.task__tick').first());
    await sleep(600);
    await click(page.getByRole('button', { name: 'Passed' }).first());
    await sleep(2000);
    caption('Mark it not yet instead, then replan: a repair block goes in and the card says what moved and why.');
    await click(page.getByRole('button', { name: 'Not yet' }).first(), { scroll: false });
    await sleep(900);
    await top(700);
    await click(page.getByRole('button', { name: /^Replan/ }).first());
    await sleep(700);
    await click(page.locator('.modal').getByRole('button', { name: /Replan/ }).last(), { scroll: false });
    await wait('replan', 1.5, () => page.locator('[aria-label="What moved and why"]').first().waitFor({ timeout: 60_000 }));
    await closeTrace();
    await scrollTo('[aria-label="What moved and why"]', 'center', 1100);
    await moveTo(900, 470);
    await sleep(2300);
  }

  // 6 Interview
  if (FROM <= 6) {
    await closeTrace();
    mark('scene', { id: 6 });
    caption('Mock interviews: questions drawn from the target postings and the open gaps.');
    await nav('Interview');
    await sleep(500);
    await click(page.getByRole('button', { name: /Start the session/ }));
    const box = page.locator('textarea').first();
    await wait('question', 1.5, () => box.waitFor({ timeout: 120_000 }));
    await showCall(1000);
    await closeTrace();
    await sleep(1000);
    const question = (await page.locator('.stage__q').first().textContent().catch(() => '')) || '';
    await click(box);
    await wait('typing', 1.5, () => box.pressSequentially(answerFor(question), { delay: 6 }));
    await sleep(400);
    await click(page.getByRole('button', { name: 'Score this answer' }));
    caption('Judged live on a five-part rubric. Every score quotes the candidate\'s own words.');
    await wait('judge', 2.5, () => page.locator('.crits__list').first().waitFor({ timeout: 180_000 }));
    await showCall(1200);
    await closeTrace();
    await scrollTo('.fb', 'start', 1000);
    await sleep(900);
    await scrollTo('.crits', 'start', 1100);
    await point(page.locator('.crits__list li').nth(1), { scroll: false }).catch(() => {});
    await still('04-interview-feedback');
    await sleep(2000);
    caption('Then a stronger answer built only from what was said, and the follow-up to expect.');
    await scrollTo(page.getByText(/stronger version/i).first(), 'start', 1200);
    await moveTo(900, 700);
    await sleep(3000);
  }

  // 7 Tracker
  if (FROM <= 7) {
    await closeTrace();
    mark('scene', { id: 7 });
    caption('A new profile has no reply history yet, so start over with the demo person.');
    await nav('Start');
    await top(700);
    await click(page.getByRole('button', { name: 'Start over' }).first());
    await sleep(700);
    await click(page.getByRole('button', { name: 'Clear and start over' }), { scroll: false });
    await sleep(900);
    tag('Demo person · sample data');
    await click(page.getByRole('button', { name: 'Load the demo person' }).first());
    await wait('demo', 1.5, () => page.getByText('Avery Quinn is loaded').first().waitFor({ timeout: 60_000 }));
    await sleep(500);
    const details = page.getByRole('heading', { name: 'Application details' }).first();
    if (await details.count()) {
      caption('Her details and standing consent come with the sample; her applications go only to a practice form.');
      await scrollTo(details, 'start', 1200);
      await moveTo(760, 560);
      await sleep(1700);
    }
    await nav('Tracker');
    await page.getByText('What gets replies').first().waitFor({ timeout: 60_000 });
    await sleep(500);
    await scrollTo(page.getByText('What gets replies').first(), 'start', 1100);
    caption('What gets replies: lessons written by code from reply rates per kind of role.');
    await moveTo(960, 520);
    await still('05-tracker-lessons');
    await sleep(2000);

    await top(900);
    tag('Sample mailbox · no real mail is read');
    caption('Check replies: Tack searches the sample mailbox for every company with an open application.');
    const rateBefore = ((await page.locator('.replies__rate').first().textContent().catch(() => '')) || '').trim();
    await click(page.locator('.mail__acts').getByRole('button', { name: 'Check replies' }));
    await wait('mail', 3, () => page.locator('.changed').first().waitFor({ timeout: 180_000 }));
    await showCall(1300);
    await closeTrace();
    await sleep(300);
    const rateAfter = ((await page.locator('.replies__rate').first().textContent().catch(() => '')) || '').trim();
    const moved = rateBefore && rateAfter && rateBefore !== rateAfter ? `: the response rate moves from ${rateBefore} to ${rateAfter}` : '';
    caption(`One model call sorts the messages and statuses move${moved}.`);
    await scrollTo('.changed', 'start', 1100);
    await moveTo(820, 500);
    await still('08-check-replies');
    await sleep(2200);
    await scrollTo('.replies', 'center', 1000);
    await sleep(1600);

    tag('Demo person · sample data');
    await scrollTo(page.getByRole('heading', { name: 'Apply next' }).first(), 'start', 1200);
    caption('Prepare application: the model tailors the bullets, each shown with its résumé line.');
    await sleep(500);
    await click(page.getByRole('button', { name: 'Prepare application' }).first());
    // the sheet sits over the trace rail, so the rail is left alone here
    await wait('kit', 1.5, () => page.locator('.kit__bullets').first().waitFor({ timeout: 180_000 }));
    await sleep(500);
    await scrollTo('.kit__bullets', 'start', 1200);
    await moveTo(1100, 560);
    await still('06-application-kit');
    await sleep(2000);
    await page.keyboard.press('Escape');
    await sleep(600);
    await closeTrace();

    tag('Practice applications · local sandbox form');
    await scrollTo('.topn', 'center', 1100);
    caption('Apply to top 3: three engine sessions in parallel, each filling and submitting in its own Chrome.');
    await click(page.getByRole('button', { name: /^Apply to top 3/ }));
    await page.locator('.batch').first().waitFor({ timeout: 30_000 });
    await sleep(600);
    await scrollTo('.batch', 'start', 1000);
    await closeTrace();
    caption('These are practice applications to Tack\'s local sandbox form, never sent to a company.');
    const runsDone = () => page.evaluate(() => {
      const runs = [...document.querySelectorAll('.batch .run')];
      return runs.length > 0 && runs.every((el) => el.classList.contains('is-applied') || el.classList.contains('is-failed'));
    });
    const allFilling = () => page.evaluate(() => {
      const runs = [...document.querySelectorAll('.batch .run')];
      return runs.length > 0 && runs.every((el) => /Filled|Pressed Submit|Confirmed/.test(el.textContent || '') || el.classList.contains('is-failed'));
    });
    await wait('apply-start', 3.5, async () => { while (!(await allFilling()) && !(await runsDone())) await sleep(250); });
    caption('With a real person and a live posting, the same run fills and submits the real posting instead.');
    await wait('apply-finish', 5, async () => {
      const t0 = Date.now();
      while (!(await runsDone())) {
        if (Date.now() - t0 > 480_000) throw new Error('the apply batch did not finish within 8 minutes');
        await sleep(250);
      }
    });
    await sleep(900);
    result = await page.evaluate(() => ({
      applied: document.querySelectorAll('.batch .run.is-applied').length,
      failed: document.querySelectorAll('.batch .run.is-failed').length,
      line: document.querySelector('.batch__line')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
    r.mark('apply', result);
    caption(result.failed
      ? `${result.applied} of 3 confirmed; a run that is not sent says why.`
      : 'All three confirmed: the form\'s reference number and the page each run ended on.');
    await scrollTo('.batch__runs', 'center', 1100);
    await moveTo(900, 560);
    await still('07-parallel-apply');
    await sleep(3000);
  }

  // 8 Autopilot
  if (FROM <= 8) {
    mark('scene', { id: 8 });
    tag('Demo person · practice form · sample mailbox');
    caption('Autopilot runs the whole loop on a schedule: read, rank, apply, read replies, replan.');
    await nav('Autopilot');
    await page.locator('.ap__status').first().waitFor({ timeout: 30_000 });
    await sleep(1300);
    await scrollTo(page.getByRole('heading', { name: 'Settings' }).first(), 'start', 1200);
    const set = (await fetch(`${BASE}/api/autopilot`).then((x) => x.json()).catch(() => null))?.settings ?? { intervalHours: 12, minFit: 50, needsApproval: false };
    caption(`Every ${set.intervalHours} hours, fit ${set.minFit} and up, ${set.needsApproval ? 'each waiting for approval' : 'no approval step'}. For this demo the daily cap goes to 2.`);
    await moveTo(820, 520);
    await sleep(1200);
    const capStepper = page.locator('.stepper').filter({ has: page.getByLabel('Daily cap') }).first();
    for (let i = 0; i < 6 && Number(await page.getByLabel('Daily cap').inputValue()) > 2; i++) {
      await click(capStepper.getByRole('button', { name: 'Decrease' }), { scroll: false });
      await sleep(250);
    }
    await sleep(500);
    await click(page.getByRole('button', { name: 'Save settings' }));
    await sleep(1800);
    await top(900);
    caption('Run now on the demo person: every step streams in as it runs.');
    await click(page.getByRole('button', { name: 'Run now' }).first());
    await page.locator('.ap__live-steps').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(500);
    await closeTrace();
    await scrollTo(page.getByRole('heading', { name: 'Running now' }).first(), 'start', 1000);
    const apNow = () => fetch(`${BASE}/api/autopilot`).then((x) => x.json()).catch(() => null);
    const stepOf = (s, name) => s?.running?.steps?.find((x) => x.name === name)?.status;
    await wait('autopilot-prep', 3, async () => {
      for (;;) {
        const s = await apNow();
        if (!s?.running || ['running', 'done', 'failed', 'skipped'].includes(stepOf(s, 'apply'))) return;
        await sleep(400);
      }
    });
    const before = await apNow();
    const rankNote = before?.running?.steps?.find((x) => x.name === 'rank')?.note ?? '';
    const picked = rankNote.match(/^picked (\d+) of (\d+)/);
    caption(picked
      ? `It ranked ${picked[2]} postings, picked ${picked[1]} within the cap, wrote their kits, and applies to them in parallel.`
      : 'Kits written, then the picks are applied to in parallel, each in its own engine session.');
    await wait('autopilot-apply', 4.5, async () => {
      const t0 = Date.now();
      for (;;) {
        const s = await apNow();
        if (!s?.running) return;
        if (Date.now() - t0 > 480_000) throw new Error('the autopilot run did not finish within 8 minutes');
        await sleep(400);
      }
    });
    await sleep(800);
    const done = await apNow();
    r.mark('autopilot', { status: done?.lastRun?.status, summary: done?.lastRun?.summary });
    caption('The run report: what it read, what it applied to and why, what came back, what the plan changed.');
    await page.locator('.ap__run-head').first().waitFor({ timeout: 40_000 }).catch(() => {});
    await scrollTo(page.getByRole('heading', { name: 'Run history' }).first(), 'start', 1100);
    await click(page.locator('.ap__run-head').first(), { scroll: false });
    await page.locator('.ap__report').first().waitFor({ timeout: 15_000 }).catch(() => {});
    await sleep(700);
    await scrollTo('.ap__report', 'start', 1100);
    await moveTo(900, 520);
    await still('09-autopilot');
    await sleep(3000);
    tag('');
  }

  // 9 Progress
  if (FROM <= 9) {
    mark('scene', { id: 9 });
    await nav('Progress');
    caption('Progress and the daily brief: the three things worth doing today.');
    await sleep(2400);
    await scrollTo('.nums', 'start', 1200);
    caption('Readiness over time, hours against the plan, streak and interview scores.');
    await sleep(2200);
  }
  mark('end');
  return result;
}

// ------------------------------------------------------------ main

const { child, log } = await startCoach();
let browser;
let result;
try {
  browser = await chromium.launch();
  await makeResume(browser);
  if (FROM === 1) await api('/reset', 'POST');
  const state = await api('/state');
  console.log(`coach on ${BASE}: engine ${state.engine.available ? 'on' : 'off'} (${state.engine.note}), model ${state.model.name}, model cache ${CACHE_MODE}`);
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
  // Every model call the coach makes (the engine's go through it too), for the take's own record.
  const events = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: events.signal });
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const e = JSON.parse(line.slice(5));
            if (e.run === 'model' && e.status !== 'start') r.mark('model', { task: e.step, status: e.status, detail: String(e.detail ?? '').slice(0, 200), ms: e.ms });
          } catch { /* not an event */ }
        }
      }
    } catch { /* stream closed */ }
  })();
  const started = now();
  try {
    result = await storyboard(page, r);
  } finally {
    await sleep(600);
    await cdp.send('Page.stopScreencast').catch(() => {});
    await Promise.all(writes);
    await page.screenshot({ path: join(OUT, 'last.png') }).catch(() => {});
    writeFileSync(join(OUT, 'take.json'), JSON.stringify({ started, scale: SCALE, frames, marks: r.marks }, null, 1));
    events.abort();
    console.log(`${frames.length} frames over ${(now() - started).toFixed(1)} s in ${OUT}`);
    const calls = r.marks.filter((x) => x.type === 'model');
    const failed = calls.filter((x) => x.status === 'fail');
    console.log(`  model calls: ${calls.length - failed.length} answered, ${calls.filter((x) => /cached/.test(x.detail)).length} from the cache, ${failed.length} failed`);
    for (const f of failed.slice(0, 8)) console.log(`    failed ${f.task}: ${f.detail.slice(0, 140)}`);
    for (const m of r.marks.filter((x) => x.type === 'wait')) console.log(`  wait ${m.label}: ${(m.t1 - m.t0).toFixed(1)} s`);
  }
} finally {
  await browser?.close();
  // The coach stops its engine, and the engine its Chrome, before it exits.
  const gone = new Promise((ok) => child.once('exit', ok));
  child.kill('SIGTERM');
  await Promise.race([gone, sleep(20_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try { writeFileSync(join(OUT, 'coach.log'), log.join('')); } catch { /* no take folder */ }
  if (process.env.TACK_VIDEO_LOG) console.log(log.join(''));
}
if (result) console.log(`apply: ${result.applied} confirmed, ${result.failed} not sent (${result.line})`);
if (FROM <= 7 && (!result || result.failed || result.applied < 3)) process.exitCode = 3;
