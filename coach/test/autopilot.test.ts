import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Posting } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-autopilot-'));
const store = await import('../src/store.ts');
const ap = await import('../src/autopilot.ts');
const queue = await import('../src/apply-queue.ts');

type Fns = import('../src/autopilot.ts').StepFns;

// A clock the test moves by hand.
function clock(start = '2026-11-21T09:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), add: (ms: number) => { t += ms; } };
}

function steps(over: Partial<Fns> = {}, log: string[] = []): Fns {
  const base = Object.fromEntries(ap.STEPS.map((s) => [s.name, async () => { log.push(s.name); return { note: `${s.name} ok`, data: { from: s.name } }; }])) as unknown as Fns;
  return { ...base, ...over };
}

test('a run goes through every step in order and stores each with its duration and outcome', async () => {
  store.clear();
  const c = clock();
  const log: string[] = [];
  const a = ap.createAutopilot({ now: c.now, steps: steps({ gap: async () => { log.push('gap'); c.add(1500); return { note: 'readiness 41', data: { after: 41 } }; } }, log) });
  const { run, done } = a.start('manual');
  assert.equal(run.status, 'running');
  const end = await done;
  assert.deepEqual(log, ap.STEPS.map((s) => s.name));
  assert.equal(end.status, 'done');
  assert.equal(end.steps.find((s) => s.name === 'gap')!.ms, 1500);
  assert.ok(end.steps.every((s) => s.status === 'done' && s.endedAt));
  assert.equal(ap.getRun(run.id)!.status, 'done', 'stored');
  assert.equal(store.get('single', 'autopilot-lock'), undefined, 'the lock is released');
});

test('never two runs at once: a second start is refused while one runs, here or under another process\'s live lock', async () => {
  store.clear();
  const c = clock();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = ap.createAutopilot({ now: c.now, steps: steps({ harvest: async () => { await gate; return { note: 'ok' }; } }) });
  const first = a.start('manual');
  assert.throws(() => a.start('schedule'), ap.BusyError);
  const other = ap.createAutopilot({ now: c.now, steps: steps(), owner: 'another-process' });
  assert.throws(() => other.start('manual'), ap.BusyError, 'the other process sees the live lock');
  release();
  await first.done;
  const again = a.start('manual');
  await again.done;
});

test('a failed step is recorded, its dependants are skipped, and the rest of the run carries on', async () => {
  store.clear();
  const log: string[] = [];
  const a = ap.createAutopilot({ now: clock().now, steps: steps({ gap: async () => { throw new Error('model unreachable'); } }, log) });
  const end = await a.start('manual').done;
  const st = Object.fromEntries(end.steps.map((s) => [s.name, s.status]));
  assert.equal(st.gap, 'failed');
  assert.equal(st.rank, 'skipped');
  assert.equal(st.kits, 'skipped');
  assert.equal(st.apply, 'skipped');
  assert.equal(st.mail, 'done');
  assert.equal(st.report, 'done');
  assert.equal(end.status, 'partial');
  assert.match(end.steps.find((s) => s.name === 'gap')!.note!, /model unreachable/);
  assert.ok(!log.includes('rank') && log.includes('mail'));
});

test('after a crash the run resumes from the step it was in; finished steps are not repeated', async () => {
  store.clear();
  const c = clock();
  // The first process dies in the middle of "apply": its promise never settles and its heartbeat stops.
  const crashed = ap.createAutopilot({ now: c.now, owner: 'dead', steps: steps({ apply: () => new Promise(() => {}) }) });
  const { run } = crashed.start('schedule');
  await new Promise((r) => setTimeout(r, 20));
  const mid = ap.getRun(run.id)!;
  assert.equal(mid.steps.find((s) => s.name === 'apply')!.status, 'running');
  assert.equal(mid.steps.find((s) => s.name === 'kits')!.status, 'done');

  const log: string[] = [];
  const fresh = ap.createAutopilot({ now: c.now, owner: 'restarted', steps: steps({}, log) });
  assert.equal(fresh.recover(), null, 'a lock with a live heartbeat is left alone');
  c.add(91_000);
  const resumed = fresh.recover();
  assert.ok(resumed);
  assert.equal(resumed.run.id, run.id);
  const end = await resumed.done;
  assert.deepEqual(log, ['apply', 'mail', 'replan', 'report'], 'carries on from apply');
  assert.equal(end.status, 'done');
  assert.equal(end.resumes, 1);
  assert.equal(end.steps.find((s) => s.name === 'apply')!.attempts, 2);
});

