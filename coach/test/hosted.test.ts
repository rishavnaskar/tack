// Hosted mode end to end: the real server in a child process, real HTTP, a stand-in model endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const SERVE = fileURLToPath(new URL('../bin/serve.ts', import.meta.url));
const COACH = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------- a model that reads résumés

let modelCalls = 0;
const model: Server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    modelCalls++;
    const body = JSON.parse(raw);
    if (body.response_format?.json_schema?.name !== 'intake_resume') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"only résumés here"}');
      return;
    }
    const text: string = body.messages[1].content.replace(/^Résumé:\n\n/, '');
    if (text.includes('Quota Spent')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
      res.end('{"error":"quota"}');
      return;
    }
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const quote = (word: string) => lines.find((l) => l.toLowerCase().includes(word)) ?? lines[1];
    const profile = {
      name: lines[0], headline: lines[1], currentRole: lines[1], yearsExperience: 6, summary: lines[2],
      skills: [
        { name: 'SQL', level: 4, evidence: [quote('sql')] },
        { name: 'Stakeholder management', level: 3, evidence: [quote('stakeholder')] },
      ],
      experience: [{ title: lines[1], company: 'Example Co', start: '2020', end: 'Present', bullets: [lines[3]] }],
      education: [], projects: [],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(profile) } }] }));
  });
});

function resume(name: string, city: string): string {
  return [
    name,
    'Senior Operations Analyst',
    `Six years of analytics work in ${city}, moving into product.`,
    'Built weekly SQL dashboards that cut reporting time from two days to three hours for the finance team.',
    'Ran stakeholder reviews across sales, finance and support to agree on one definition of an active customer.',
    'Owned the vendor onboarding checklist and trained twelve new analysts on the data warehouse.',
    'Wrote the incident runbook for the billing pipeline and led the monthly review of its failures.',
  ].join('\n');
}

// ---------------------------------------------------------------- servers

interface Running { proc: ChildProcess; base: string; logs: string[]; dir: string }
const running: Running[] = [];

function startServer(env: Record<string, string>, hosted = true): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tack-hosted-'));
  const ui = join(dir, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Tack</title><p>TACK-INDEX</p>');
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'TOP-SECRET');
  const port = (model.address() as AddressInfo).port;
  const proc = spawn(process.execPath, ['--no-warnings', SERVE], {
    cwd: COACH,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      ...(hosted ? { TACK_HOSTED: '1', PORT: '0' } : {}),
      TACK_STATE_DIR: join(dir, 'state'), TACK_UI_DIR: ui, TACK_ENGINE: 'off', TACK_HARVEST_PACE_MS: '0',
      TACK_MODEL_URL: `http://127.0.0.1:${port}/chat/completions`, TACK_MODEL_KEY: 'test-key', TACK_MODEL_RETRIES: '0',
      TACK_MODEL_BACKOFF_MS: '10', TACK_MODEL_RPM: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`server did not start:\n${logs.join('')}`)), 15_000);
    proc.stderr!.on('data', (d) => logs.push(String(d)));
    proc.stdout!.on('data', (d) => {
      logs.push(String(d));
      const m = logs.join('').match(/"msg":"listening"[^\n]*"port":(\d+)|listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        const r = { proc, base: `http://127.0.0.1:${m[1] ?? m[2]}`, logs, dir };
        running.push(r);
        ok(r);
      }
    });
    proc.on('exit', (code) => { clearTimeout(timer); fail(new Error(`server exited with ${code}:\n${logs.join('')}`)); });
  });
}

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
}

// ---------------------------------------------------------------- a visitor with a cookie jar

