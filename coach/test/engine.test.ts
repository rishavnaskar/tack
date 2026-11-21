import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applications, apply, cleanText, companyOf, DiskCache, harvest, locationScore, mailReplies, postingId, rank,
  replyKind, resumeText, salaryIn, seniorityOf, textBonus, titleScore, verifyUrl, apiUrlOf,
} from '../src/engine-live.ts';
import type { Board } from '../src/boards.ts';

const ROLE = 'AI Product Manager';

test('titles score by the role head first, then its modifiers', () => {
  assert.equal(titleScore(ROLE, 'Senior Product Manager, Machine Learning'), 100);
  assert.equal(titleScore(ROLE, 'Product Manager - GenAI Platform'), 100);
  assert.equal(titleScore(ROLE, 'PM, Agents'), 100);
  assert.equal(titleScore(ROLE, 'Product Manager'), 75);
  assert.equal(titleScore(ROLE, 'Product Manager', 'Applied AI'), 88);
  assert.equal(titleScore(ROLE, 'Product Marketing Manager, AI'), 0);
  assert.equal(titleScore(ROLE, 'Machine Learning Engineer'), 0);
  assert.equal(titleScore(ROLE, 'Senior Renewal Sales Specialist - Night Shift (5:30 PM to 2:30 AM)'), 0);
  assert.ok(titleScore(ROLE, 'Product Manager Intern, AI') < 100);
  assert.ok(titleScore(ROLE, 'Director of Product Management, AI') < 100);
  assert.equal(titleScore('Data Scientist', 'Senior Data Scientist, Fraud'), 100);
  assert.equal(titleScore('Backend Engineer', 'Software Engineer, Backend'), 100);
  assert.equal(titleScore('', 'Product Manager'), 0);
});

test('a modifier the title lacks but the text repeats earns a bonus', () => {
  assert.equal(textBonus(ROLE, 'Product Manager', 'We build LLM agents. Machine learning is core. AI everywhere.'), 8);
  assert.equal(textBonus(ROLE, 'Product Manager', 'One mention of ML.'), 3);
  assert.equal(textBonus(ROLE, 'AI Product Manager', 'AI AI AI'), 0);
  assert.equal(textBonus(ROLE, 'Product Manager', 'Payments and lending.'), 0);
});

test('the requested city wins, then its country, then remote roles open to it', () => {
  assert.equal(locationScore('Bengaluru', 'Bangalore, Karnataka, India'), 40);
  assert.equal(locationScore('Bengaluru', 'Hybrid in Bangalore, India'), 40);
  assert.equal(locationScore('Bengaluru', 'Remote - India'), 35);
  assert.equal(locationScore('Bengaluru', 'Hyderabad, Telangana, India'), 30);
  assert.equal(locationScore('Bengaluru', 'Remote'), 25);
  assert.equal(locationScore('Bengaluru', 'Remote - USA'), 0);
  assert.equal(locationScore('Bengaluru', 'San Francisco, CA'), 0);
  assert.equal(locationScore('India or remote', 'Remote, US'), 0);
  assert.equal(locationScore('Bengaluru or remote', 'Remote - APAC'), 30);
  assert.equal(locationScore('Bengaluru or remote', 'Remote - EMEA'), 0);
  assert.equal(locationScore('remote', 'Remote, US'), 10);
  assert.equal(locationScore('', 'Anywhere'), 0);
});