test('settings are validated field by field, merged over what is stored, and the cap stays under the hard maximum', () => {
  const s = ap.validateSettings({ on: true, intervalHours: 6, dailyCap: 8, minFit: 60, excludeRoles: 'intern, director', excludeCompanies: ['Acme', ' Acme '], quietHours: { from: '22:00', to: '07:00' } }, ap.DEFAULTS, new Date('2026-11-21T10:00:00Z'));
  assert.equal(s.on, true);
  assert.equal(s.onAt, '2026-11-21T10:00:00.000Z');
  assert.deepEqual(s.excludeRoles, ['intern', 'director']);
  assert.deepEqual(s.excludeCompanies, ['Acme']);
  assert.equal(s.needsApproval, false, 'fully automated by default');
  const bad = () => ap.validateSettings({ dailyCap: 16, intervalHours: 0, minFit: 'high', quietHours: { from: '25:00', to: '07:00' }, on: 'yes' });
  assert.throws(bad, (e: unknown) => {
    const p = (e as InstanceType<typeof ap.SettingsError>).problems;
    return ['dailyCap', 'intervalHours', 'minFit', 'quietHours', 'on'].every((k) => k in p) && /1 to 15/.test(p.dailyCap);
  });
  assert.throws(() => ap.validateSettings({ quietHours: { from: '08:00', to: '08:00' } }), ap.SettingsError);
  assert.equal(ap.validateSettings({ quietHours: null }, s).quietHours, null);
  assert.throws(() => ap.validateSettings('on'), ap.SettingsError);
});

test('the next run follows the interval, starts shortly after switching on, and never lands in quiet hours', () => {
  const s = ap.validateSettings({ on: true, intervalHours: 12 }, ap.DEFAULTS, new Date('2026-11-21T10:00:00'));
  assert.equal(ap.nextRunAt(s, undefined, new Date('2026-11-21T10:00:00'))!.getTime(), new Date('2026-11-21T10:02:00').getTime());
  const last = { startedAt: new Date('2026-11-21T10:05:00').toISOString() };
  assert.equal(ap.nextRunAt(s, last, new Date())!.getTime(), new Date('2026-11-21T22:05:00').getTime());
  const quiet = { ...s, quietHours: { from: '22:00', to: '07:30' } };
  assert.equal(ap.nextRunAt(quiet, last, new Date())!.getTime(), new Date('2026-11-22T07:30:00').getTime());
  assert.equal(ap.inQuiet(new Date('2026-11-21T23:10:00'), quiet.quietHours), true);
  assert.equal(ap.inQuiet(new Date('2026-11-21T12:00:00'), quiet.quietHours), false);
  assert.equal(ap.nextRunAt({ ...s, on: false }, last, new Date()), null);
});

