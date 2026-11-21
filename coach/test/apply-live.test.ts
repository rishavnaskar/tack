// Live forms: the check before a Submit, and a Submit that may have gone without a confirmation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application, FormInspection, Posting } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-live-'));
process.env.TACK_APPLY_STAGGER_MS = '0';
delete process.env.TACK_APPLY_DRY_RUN;
const store = await import('../src/store.ts');
const apply = await import('../src/apply.ts');
const queue = await import('../src/apply-queue.ts');

// An invented person.
const details = { fullName: 'Jun Okafor', email: 'jun.okafor@mail.example', phone: '+91 91234 56789', city: 'Chennai', linkedin: '', workAuthorisation: '', noticePeriod: '' };

function setup(id: string): Posting {
  store.put('single', 'profile', { name: 'Jun Okafor', headline: '', currentRole: 'Engineer', yearsExperience: 3, summary: '', skills: [], experience: [], education: [], projects: [], source: 'pdf' });
  apply.saveDetails(details);
  apply.saveResume({ filename: 'jun-okafor.pdf', mime: 'application/pdf', base64: 'JVBERi0=' });
  apply.setConsent(true);
  const p: Posting = { id, title: 'Platform Engineer', company: `Co ${id}`, location: 'Remote - India', url: `https://job-boards.greenhouse.io/co/jobs/${id}`, source: 'greenhouse', text: '', harvestedAt: '', live: true, fit: 60 };
  store.put('posting', p.id, p);
  return p;
}

const snapshot = (email: string, phone = '+91 91234 56789') => [
  '- textbox "First Name" [ref=e1] [required]: "Jun"',
  '- textbox "Last Name" [ref=e2] [required]: "Okafor"',
  `- textbox "Email" [ref=e3] [required]: "${email}"`,
  `- textbox "Phone" [ref=e4] [required]: "${phone}"`,
  '- button "Submit application" [ref=e9]',
].join('\n');
const complete = (raw: string): FormInspection & { raw: string } => ({ found: 5, filled: 5, unfilled: [], resume: true, required: 4, requiredLeft: [], fields: [], raw });

const noop = {
  prepare: async () => [], open: async () => {}, run: async () => ({ status: 'done', message: '' }),
  submit: async () => ({ pressed: false, held: 'not in this test', text: '' }), inspect: async () => undefined, release: async () => 0,
  shot: async () => undefined, close: async () => {}, end: async () => {},
};
const handle = { mode: 'own' as const, base: 'http://127.0.0.1:1', port: 1, ownerToken: 't', agentToken: 'a', stateDir: '/tmp/x', pid: 1, startedAt: '' };
const held = { status: 'awaiting_approval', message: '"Submit application" submits a job application. Needs your approval.' };

test('the check before Submit names what is wrong and never a value', () => {
  assert.equal(apply.preSubmitProblem(complete(snapshot('jun.okafor@mail.example')), details), null);
  assert.equal(apply.preSubmitProblem(complete(snapshot('JUN.OKAFOR@mail.example', '91234 56789')), details), null, 'case and a separate country code are fine');
  assert.match(apply.preSubmitProblem(complete(snapshot('someone@else.example')), details)!, /Email is not your email/);
  assert.match(apply.preSubmitProblem(complete(snapshot('jun.okafor@mail.example', '+1 555 0100 222')), details)!, /Phone is not your phone/);
  assert.match(apply.preSubmitProblem(complete(snapshot('N/A')), details)!, /placeholder/);
  assert.match(apply.preSubmitProblem({ ...complete(''), requiredLeft: ['Notice period'] }, details)!, /required and still blank: Notice period/);
  assert.match(apply.preSubmitProblem({ ...complete(''), resume: false }, details)!, /no résumé/);
  assert.match(apply.preSubmitProblem(undefined, details)!, /could not be read/);
  assert.ok(!apply.preSubmitProblem(complete(snapshot('someone@else.example')), details)!.includes('someone@else'));
});