class Visitor {
  cookie = '';
  setCookies: string[] = [];
  base: string;
  constructor(base: string) { this.base = base; }
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) {
      this.setCookies.push(...set);
      this.cookie = set[set.length - 1].split(';')[0];
    }
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data: data as any, headers: res.headers };
  }
  async ok(method: string, path: string, body?: unknown) {
    const r = await this.call(method, path, body);
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} answered ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  /** Collects trace events from /api/events until stop() is called. */
  async events() {
    const ctl = new AbortController();
    const res = await fetch(`${this.base}/api/events`, { headers: { cookie: this.cookie }, signal: ctl.signal });
    assert.equal(res.status, 200);
    const seen: { run: string; step: string; detail: string }[] = [];
    const reader = res.body!.getReader();
    const done = (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (data) seen.push(JSON.parse(data.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
    return { seen, stop: async () => { ctl.abort(); await done; } };
  }
}

before(async () => {
  await new Promise<void>((ok) => model.listen(0, '127.0.0.1', () => ok()));
});

after(async () => {
  for (const r of running) if (r.proc.exitCode === null) r.proc.kill('SIGKILL');
  await new Promise<void>((ok) => model.close(() => ok()));
});

// ---------------------------------------------------------------- isolation

test('two visitors at once: neither sees the other\'s profile, postings, gap, plan, interviews, applications or trace', async () => {
  // A scheduler that started here would tick every 50 ms outside any visitor's session.
  const srv = await startServer({ TACK_TICK_MS: '50' });
  const a = new Visitor(srv.base);
  const b = new Visitor(srv.base);

  const sa = await a.ok('GET', '/api/state');
  const sb = await b.ok('GET', '/api/state');
  assert.equal(sa.profile, undefined);
  assert.deepEqual(sa.capabilities, { apply: false, mail: false, autopilot: false, reason: sa.capabilities.reason });
  assert.match(sa.capabilities.reason, /desktop app/);
  assert.equal(sa.hosted.preview, true);
  assert.equal(sa.hosted.resumeMaxBytes, 5 * 1024 * 1024);
  assert.notEqual(a.cookie, b.cookie);

  // The cookie: HttpOnly, SameSite=Lax, a 256-bit id signed by the server.
  const set = a.setCookies[0];
  assert.match(set, /^tack_sid=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/);
  assert.equal(Buffer.from(set.split('=')[1].split('.')[0], 'base64url').length, 32);

  const ta = await a.events();
  const tb = await b.events();

  const flowA = async () => {
    const profile = await a.ok('POST', '/api/profile/resume', { text: resume('Priya Raman', 'Pune') });
    assert.equal(profile.name, 'Priya Raman');
    await a.ok('PUT', '/api/goal', { targetRole: 'Product Analyst', location: 'Pune', remote: false, hoursPerWeek: 8, weeks: 10 });
    const h = await a.ok('POST', '/api/postings/harvest', { count: 10 });
    assert.equal(h.postings.length, 10);
    await a.ok('POST', '/api/gap/build');
    await a.ok('POST', '/api/plan/build');
    await a.ok('POST', '/api/portfolio/build');
    const iv = await a.ok('POST', '/api/interviews', { kind: 'behavioural' });
    await a.ok('POST', `/api/interviews/${iv.id}/answer`, { questionId: iv.questions[0].id, answer: 'I led a review of our billing failures and cut repeat incidents by half in one quarter.' });
    await a.ok('POST', '/api/applications', { title: 'Product Analyst', company: 'Northwind Example', status: 'applied' });
  };
  const flowB = async () => {
    const s = await b.ok('POST', '/api/demo/load');
    assert.equal(s.profile.name, 'Avery Quinn');
  };
  await Promise.all([flowA(), flowB()]);

  const [stA, stB] = [await a.ok('GET', '/api/state'), await b.ok('GET', '/api/state')];
  assert.equal(stA.profile.name, 'Priya Raman');
  assert.equal(stB.profile.name, 'Avery Quinn');
  assert.equal(stA.goal.targetRole, 'Product Analyst');
  assert.notEqual(stB.goal.targetRole, 'Product Analyst');
  assert.deepEqual(stA.counts, { postings: 10, applications: 1, interviews: 1 });
  assert.equal(stB.counts.postings, 40);
  assert.equal(stB.counts.applications, 24);
  assert.equal(stB.counts.interviews, 2);
  // A's market is the bundled sample: the boards are off here and the preview applies to nothing.
  assert.equal(stA.mode, 'demo');
  // The demo person comes with standing consent and applications; nothing automated opens up for her.
  assert.deepEqual(stB.capabilities, sa.capabilities);
  for (const p of ['/api/autopilot', '/api/queue', '/api/apply/runs', '/api/mail/status']) assert.equal((await b.call('GET', p)).status, 409, p);

  const [gapA, gapB] = [await a.ok('GET', '/api/gap'), await b.ok('GET', '/api/gap')];
  assert.equal(gapA.postingCount, 10);
  assert.equal(gapB.postingCount, 40);
  const resumeQuotesA = gapA.skills.flatMap((s: any) => s.evidence.resume).join(' ');
  assert.doesNotMatch(resumeQuotesA, /Avery|backend/i);

  const [planA, planB] = [await a.ok('GET', '/api/plan'), await b.ok('GET', '/api/plan')];
  assert.equal(planA.weeks.length, 10);
  assert.notDeepEqual(planA.weeks.map((w: any) => w.startDate), planB.weeks.map((w: any) => w.startDate));

  const [ivA, ivB] = [await a.ok('GET', '/api/interviews'), await b.ok('GET', '/api/interviews')];
  assert.equal(ivA.length, 1);
  assert.equal(ivB.length, 2);
  assert.ok(!ivB.some((s: any) => s.id === ivA[0].id));

  const [appsA, appsB] = [await a.ok('GET', '/api/applications'), await b.ok('GET', '/api/applications')];
  assert.deepEqual(appsA.map((x: any) => x.company), ['Northwind Example']);
  assert.ok(!appsB.some((x: any) => x.company === 'Northwind Example'));
  assert.equal((await b.call('GET', `/api/interviews`)).data.length, 2);
  assert.equal((await b.call('PATCH', `/api/applications/${appsA[0].id}`, { status: 'reply' })).status, 404);

  const [portA, portB] = [await a.ok('GET', '/api/portfolio'), await b.ok('GET', '/api/portfolio')];
  assert.ok(portA.length > 0 && portB.length > 0);
  assert.ok(!portB.some((p: any) => portA.some((q: any) => q.id === p.id && JSON.stringify(q) === JSON.stringify(p))));

  // Trace: each stream carries only its own runs, live and on reconnect.
  await new Promise((r) => setTimeout(r, 200));
  await ta.stop();
  await tb.stop();
  const runsA = new Set(ta.seen.map((e) => e.run));
  const runsB = new Set(tb.seen.map((e) => e.run));
  assert.ok(runsA.has('intake') && runsA.has('gap') && runsA.has('plan'), [...runsA].join(','));
  assert.ok(!runsA.has('demo'), 'A saw the demo load');
  assert.ok(runsB.has('demo'), [...runsB].join(','));
  for (const r of ['intake', 'plan', 'portfolio', 'interview', 'harvest']) assert.ok(!runsB.has(r), `B saw A's ${r}`);
  assert.ok(!JSON.stringify(tb.seen).includes('Priya'));
  const again = await b.events();
  await new Promise((r) => setTimeout(r, 200));
  await again.stop();
  assert.ok(again.seen.length > 0 && again.seen.every((e) => e.run !== 'intake'));

  // A third visitor, and a forged cookie, start empty.
  const c = new Visitor(srv.base);
  const sc = await c.ok('GET', '/api/state');
  assert.equal(sc.profile, undefined);
  assert.deepEqual(await c.ok('GET', '/api/applications'), []);
  assert.deepEqual(await c.ok('GET', '/api/postings'), []);
  assert.equal((await c.call('GET', '/api/gap')).status, 404);
  const forged = new Visitor(srv.base);
  forged.cookie = `${a.cookie.split('.')[0]}.${'A'.repeat(43)}`;
  const sf = await forged.ok('GET', '/api/state');
  assert.equal(sf.profile, undefined);
  assert.notEqual(forged.cookie, a.cookie);

  // The model cache is shared, but keyed on the résumé text: another résumé gets its own profile.
  const before = modelCalls;
  const p = await c.ok('POST', '/api/profile/resume', { text: resume('Tomas Varga', 'Lisbon') });
  assert.equal(p.name, 'Tomas Varga');
  assert.equal(modelCalls, before + 1);

  // One file per visitor that wrote something; the file names are hashes, never the cookie id.
  const files = readdirSync(join(srv.dir, 'state', 'sessions')).filter((f) => f.endsWith('.db'));
  assert.equal(files.length, 3);
  for (const f of files) assert.match(f, /^[0-9a-f]{32}\.db$/);
  const ids = [a, b, c].map((v) => v.cookie.split('=')[1].split('.')[0]);
  assert.ok(!files.some((f) => ids.some((id) => f.includes(id))));

  // Logs are one JSON object per line and carry no personal data.
  const lines = srv.logs.join('').split('\n').filter(Boolean);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), l);
  assert.ok(!lines.some((l) => /Priya|Avery|Tomas|Pune/.test(l)));
  assert.deepEqual(lines.filter((l) => JSON.parse(l).level !== 'info'), []);
  assert.ok(!lines.some((l) => ids.some((id) => l.includes(id))));
});