test('for a goal in India, roles in India or remote in India rank above US-only remote roles', async () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const jobs = [
    { id: 1, title: 'Senior Product Manager, AI', location: 'Remote - USA' },
    { id: 2, title: 'AI Product Manager', location: 'Remote, US' },
    { id: 3, title: 'Product Manager, GenAI', location: 'San Francisco, CA; Remote' },
    { id: 4, title: 'Product Manager', location: 'Bengaluru, India' },
    { id: 5, title: 'Product Manager II', location: 'Remote - India' },
    { id: 6, title: 'Product Manager, Payments', location: 'Hyderabad, India' },
  ];
  // one company per posting, so the per-company cap does not decide the order
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const j = jobs.find((x) => url.includes(`/boards/co${x.id}/`));
    if (!j) return json({});
    if (url.endsWith('/jobs?content=false')) {
      return json({ jobs: [{ title: j.title, location: { name: j.location }, absolute_url: `https://job-boards.greenhouse.io/co${j.id}/jobs/${j.id}`, departments: [] }] });
    }
    return json({ title: j.title, location: { name: j.location }, content: '&lt;p&gt;Own the roadmap.&lt;/p&gt;' });
  }) as typeof fetch;
  const boards = jobs.map((j) => board(`Co${j.id}`));
  const r = await harvest(ROLE, 'Bengaluru or remote', 6, { fetch: fetchImpl, boards, cacheDir: null });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const places = r.postings.map((p) => p.location);
  assert.deepEqual(places.slice(0, 3).sort(), ['Bengaluru, India', 'Hyderabad, India', 'Remote - India']);
  assert.deepEqual(places.slice(3).sort(), ['Remote - USA', 'Remote, US', 'San Francisco, CA; Remote']);
});

test('board html becomes clean text, cut at a sentence near the cap', () => {
  const html = '&lt;p&gt;About us&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Ship &amp;amp; learn&lt;/li&gt;&lt;/ul&gt;';
  assert.equal(cleanText(html), 'About us\n\n- Ship & learn');
  assert.equal(cleanText('<div>One <b>two</b></div>three'), 'One two\n\nthree');
  const long = 'This sentence is about ten words or so long here. '.repeat(200);
  const cut = cleanText(long, 6000);
  assert.ok(cut.length <= 6000 && cut.length > 4800);
  assert.ok(cut.endsWith('.'));
});

test('plain posting text gets its paragraph and list breaks back', () => {
  const lever = 'About the Team\nWe build payments.\nWe ship weekly.\n\nWhat you will do\n-\nOwn the roadmap.\n\n-\nTalk to merchants.\nYou have\n- SQL\n- Five years';
  assert.equal(cleanText(lever), 'About the Team\n\nWe build payments.\n\nWe ship weekly.\n\nWhat you will do\n- Own the roadmap.\n- Talk to merchants.\n\nYou have\n- SQL\n- Five years');
  assert.equal(cleanText('<p>Intro.</p><p>Second.</p><ul><li><p>One</p></li><li><p>Two</p></li></ul>'), 'Intro.\n\nSecond.\n\n- One\n- Two');
});

test('salary ranges and seniority are read from plain words', () => {
  assert.equal(salaryIn('Base pay: $180,000 - $220,000 USD per year'), '$180,000 - $220,000 USD');
  assert.equal(salaryIn('CTC ₹30L to ₹45L'), undefined);
  assert.equal(salaryIn('Range INR 2,500,000 – 3,500,000'), 'INR 2,500,000 – 3,500,000');
  assert.equal(salaryIn('No numbers here'), undefined);
  assert.equal(seniorityOf('Senior Product Manager'), 'senior');
  assert.equal(seniorityOf('Associate Product Manager'), 'junior');
  assert.equal(seniorityOf('Group Product Manager'), 'lead');
  assert.equal(seniorityOf('Product Manager'), 'mid');
});

const board = (name: string, ats: Board['ats'] = 'greenhouse', slug = name.toLowerCase()): Board => ({ ats, board: slug, name, size: 'scaleup', india: true });

test('rank caps each company and drops the same title in the same place', () => {
  const a = board('Acme');
  const z = board('Zed');
  const c = (b: Board, title: string, location: string, score: number) => ({ board: b, listing: { title, location, department: '', url: `https://x.example/${title}${score}`, postedAt: null }, score });
  const out = rank([
    c(a, 'PM', 'Bengaluru', 100), c(a, 'PM', 'Bengaluru', 99), c(a, 'PM II', 'Bengaluru', 98), c(a, 'PM III', 'Pune', 97),
    c(z, 'PM', 'Bengaluru', 50),
  ], 10, 2);
  assert.deepEqual(out.map((x) => `${x.board.name}:${x.listing.title}`), ['Acme:PM', 'Acme:PM II', 'Zed:PM']);
});