test('picks respect the minimum fit, exclusions, closed postings and what was already applied to', () => {
  store.clear();
  const mk = (id: string, company: string, title: string, fit: number, extra: Partial<Posting> = {}): Posting => ({
    id, company, title, fit, location: 'Bengaluru', url: `https://jobs.example/${id}`, source: 'greenhouse', text: 'x', harvestedAt: '', live: true, ...extra,
  });
  const ps = [mk('a', 'Acme', 'AI Product Manager', 80), mk('b', 'Bolt', 'AI PM Intern', 90), mk('c', 'Crux', 'Product Manager', 40),
    mk('d', 'Dune', 'Product Manager, AI', 75, { closedAt: '2026-11-20T00:00:00Z' }), mk('e', 'Echo Inc.', 'AI Product Manager', 70), mk('f', 'Fern', 'AI Product Manager', 65)];
  for (const p of ps) store.put('posting', p.id, p);
  queue.enqueue([ps[5]], { source: 'manual' });
  const next = ps.map((p) => ({ postingId: p.id, title: p.title, company: p.company, fit: p.fit!, why: 'w', responseChance: 0.3 }));
  const s = { ...ap.DEFAULTS, minFit: 50, excludeRoles: ['intern'], excludeCompanies: ['echo'] };
  const picks = ap.choosePicks(next, new Map(ps.map((p) => [p.id, p])), s, 5);
  assert.deepEqual(picks.map((p) => p.postingId), ['a']);
  assert.equal(ap.choosePicks(next, new Map(ps.map((p) => [p.id, p])), { ...s, excludeCompanies: [] }, 5).length, 2);
  assert.equal(ap.choosePicks(next, new Map(ps.map((p) => [p.id, p])), { ...s, excludeCompanies: [] }, 1).length, 1, 'never past what is left of the cap');
});

test('a replan is called for by falling behind, a weak mock interview or an invitation, and not otherwise', () => {
  assert.equal(ap.replanReason({ onTrack: true, interviewAvg: 72, invites: 0 }), null);
  assert.match(ap.replanReason({ onTrack: false, interviewAvg: null, invites: 0 })!, /behind/);
  assert.match(ap.replanReason({ onTrack: true, interviewAvg: 41, invites: 0 })!, /scored 41/);
  assert.match(ap.replanReason({ onTrack: true, interviewAvg: null, invites: 2 })!, /2 interview invitations/);
});

test('a person without a profile, goal, contact details or résumé is told exactly what is missing', () => {
  const r = ap.readinessOf({ resume: false, model: true, consent: false, demo: false, details: { fullName: 'R', email: '' } });
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing.map((m) => m.key), ['profile', 'goal', 'details', 'resume']);
  assert.match(r.missing.find((m) => m.key === 'details')!.label, /email and phone/);
  assert.match(r.warnings[0], /stops before Submit/);
  const ok = ap.readinessOf({ profile: {} as never, goal: { targetRole: 'AI PM' } as never, details: { fullName: 'R', email: 'r@x.example', phone: '1234567' }, resume: true, model: true, consent: true, demo: false });
  assert.equal(ok.ready, true);
  assert.equal(ok.warnings.length, 0);
});

test('the report says in plain sentences what was read, applied to, heard and changed', () => {
  store.clear();
  const p: Posting = { id: 'a', company: 'Acme', title: 'AI PM', fit: 80, location: '', url: 'https://jobs.example/a', source: 'lever', text: '', harvestedAt: '', live: true };
  store.put('posting', p.id, p);
  const [job] = queue.enqueue([p], { source: 'autopilot' }).added;
  queue.markRunning(job.id, 'run-1');
  queue.settle(job.id, { kind: 'submitted', detail: 'Thanks for applying' });
  const r = ap.compileReport({
    harvest: { postings: 40, live: true, fresh: [{ company: 'Acme', title: 'AI PM' }], closed: [{ company: 'Old', title: 'PM' }] },
    gap: { before: 37, after: 39 },
    rank: { picks: [{ postingId: 'a', company: 'Acme', title: 'AI PM', fit: 80, why: 'fit 80' }] },
    mail: { result: { source: 'gmail', searched: 3, messages: 2, note: '2 new messages', changes: [{ company: 'Acme', from: 'applied', to: 'interview', subject: 'Chat?' }] } },
    replan: { changed: true, summary: 'behind the plan. 3 tasks rolled forward' },
  }, [], queue.allJobs());
  assert.match(r.summary, /Read 40 postings, 1 new, 1 closed\. Readiness 37 to 39\. Picked 1: 1 submitted\./);
  assert.equal(r.applied[0].state, 'submitted');
  assert.equal(r.replies!.changes[0].to, 'interview');
  assert.equal(r.plan!.changed, true);
});