// ---------------------------------------------------------------- limits and hardening

test('hosted limits: 409 for browser features, budget 429, body and type checks, headers, traversal, rate', async () => {
  const srv = await startServer({ TACK_BUDGET_SESSION_HOUR: '1', TACK_RATE_SESSION_PER_MINUTE: '40', TACK_MODEL_RETRIES: '2', TACK_DOWNLOAD_URL: 'https://download.example/tack' });
  const v = new Visitor(srv.base);
  await v.ok('GET', '/api/state');

  const off: [string, string, string][] = [
    ['POST', '/api/apply', 'apply'], ['POST', '/api/apply/top', 'apply'], ['GET', '/api/apply/readiness', 'apply'], ['GET', '/api/apply/runs', 'apply'],
    ['GET', '/api/apply/dry-runs', 'apply'], ['GET', '/practice/apply/x', 'apply'], ['GET', '/api/practice/submissions', 'apply'],
    // the apply queue, its "needs you" list, remembered answers and standing consent
    ['GET', '/api/queue', 'apply'], ['POST', '/api/queue/j1/answer', 'apply'], ['POST', '/api/queue/j1/retry', 'apply'],
    ['POST', '/api/queue/j1/approve', 'apply'], ['POST', '/api/queue/j1/skip', 'apply'], ['DELETE', '/api/answers/a1', 'apply'], ['PUT', '/api/consent', 'apply'],
    // mail
    ['GET', '/api/mail/status', 'mail'], ['POST', '/api/mail/connect', 'mail'], ['POST', '/api/mail/check', 'mail'], ['POST', '/api/mail/disconnect', 'mail'],
    ['POST', '/api/applications/sync', 'mail'],
    // the autopilot, its settings and its runs
    ['GET', '/api/autopilot', 'autopilot'], ['PUT', '/api/autopilot/settings', 'autopilot'], ['POST', '/api/autopilot/run', 'autopilot'],
    ['GET', '/api/autopilot/runs', 'autopilot'], ['GET', '/api/autopilot/runs/ap-1', 'autopilot'], ['POST', '/api/autopilot/start', 'autopilot'],
  ];
  for (const [m, p, capability] of off) {
    const fresh = new Visitor(srv.base);
    const r = await fresh.call(m, p, m === 'POST' || m === 'PUT' ? { on: true } : undefined);
    assert.equal(r.status, 409, `${m} ${p}`);
    assert.match(r.data.error, /desktop app/, `${m} ${p}`);
    assert.equal(r.data.capability, capability, `${m} ${p}`);
    assert.equal(r.data.download, 'https://download.example/tack');
    assert.equal(fresh.cookie, '', `${m} ${p} started a session`);
  }
  // Every write the preview does serve has an input check of its own.
  assert.doesNotMatch(srv.logs.join(''), /uncheckedWrites/);

  // Budget: one model call an hour for this visitor; the second résumé read is refused kindly.
  const first = await v.call('POST', '/api/profile/resume', { text: resume('Lena Ortiz', 'Madrid') });
  assert.equal(first.status, 200);
  const second = await v.call('POST', '/api/profile/resume', { text: resume('Lena Ortiz Second', 'Madrid') });
  assert.equal(second.status, 429);
  assert.equal(second.data.code, 'budget');
  assert.match(second.data.error, /hourly limit/);
  assert.ok(Number(second.headers.get('retry-after')) > 0);
  // Routes with a built-in fallback still answer when the budget is spent.
  await v.ok('PUT', '/api/goal', { targetRole: 'Product Analyst', location: 'Madrid' });
  const roles = await v.ok('POST', '/api/roles/suggest');
  assert.ok(roles.roles.length > 0);

  // Bodies: 1 MB of JSON, a 5 MB résumé, JSON only, same origin only, checked fields.
  assert.equal((await v.call('PUT', '/api/goal', { targetRole: 'x', notes: 'n'.repeat(1_200_000) })).status, 413);
  const big = await v.call('POST', '/api/profile/resume', { pdfBase64: 'A'.repeat(4 * Math.ceil((5.5 * 1024 * 1024) / 3)), filename: 'cv.pdf' });
  assert.equal(big.status, 413);
  assert.match(big.data.error, /5 MB/);
  assert.equal((await v.call('PUT', '/api/goal', 'targetRole=x', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await v.call('PUT', '/api/goal', { targetRole: 'x' }, { origin: 'https://elsewhere.example' })).status, 403);
  const bad = await v.call('PUT', '/api/goal', { targetRole: 42 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /targetRole must be text/);
  assert.equal((await v.call('POST', '/api/applications', { title: 'x', company: 'y', url: 'javascript:alert(1)' })).status, 400);

  // Headers on pages and API answers.
  const page = await fetch(`${srv.base}/`);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('x-request-id') ?? '', /^[A-Za-z0-9_-]{8,}$/);
  assert.equal(page.headers.get('set-cookie'), null, 'pages do not start sessions');
  assert.match(await page.text(), /TACK-INDEX/);
  const health = await fetch(`${srv.base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  // Static files stay inside the UI folder.
  for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/.env', '/%00index.html']) {
    const r = await fetch(`${srv.base}${p}`);
    assert.doesNotMatch(await r.text(), /TOP-SECRET/, p);
  }
  assert.equal((await fetch(`${srv.base}/assets/missing.js`)).status, 404);
  const trace = await new Promise<number>((ok, fail) => {
    const u = new URL(srv.base);
    request({ host: u.hostname, port: u.port, path: '/', method: 'TRACE' }, (r) => { r.resume(); ok(r.statusCode ?? 0); }).on('error', fail).end();
  });
  assert.equal(trace, 405);

  // No internal detail in errors.
  const nope = await v.call('POST', '/api/gap/build');
  assert.equal(nope.status, 400);
  assert.doesNotMatch(JSON.stringify(nope.data), /\/Users|\/tmp|node:|at /);

  // Rate: a burst past the session's bucket gets 429 with a Retry-After.
  const burst = await Promise.all(Array.from({ length: 60 }, () => v.call('GET', '/api/postings')));
  const limited = burst.filter((r) => r.status === 429);
  assert.ok(limited.length > 0);
  assert.ok(limited.every((r) => r.data.code === 'rate' || r.data.code === 'busy'));

  // An upstream rate limit that asks for an hour fails the call within seconds instead of holding it.
  const w = new Visitor(srv.base);
  const t0 = Date.now();
  const limitedUp = await w.call('POST', '/api/profile/resume', { text: resume('Quota Spent', 'Oslo') });
  assert.equal(limitedUp.status, 503);
  assert.match(limitedUp.data.error, /too busy/);
  assert.ok(Date.now() - t0 < 5000);

  // SIGTERM drains and exits cleanly.
  const exited = new Promise<number | null>((ok) => srv.proc.once('exit', (code) => ok(code)));
  srv.proc.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(srv.logs.join(''), /"msg":"draining"[\s\S]*"msg":"stopped"/);
});

test('hosted mode cannot start a child process, so no engine and no Chrome', () => {
  const script = `
    const { lockProcesses } = await import('./src/hosted.ts');
    lockProcesses();
    const { ensureEngine } = await import('./src/engine-proc.ts');
    const cp = await import('node:child_process');
    let spawnErr = '';
    try { cp.spawn(process.execPath, ['-e', '1']); } catch (e) { spawnErr = e.message; }
    let engineErr = '';
    try { await ensureEngine(); } catch (e) { engineErr = e.message; }
    console.log(JSON.stringify({ spawnErr, engineErr }));
  `;
  const dir = mkdtempSync(join(tmpdir(), 'tack-lock-'));
  const out = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    cwd: COACH, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TACK_HOSTED: '1', TACK_STATE_DIR: dir },
  });
  const r = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.match(r.spawnErr, /turned off in hosted mode/);
  assert.match(r.engineErr, /turned off in hosted mode/);
});

test('with the flag off the coach is the local app: loopback only, no session cookie, no hosted headers', async () => {
  const port = await freePort();
  const srv = await startServer({ TACK_PORT: String(port) }, false);
  const res = await fetch(`${srv.base}/api/state`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('content-security-policy'), null);
  const s = (await res.json()) as any;
  assert.deepEqual(s.capabilities, { apply: true, mail: true, autopilot: true, reason: '' });
  assert.equal(s.hosted, undefined);
  assert.equal((await fetch(`${srv.base}/api/apply/readiness`)).status, 200);
  assert.equal((await fetch(`${srv.base}/api/mail/status`)).status, 200);
  for (const p of ['/api/autopilot', '/api/queue', '/api/apply/dry-runs']) assert.equal((await fetch(`${srv.base}${p}`)).status, 200, p);
  assert.equal((await fetch(`${srv.base}/api/state`, { method: 'GET', headers: { origin: 'https://elsewhere.example' } })).status, 200);
  assert.match(srv.logs.join(''), new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
  const exited = new Promise<number | null>((ok) => srv.proc.once('exit', (code) => ok(code)));
  srv.proc.kill('SIGTERM');
  assert.equal(await exited, 0);
});
