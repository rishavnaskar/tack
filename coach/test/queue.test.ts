import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application, Posting } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-queue-'));
const store = await import('../src/store.ts');
const q = await import('../src/apply-queue.ts');

const mk = (id: string, company: string, title: string): Posting => ({
  id, company, title, location: 'Bengaluru', url: `https://jobs.example/${id}`, source: 'lever', text: '', harvestedAt: '', live: true, fit: 70,
});

test('never twice for the same posting, nor for the same company and title under another address', () => {
  store.clear();
  const a = mk('a', 'Acme, Inc.', 'AI Product Manager');
  const first = q.enqueue([a], { source: 'autopilot' });
  assert.equal(first.added.length, 1);
  assert.equal(q.enqueue([a], { source: 'manual' }).added.length, 0);
  const twin = mk('a2', 'ACME inc', 'AI  product manager');
  const again = q.enqueue([twin], { source: 'autopilot' });
  assert.equal(again.added.length, 0);
  assert.match(again.skipped[0].why, /already in the queue/);
  // An application logged by hand counts too.
  const app: Application = {
    id: 'x', title: 'Growth PM', company: 'Bolt', url: 'https://elsewhere.example', roleFamily: '', seniority: '', companySize: '', source: 'manual', fit: 50,
    appliedAt: '2026-11-01T00:00:00Z', status: 'applied', lastEventAt: '', events: [], origin: 'manual',
  };
  store.put('application', app.id, app);
  assert.match(q.duplicateOf(mk('b', 'Bolt', 'Growth PM'))!, /already applied to Growth PM at Bolt/);
  // A dry run is not an application and never blocks a real one.
  const dry = q.enqueue([mk('c', 'Crux', 'PM')], { source: 'manual', dryRun: true }).added[0];
  q.markRunning(dry.id, 'r');
  q.settle(dry.id, { kind: 'dry-run', detail: 'filled' });
  assert.equal(q.duplicateOf(mk('c', 'Crux', 'PM')), null);
});

test('failures map to the taxonomy by what the engine said', () => {
  const cases: [string, string][] = [
    ['A check on the page (a box to tick or a puzzle) is the user\'s to do', 'captcha'],
    ['The page shows a reCAPTCHA before the form', 'captcha'],
    ['The site wants me to sign in before applying', 'login-required'],
    ['Create an account to continue', 'login-required'],
    ['The form has a consent box: "I agree to the privacy notice"', 'consent-needed'],
    ['This was not submitted automatically because submitting without asking is off', 'consent-needed'],
    ['no reply within 120 s', 'timeout'],
    ['This job is no longer accepting applications', 'form-not-found'],
    ['Could not find the application form on this page', 'form-not-found'],
    ['The form asks "What is your expected CTC?"', 'answer-missing'],
    ['2 required fields are empty', 'answer-missing'],
    ['the browser window closed', 'site-error'],
  ];
  for (const [msg, want] of cases) assert.equal(q.classifyFailure(msg), want, msg);
  assert.equal(q.classifyFailure('ran on', 'step_limit'), 'timeout');
});

test('retryable failures come back after a growing wait; the rest wait on the person', () => {
  store.clear();
  const t0 = new Date('2026-11-21T09:00:00Z');
  const [job] = q.enqueue([mk('a', 'Acme', 'PM')], { source: 'autopilot', now: t0 }).added;
  q.markRunning(job.id, 'r1', t0);
  const one = q.settle(job.id, { kind: 'failed', reason: 'timeout', detail: 'no reply' }, t0)!;
  assert.equal(one.state, 'queued');
  assert.equal(Date.parse(one.nextAt) - t0.getTime(), q.backoffMs(1));
  assert.equal(q.dueJobs(t0).length, 0, 'not due yet');
  assert.equal(q.dueJobs(new Date(Date.parse(one.nextAt))).length, 1);
  q.markRunning(job.id, 'r2', t0);
  const two = q.settle(job.id, { kind: 'failed', reason: 'site-error', detail: 'crashed' }, t0)!;
  assert.equal(Date.parse(two.nextAt) - t0.getTime(), q.backoffMs(2));
  assert.ok(q.backoffMs(2) > q.backoffMs(1));
  q.markRunning(job.id, 'r3', t0);
  assert.equal(q.settle(job.id, { kind: 'failed', reason: 'timeout', detail: 'again' }, t0)!.state, 'failed', 'three tries and it stops');

  const [cap] = q.enqueue([mk('b', 'Bolt', 'PM')], { source: 'autopilot', now: t0 }).added;
  q.markRunning(cap.id, 'r', t0);
  assert.equal(q.settle(cap.id, { kind: 'failed', reason: 'captcha', detail: 'hCaptcha' }, t0)!.state, 'needs-you');
  assert.equal(q.backoffMs(9), 6 * 3_600_000, 'capped at six hours');
});

test('a question answered once is remembered and the job goes again; nothing else is touched', () => {
  store.clear();
  const [job] = q.enqueue([mk('a', 'Acme', 'PM')], { source: 'autopilot' }).added;
  q.markRunning(job.id, 'r1');
  q.settle(job.id, { kind: 'failed', reason: 'answer-missing', detail: 'asked', question: 'What is your expected CTC?' });
  assert.equal(q.needsYou().length, 1);
  assert.equal(q.needsYou()[0].question, 'What is your expected CTC?');
  assert.throws(() => q.answerJob(job.id, '   '), q.QueueError);
  const { job: next, remembered } = q.answerJob(job.id, '32 LPA');
  assert.equal(next.state, 'queued');
  assert.equal(next.answer, '32 LPA');
  assert.equal(remembered.question, 'What is your expected CTC?');
  assert.deepEqual(q.rememberedAnswers().map((r) => r.answer), ['32 LPA']);
  assert.equal(q.needsYou().length, 0);
  const [other] = q.enqueue([mk('b', 'Bolt', 'PM')], { source: 'manual' }).added;
  assert.throws(() => q.answerJob(other.id, 'x'), /not waiting on a question/);
});

test('a job running when Tack stopped is handed to the person, never retried blind', () => {
  store.clear();
  const [job] = q.enqueue([mk('a', 'Acme', 'PM')], { source: 'autopilot' }).added;
  q.markRunning(job.id, 'r1');
  const out = q.recoverInterrupted();
  assert.equal(out.length, 1);
  assert.equal(q.getJob(job.id)!.state, 'needs-you');
  assert.match(q.getJob(job.id)!.detail!, /may or may not have gone/);
  assert.equal(q.dueJobs().length, 0);
  assert.equal(q.retryJob(job.id).state, 'queued', 'the person can send it again');
  q.skipJob(q.enqueue([mk('z', 'Zed', 'PM')], { source: 'manual' }).added[0].id);
  assert.equal(q.allJobs().find((j) => j.postingId === 'z')!.state, 'skipped');
});

test('the daily count covers what the autopilot sent or is sending today', () => {
  store.clear();
  const now = new Date();
  const added = q.enqueue([mk('a', 'A', 'PM'), mk('b', 'B', 'PM'), mk('c', 'C', 'PM')], { source: 'autopilot', now }).added;
  q.markRunning(added[0].id, 'r', now);
  q.settle(added[0].id, { kind: 'submitted' }, now);
  q.markRunning(added[1].id, 'r', now);
  q.settle(added[1].id, { kind: 'failed', reason: 'captcha', detail: '' }, now);
  q.enqueue([mk('d', 'D', 'PM')], { source: 'manual', now });
  assert.equal(q.sentToday(now), 2, 'one submitted and one still queued; failures and manual jobs do not count');
});