test('a live form that fails the check is not submitted', async () => {
  const p = setup('chk1');
  let presses = 0;
  const { done } = apply.startBatch([p], {
    engine: async () => handle, sync: async () => {}, kit: async () => undefined,
    runner: async () => ({
      ...noop,
      run: async () => held,
      inspect: async () => complete(snapshot('someone@else.example')),
      submit: async () => { presses++; return { pressed: true, text: '' }; },
    }),
  });
  const end = await done;
  assert.equal(presses, 0);
  assert.equal(end.runs[0].status, 'failed');
  assert.match(end.runs[0].reason!, /Not submitted after checking the form: Email is not your email/);
});

test('a checked form is pressed; with no confirmation afterwards it is unconfirmed, waits on the person and is never retried', async () => {
  const p = setup('unc1');
  let presses = 0;
  const { batch, done } = apply.applyNow([p], {
    source: 'manual',
    deps: {
      engine: async () => handle, sync: async () => {}, kit: async () => undefined,
      runner: async () => ({
        ...noop,
        run: async (_s, goal) => (goal === apply.FOLLOW_UP ? { status: 'done', message: 'The page went blank after the click.' } : held),
        inspect: async () => complete(snapshot('jun.okafor@mail.example')),
        submit: async () => { presses++; return { pressed: true, text: 'Clicked.' }; },
      }),
    },
  }) as { batch: import('../src/types.ts').ApplyBatch; done: Promise<import('../src/types.ts').ApplyBatch> };
  const end = await done;
  const run = end.runs[0];
  assert.equal(presses, 1);
  assert.ok(run.steps.some((s) => /Checked the form before Submit/.test(s.label)));
  assert.equal(run.status, 'failed');
  assert.equal(run.unconfirmed, true);
  assert.match(run.reason!, /may have gone/);
  const job = queue.getJob(run.jobId!)!;
  assert.equal(job.state, 'needs-you');
  assert.equal(job.unconfirmed, true);
  assert.equal(store.list<Application>('application').filter((a) => a.postingId === p.id).length, 0, 'not recorded as an application without a confirmation');
  assert.equal(queue.dueJobs(new Date(Date.now() + 86_400_000)).length, 0, 'nothing comes round again');
  assert.match(queue.duplicateOf(p) ?? '', /waiting on you/, 'and it blocks a second application');
  assert.ok(batch);
});

test('a Submit the engine let through, then a timeout, is unconfirmed rather than queued to try again', async () => {
  const p = setup('unc2');
  const { done } = apply.applyNow([p], {
    source: 'autopilot',
    deps: {
      engine: async () => handle, sync: async () => {}, kit: async () => undefined,
      runner: async () => ({
        ...noop,
        run: async (_s, _g, progress) => { progress('step 1: goto, open'); progress('step 2: click, Submit application'); return { status: 'failed', message: 'Timed out waiting for the page.' }; },
      }),
    },
  }) as { done: Promise<import('../src/types.ts').ApplyBatch> };
  const end = await done;
  assert.equal(end.runs[0].unconfirmed, true);
  assert.equal(queue.getJob(end.runs[0].jobId!)!.state, 'needs-you');
});

test('a confirmed live Submit is recorded as applied, from the engine, for real', async () => {
  const p = setup('ok1');
  const { done } = apply.startBatch([p], {
    engine: async () => handle, sync: async () => {}, kit: async () => undefined,
    runner: async () => ({
      ...noop,
      run: async (_s, goal) => (goal === apply.FOLLOW_UP ? { status: 'done', message: 'Thank you for applying. Your application has been received.' } : held),
      inspect: async () => complete(snapshot('jun.okafor@mail.example')),
      submit: async () => ({ pressed: true, text: 'Clicked.' }),
    }),
  });
  const end = await done;
  assert.equal(end.runs[0].status, 'applied');
  assert.equal(end.runs[0].dryRun, undefined);
  const app = store.list<Application>('application').find((a) => a.postingId === p.id)!;
  assert.equal(app.status, 'applied');
  assert.equal(app.origin, 'fanfold');
});