test('greenhouse postings on a company site are read through the board api', () => {
  const b = board('Stripe');
  assert.equal(apiUrlOf(b, 'https://stripe.com/jobs/search?gh_jid=8323907'), 'https://job-boards.greenhouse.io/stripe/jobs/8323907');
  assert.equal(apiUrlOf(b, 'https://job-boards.greenhouse.io/stripe/jobs/1'), 'https://job-boards.greenhouse.io/stripe/jobs/1');
  assert.equal(apiUrlOf(board('Paytm', 'lever'), 'https://jobs.lever.co/paytm/abc'), 'https://jobs.lever.co/paytm/abc');
});

// A fake web of three boards: Greenhouse on a company site, Lever, Ashby; plus one that is down.
const LEVER_ID = '11111111-2222-3333-4444-555555555555';
const ASHBY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LONG = 'You will own the roadmap for our machine learning platform. '.repeat(150);
const BOARDS: Board[] = [board('Acme'), board('Lume', 'lever'), board('Kite', 'ashby'), board('Down', 'greenhouse')];

function fakeWeb() {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/boards/down/')) return json({}, 503);
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=false') {
      return json({ jobs: [
        { title: 'Senior Product Manager, AI', location: { name: 'Bengaluru, India' }, absolute_url: 'https://acme.example/careers?gh_jid=1001', departments: [{ name: 'Product' }], first_published: '2026-11-10T00:00:00Z' },
        { title: 'Account Executive', location: { name: 'London' }, absolute_url: 'https://acme.example/careers?gh_jid=1002', departments: [], first_published: '2026-11-11T00:00:00Z' },
        { title: 'Product Manager', location: { name: 'New York, NY' }, absolute_url: 'https://acme.example/careers?gh_jid=1003', departments: [], first_published: '2026-11-12T00:00:00Z' },
      ] });
    }
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1001') {
      return json({ title: 'Senior Product Manager, AI', location: { name: 'Bengaluru, India' }, content: '&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Lead our LLM work. Salary $150,000 - $190,000.&lt;/p&gt;' });
    }
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1003') {
      return json({ title: 'Product Manager', location: { name: 'New York, NY' }, content: '&lt;p&gt;Grow the core app.&lt;/p&gt;' });
    }
    if (url === 'https://api.lever.co/v0/postings/lume?mode=json') {
      return json([{ text: 'Product Manager, Machine Learning', categories: { location: 'Remote - India', team: 'Product' }, hostedUrl: `https://jobs.lever.co/lume/${LEVER_ID}`, createdAt: Date.parse('2026-11-01') }]);
    }
    if (url === `https://api.lever.co/v0/postings/lume/${LEVER_ID}`) {
      return json({ text: 'Product Manager, Machine Learning', categories: { location: 'Remote - India' }, descriptionPlain: LONG, lists: [{ text: 'You have', content: '<li>Shipped models</li>' }] });
    }
    if (url.startsWith('https://api.ashbyhq.com/posting-api/job-board/kite')) {
      return json({ jobs: [{ id: ASHBY_ID, title: 'AI Product Manager', location: 'Pune', jobUrl: `https://jobs.ashbyhq.com/kite/${ASHBY_ID}`, department: 'Product', publishedAt: '2026-11-15T00:00:00Z', descriptionPlain: 'Agents for small business.' }] });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('harvest reads every board, ranks by title and place, and returns clean live postings', async () => {
  const { fetchImpl, calls } = fakeWeb();
  const lines: string[] = [];
  const r = await harvest(ROLE, 'Bengaluru', 3, { fetch: fetchImpl, boards: BOARDS, cacheDir: null, trace: { step: (s, d) => lines.push(`${s}: ${d}`) }, now: () => Date.parse('2026-11-21T00:00:00Z') });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.boards.tried, 4);
  assert.equal(r.boards.answered, 3);
  assert.deepEqual(r.boards.failed.map((f) => f.board), ['Down']);
  assert.equal(r.scanned, 5);
  assert.deepEqual(r.postings.map((p) => p.company), ['Acme', 'Lume', 'Kite']);

  const [acme, lume, kite] = r.postings;
  assert.equal(acme.id, `live-${createHash('sha256').update('https://acme.example/careers?gh_jid=1001').digest('hex').slice(0, 12)}`);
  assert.equal(acme.id, postingId(acme.url));
  assert.equal(acme.url, 'https://acme.example/careers?gh_jid=1001');
  assert.equal(acme.source, 'greenhouse');
  assert.equal(acme.live, true);
  assert.equal(acme.text, 'About\n\nLead our LLM work. Salary $150,000 - $190,000.');
  assert.equal(acme.salary, '$150,000 - $190,000');
  assert.equal(acme.postedAt, '2026-11-10T00:00:00Z');
  assert.equal(acme.seniority, 'senior');
  assert.equal(acme.roleFamily, 'ai');
  assert.equal(acme.companySize, 'scaleup');
  assert.equal(acme.harvestedAt, '2026-11-21T00:00:00.000Z');
  assert.equal(lume.source, 'lever');
  assert.ok(lume.text.length <= 6000 && lume.text.length > 5000, `lume text ${lume.text.length}`);
  assert.ok(!/<[a-z]/i.test(lume.text));
  assert.equal(kite.source, 'ashby');
  assert.equal(kite.text, 'Agents for small business.');

  // Ashby's posting came from the board document already downloaded.
  assert.equal(calls.filter((u) => u.includes('ashbyhq')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('board:')).length, 4);
  assert.ok(lines.some((l) => /^board: Down \(greenhouse\) not read: greenhouse answered HTTP 503/.test(l)));
  assert.ok(lines.filter((l) => l.startsWith('posting:')).length >= 3);
});

test('harvest answers "not available" instead of throwing', async () => {
  const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  const r = await harvest(ROLE, 'Bengaluru', 5, { fetch: down, boards: BOARDS, cacheDir: null });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /no job board answered/);

  const none = await harvest('Pastry Chef', 'Bengaluru', 5, { fetch: fakeWeb().fetchImpl, boards: BOARDS, cacheDir: null });
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : '', /no open roles fit "Pastry Chef"/);

  assert.equal((await harvest('', 'x', 5, { cacheDir: null })).ok, false);
});

test('a board that hangs is cut off at its timeout', async () => {
  const hang = ((_: unknown, init?: RequestInit) => new Promise((_ok, fail) => {
    init?.signal?.addEventListener('abort', () => fail(new Error('aborted')));
  })) as unknown as typeof fetch;
  const t0 = Date.now();
  const r = await harvest(ROLE, 'Bengaluru', 5, { fetch: hang, boards: [board('Slow')], cacheDir: null, boardTimeoutMs: 150 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /timed out/);
  assert.ok(Date.now() - t0 < 2000);
});

test('a second harvest within 30 minutes is served from disk; an older cache is refetched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tack-cache-'));
  try {
    let clock = Date.parse('2026-11-21T10:00:00Z');
    const now = () => clock;
    const web = fakeWeb();
    const first = await harvest(ROLE, 'Bengaluru', 3, { fetch: web.fetchImpl, boards: BOARDS.slice(0, 3), cacheDir: dir, now });
    assert.ok(first.ok);
    const used = web.calls.length;
    assert.ok(used >= 5);

    clock += 10 * 60_000;
    const lines: string[] = [];
    const second = await harvest(ROLE, 'Bengaluru', 3, { fetch: web.fetchImpl, boards: BOARDS.slice(0, 3), cacheDir: dir, now, trace: { step: (s, d) => lines.push(`${s}: ${d}`) } });
    assert.ok(second.ok);
    assert.equal(web.calls.length, used, 'no network on a warm cache');
    assert.deepEqual(second.postings.map((p) => p.id), first.postings.map((p) => p.id));
    assert.ok(lines.every((l) => l.endsWith('cached') || /cached, \d+ ms$/.test(l)), lines.join('\n'));

    clock += 31 * 60_000;
    await harvest(ROLE, 'Bengaluru', 3, { fetch: web.fetchImpl, boards: BOARDS.slice(0, 3), cacheDir: dir, now });
    assert.ok(web.calls.length > used);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the disk cache ignores broken files and keys that collide', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tack-cache-'));
  try {
    const c = new DiskCache(dir, 1000, () => 5000);
    assert.equal(c.get('a'), null);
    c.set('a', { n: 1 });
    assert.deepEqual(c.get('a'), { n: 1 });
    assert.equal(new DiskCache(dir, 1000, () => 6001).get('a'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyUrl is true only on a 2xx, trying GET when HEAD is refused', async () => {
  const web = (answers: Record<string, number | 'throw'>) => (async (_u: unknown, init?: RequestInit) => {
    const a = answers[init?.method ?? 'GET'];
    if (a === 'throw') throw new Error('reset');
    return new Response(null, { status: a });
  }) as unknown as typeof fetch;
  assert.equal(await verifyUrl('https://ok.example/', web({ HEAD: 200, GET: 500 })), true);
  assert.equal(await verifyUrl('https://ok.example/', web({ HEAD: 405, GET: 204 })), true);
  assert.equal(await verifyUrl('https://ok.example/', web({ HEAD: 'throw', GET: 200 })), true);
  assert.equal(await verifyUrl('https://gone.example/', web({ HEAD: 404, GET: 404 })), false);
  assert.equal(await verifyUrl('https://gone.example/', web({ HEAD: 'throw', GET: 'throw' })), false);
  assert.equal(await verifyUrl('ftp://x.example/', web({ HEAD: 200, GET: 200 })), false);
  assert.equal(await verifyUrl('not a url', web({ HEAD: 200, GET: 200 })), false);
});

test('résumé text comes from the engine readers', () => {
  const pdf = resumeText(readFileSync(new URL('../src/demo/avery-quinn-resume.pdf', import.meta.url)), 'application/pdf');
  assert.ok(pdf.ok, pdf.ok ? '' : pdf.reason);
  assert.match(pdf.text, /Avery Quinn/);
  const txt = resumeText(Buffer.from('Avery Quinn\nBackend engineer\n'), 'text/plain');
  assert.ok(txt.ok && txt.text === 'Avery Quinn\nBackend engineer');
  const fake = resumeText(Buffer.from('not really a pdf'), 'application/pdf');
  assert.equal(fake.ok, false);
});

function fanfoldDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE jobs (canonical_id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, location TEXT, remote INTEGER,
      salary_min REAL, salary_max REAL, posted_at TEXT, ats TEXT, url TEXT, source_urls TEXT NOT NULL, description_hash TEXT, first_seen_at TEXT NOT NULL);
    CREATE TABLE applications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, worker_id TEXT, run_id TEXT, status TEXT NOT NULL, skip_reason TEXT,
      answers TEXT NOT NULL DEFAULT '[]', resume_document_id TEXT, cover_letter TEXT, match REAL, fit_note TEXT, url TEXT, confirmation TEXT,
      effect_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT);
  `);
  const job = db.prepare('INSERT INTO jobs (canonical_id, company, title, ats, url, source_urls, first_seen_at) VALUES (?,?,?,?,?,?,?)');
  job.run('j1', 'Glean', 'Product Manager, Agents', 'greenhouse', 'https://job-boards.greenhouse.io/gleanwork/jobs/1', '[]', '2026-11-01');
  job.run('j2', 'Orbit Labs', 'Senior Product Manager', null, 'https://careers.orbit.example/pm', '[]', '2026-11-01');
  job.run('j3', 'Skipped Co', 'Engineer', 'lever', 'https://jobs.lever.co/skip/1', '[]', '2026-11-01');
  const app = db.prepare('INSERT INTO applications (id, job_id, status, match, url, confirmation, created_at, updated_at, submitted_at) VALUES (?,?,?,?,?,?,?,?,?)');
  app.run('a1', 'j1', 'applied', '{"verdict":"fit","reasons":[],"at":"x","score":0.82}', null, 'Thanks, we got it', '2026-11-02', '2026-11-03', '2026-11-03T10:00:00Z');
  app.run('a2', 'j2', 'unconfirmed', null, 'https://careers.orbit.example/pm/apply', null, '2026-11-04', '2026-11-05', null);
  app.run('a3', 'j3', 'skipped', null, null, null, '2026-11-04', '2026-11-05', null);
  db.close();
}

test('Fanfold applications are read without writing to its database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tack-ff-'));
  try {
    const path = join(dir, 'agent.db');
    fanfoldDb(path);
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    const r = applications(path);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.equal(r.applications.length, 2);
    const [orbit, glean] = r.applications;
    assert.equal(glean.id, 'ff-a1');
    assert.equal(glean.origin, 'fanfold');
    assert.equal(glean.status, 'applied');
    assert.equal(glean.fit, 82);
    assert.equal(glean.source, 'greenhouse');
    assert.equal(glean.companySize, 'scaleup');
    assert.equal(glean.url, 'https://job-boards.greenhouse.io/gleanwork/jobs/1');
    assert.equal(glean.appliedAt, '2026-11-03T10:00:00Z');
    assert.equal(glean.roleFamily, 'ai');
    assert.match(glean.events[0].note, /Confirmation: Thanks/);
    assert.equal(orbit.url, 'https://careers.orbit.example/pm/apply');
    assert.equal(orbit.source, 'orbit');
    assert.equal(orbit.fit, 50);
    assert.equal(orbit.seniority, 'senior');
    assert.equal(orbit.companySize, 'unknown');
    assert.match(orbit.events[0].note, /no confirmation/);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fanfold applications are not available without a database', () => {
  assert.equal(applications(undefined).ok, false);
  assert.match((applications('/nonexistent/agent.db') as { reason: string }).reason, /no Fanfold database/);
  const dir = mkdtempSync(join(tmpdir(), 'tack-ff-'));
  try {
    const path = join(dir, 'other.db');
    new DatabaseSync(path).close();
    assert.match((applications(path) as { reason: string }).reason, /not a Fanfold database/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mail is off unless asked for, and replies map to companies and kinds', async () => {
  const saved = process.env.TACK_GMAIL;
  delete process.env.TACK_GMAIL;
  try {
    const r = await mailReplies(['Glean']);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /TACK_GMAIL=1/);
  } finally {
    if (saved !== undefined) process.env.TACK_GMAIL = saved;
  }
  assert.equal(companyOf(['Glean', 'Hevo Data'], { from: 'Talent <jobs@hevodata.example>', subject: 'Your application', snippet: '' }), 'Hevo Data');
  assert.equal(companyOf(['Glean'], { from: 'x@y.example', subject: 'Newsletter', snippet: '' }), null);
  assert.equal(replyKind('Interview with Glean', 'Please share your availability'), 'interview');
  assert.equal(replyKind('Your application', 'Unfortunately we will not be moving forward'), 'rejection');
  assert.equal(replyKind('Thanks for applying', 'We have received your application'), 'other');
  assert.equal(replyKind('Quick question', 'Could you tell us your notice period?'), 'reply');
});

test('apply is handed to Fanfold, not done here', async () => {
  const r = await apply('https://jobs.lever.co/x/1');
  assert.equal(r.ok, false);
});
