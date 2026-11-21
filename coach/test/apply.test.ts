import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Application, ApplyRun, Posting } from '../src/types.ts';

process.env.TACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'tack-apply-'));
process.env.TACK_UI_DIR = mkdtempSync(join(tmpdir(), 'tack-ui-missing-'));
const { createApp } = await import('../src/server.ts');
const { mount } = await import('../src/routes/c.ts');
const practice = await import('../src/practice.ts');
const apply = await import('../src/apply.ts');
const { parseOwnerUrl, childEnv, modelBase } = await import('../src/engine-proc.ts');
const { loadDemo } = await import('../src/demo/load.ts');
const store = await import('../src/store.ts');

const app = createApp();
mount(app.router);
await app.listen(0);
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
practice.setOwnBase(base);
after(() => app.close());

await loadDemo();
const posting = store.get<Posting>('posting', 'p05-orbitly')!;
const PDF = readFileSync(new URL('../src/demo/avery-quinn-resume.pdf', import.meta.url));

function filled(over: Record<string, unknown> = {}) {
  const qs = practice.screeningQuestions(posting);
  return {
    name: 'Avery Quinn', email: 'avery.quinn@mail.example', phone: '+91 98450 01234', location: 'Bengaluru',
    linkedin: 'https://www.linkedin.com/in/avery-quinn-example', workAuthorisation: practice.WORK_AUTH_OPTIONS[0],
    noticePeriod: 'Up to 30 days', consent: true,
    answers: qs.map((q) => ({ question: q.text, answer: `About ${q.id}` })),
    resume: { filename: 'avery-quinn-resume.pdf', mime: 'application/pdf', base64: PDF.toString('base64') },
    ...over,
  };
}

// ---------------------------------------------------------------- the practice form

test('the practice form names the posting and asks every field across three steps', async () => {
  const res = await fetch(`${base}/practice/apply/${posting.id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.ok(html.includes(`<h1>${posting.title}</h1>`));
  assert.ok(html.includes(posting.company));
  for (const id of ['name', 'email', 'phone', 'location', 'linkedin', 'resume', 'workAuthorisation', 'noticePeriod', 'q1', 'q2', 'consent']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('type="file"'));
  assert.equal((html.match(/<section data-step="/g) ?? []).length, 3);
  for (const q of practice.screeningQuestions(posting)) assert.ok(html.includes(q.text), q.text);
  assert.equal((await fetch(`${base}/practice/apply/nope`)).status, 404);
});

test('a submission is checked, stored with the résumé file, and answered with a confirmation page', async () => {
  const bad = await fetch(`${base}/api/practice/apply/${posting.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(filled({ consent: false })) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /consent/);
  const noFile = await fetch(`${base}/api/practice/apply/${posting.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(filled({ resume: null })) });
  assert.equal(noFile.status, 400);
  const odd = await fetch(`${base}/api/practice/apply/${posting.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(filled({ noticePeriod: 'whenever' })) });
  assert.equal(odd.status, 400);

  const res = await fetch(`${base}/api/practice/apply/${posting.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(filled()) });
  assert.equal(res.status, 200);
  const { ref, next } = await res.json() as { ref: string; next: string };
  assert.match(ref, /^TQ-[0-9A-F]{8}$/);
  const page = await (await fetch(`${base}${next}`)).text();
  assert.ok(page.includes('Application submitted'));
  assert.ok(page.includes(ref));

  const listed = await (await fetch(`${base}/api/practice/submissions?postingId=${posting.id}`)).json() as { ref: string; values: { email: string; consent: boolean }; resume: { size: number; base64?: string } }[];
  const mine = listed.find((s) => s.ref === ref)!;
  assert.equal(mine.values.email, 'avery.quinn@mail.example');
  assert.equal(mine.values.consent, true);
  assert.equal(mine.resume.size, PDF.length);
  assert.equal(mine.resume.base64, undefined, 'lists leave the file out');
  const file = Buffer.from(await (await fetch(`${base}/api/practice/submissions/${ref}/resume`)).arrayBuffer());
  assert.ok(file.equals(PDF), 'the stored résumé is the uploaded file, byte for byte');
});

// ---------------------------------------------------------------- readiness and the agent's brief

test('applying waits for a name, an email and a résumé, and says which is missing', () => {
  const keep = { d: apply.getDetails(), r: apply.getResume() };
  store.del('single', 'details');
  store.del('single', 'resume-file');
  const r = apply.readiness();
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ['full name', 'email', 'résumé']);
  assert.match(r.reason, /full name, email and résumé/);
  store.put('single', 'details', keep.d);
  store.put('single', 'resume-file', keep.r);
  assert.equal(apply.readiness().ready, true);
  assert.equal(apply.readiness(posting).target, 'practice');
});

test('the demo person and sample postings go to the practice form; a real person and a live posting go to the posting', () => {
  assert.equal(apply.targetFor(posting), 'practice');
  store.put('single', 'mode', 'live');
  const profile = store.get<{ source: string }>('single', 'profile')!;
  store.put('single', 'profile', { ...profile, source: 'pdf' });
  assert.equal(apply.targetFor({ ...posting, live: true }), 'live');
  assert.equal(apply.targetFor(posting), 'practice', 'a sample posting is never sent anywhere');
  store.put('single', 'profile', profile);
  store.put('single', 'mode', 'demo');
});

test('the brief stays under the engine\'s 4000-character limit and carries the live address', () => {
  const kit = { coverNote: 'x '.repeat(3000), talkingPoints: ['a '.repeat(800), 'b'], bullets: [], gapsToAddress: [] } as never;
  const answers = [{ question: 'Q1?', answer: 'y '.repeat(1000) }, { question: 'Q2?', answer: 'z '.repeat(1000) }];
  const goal = apply.goalFor({ posting: { ...posting, url: 'https://jobs.example/role/1', live: true }, url: 'https://jobs.example/role/1', target: 'live', details: apply.demoDetails(), answers, kit });
  assert.ok(goal.length <= apply.GOAL_MAX, `${goal.length}`);
  assert.ok(goal.includes('https://jobs.example/role/1'));
  assert.ok(goal.includes('avery.quinn@mail.example'));
  assert.match(goal, /press the final Submit/);
  const saved = apply.goalFor({ posting, url: practice.practiceUrl(posting.id), target: 'practice', details: apply.demoDetails(), answers, saved: true });
  assert.ok(!saved.includes('y y y'), 'answers saved in advance are not repeated');
});

test('progress lines become the steps a person reads', () => {
  const run = { steps: [], fields: 0 } as unknown as ApplyRun;
  for (const m of ['step 1: goto, open the form', 'step 2: upload, attach the résumé', 'step 3: fill, Fanfold fills this', 'step 4: select, notice',
    'step 5: click, Continue to the next step', 'step 6: type, answer', 'step 7: click, Submit the application', 'step 8: done']) apply.onProgress(run, m, 't');
  assert.deepEqual(run.steps.map((s) => s.label), [
    'Opened the application page', 'Found the application form', 'Uploaded the résumé', 'Filled 2 fields', 'Moved to the next step', 'Filled 3 fields', 'Pressed Submit',
  ]);
  assert.deepEqual(apply.parseRunResult('status: done\nsteps: 9, cost in USD: 0.0100\nSubmitted. Ref 12.'), { status: 'done', message: 'Submitted. Ref 12.' });
  assert.equal(apply.firstPerson('Experimentation: Built the flag service'), 'I built the flag service.');
  assert.equal(apply.letterBody('Hello team,\n\nI am applying.\n\nBest,\nAvery'), 'I am applying.');
});

// ---------------------------------------------------------------- batches, with the engine stubbed

const noop = {
  prepare: async () => [], open: async () => {}, run: async () => ({ status: 'done', message: '' }),
  shot: async () => undefined, close: async () => {}, end: async () => {},
};
const handle = { mode: 'own' as const, base: 'http://127.0.0.1:1', port: 1, ownerToken: 't', agentToken: 'a', stateDir: '/tmp/x', pid: 1, startedAt: '' };

test('a batch runs every posting at once, records what was confirmed, and one failure stops nothing else', async () => {
  const ids = ['p07-brightloop', 'p18-stackwise', 'p20-kitebird'];
  const postings = ids.map((id) => store.get<Posting>('posting', id)!);
  let live = 0;
  let peak = 0;
  const goals = new Map<string, string>();
  const prepared: string[] = [];
  const { batch, done } = apply.startBatch(postings, {
    engine: async () => handle,
    sync: async () => {},
    kit: async () => undefined,
    runner: async () => ({
      ...noop,
      prepare: async (job, answers) => { prepared.push(`${job.company}:${answers.length}`); return []; },
      run: async (session, goal, progress) => {
        goals.set(session, goal);
        live++;
        peak = Math.max(peak, live);
        progress('step 1: goto, open');
        await new Promise((r) => setTimeout(r, 30));
        live--;
        const p = postings.find((x) => goal.includes(x.company))!;
        if (p.id === 'p18-stackwise') throw new Error('the browser window closed');
        // The practice form keeps the proof: submit through it as the engine would.
        practice.acceptSubmission(p, { ...filled(), answers: practice.screeningQuestions(p).map((q) => ({ question: q.text, answer: 'x' })) });
        return { status: 'done', message: 'Application submitted.' };
      },
    }),
  });
  assert.equal(batch.runs.length, 3);
  assert.ok(batch.runs.every((r) => r.status === 'queued' && r.target === 'practice' && r.url.startsWith(`${base}/practice/apply/`)));
  assert.equal(new Set(batch.runs.map((r) => r.session)).size, 3, 'one engine session per posting');
  const end = await done;
  assert.equal(peak, 3, 'all three ran at the same time');
  assert.equal(prepared.length, 3);
  assert.ok(prepared.every((p) => p.endsWith(':3')), 'two answers and the consent box per form');
  const by = new Map(end.runs.map((r) => [r.postingId, r]));
  assert.equal(by.get('p18-stackwise')!.status, 'failed');
  assert.equal(by.get('p18-stackwise')!.reason, 'the browser window closed');
  for (const id of ['p07-brightloop', 'p20-kitebird']) {
    const r = by.get(id)!;
    assert.equal(r.status, 'applied', id);
    assert.match(r.reference!, /^TQ-/);
    assert.deepEqual(r.steps.map((s) => s.kind), ['open', 'confirm']);
    const a = store.get<Application>('application', r.applicationId!)!;
    assert.equal(a.status, 'applied');
    assert.equal(a.postingId, id);
    assert.match(a.events[0].note, /Practice application/);
  }
  assert.match(end.note!, /2 of 3 submitted/);
  assert.equal(apply.getBatch(batch.id)?.runs.length, 3);
});

test('a practice run with no submission on the form is a failure, whatever the agent says', async () => {
  const p = store.get<Posting>('posting', 'p11-nimbusnotes')!;
  const { done } = apply.startBatch([p], {
    engine: async () => handle, sync: async () => {}, kit: async () => undefined,
    runner: async () => ({ ...noop, run: async () => ({ status: 'done', message: 'All done!' }) }),
  });
  const end = await done;
  assert.equal(end.runs[0].status, 'failed');
  assert.match(end.runs[0].reason!, /All done/);
});

test('a live posting hands the real address to the engine; nothing is sent in this test', async () => {
  store.put('single', 'mode', 'live');
  const profile = store.get<{ source: string }>('single', 'profile')!;
  store.put('single', 'profile', { ...profile, source: 'pdf' });
  const p: Posting = { ...store.get<Posting>('posting', 'p03-paperkite')!, id: 'live-test', url: 'https://jobs.example/paperkite/ai-pm', live: true };
  store.put('posting', p.id, p);
  let goal = '';
  let prepared = -1;
  const { batch, done } = apply.startBatch([p], {
    engine: async () => handle, sync: async () => {}, kit: async () => undefined,
    runner: async () => ({
      ...noop,
      prepare: async (_job, answers) => { prepared = answers.length; return []; },
      run: async (_s, g) => { goal = g; return { status: 'failed', message: 'stopped before the form' }; },
    }),
  });
  assert.equal(batch.runs[0].target, 'live');
  assert.equal(batch.runs[0].url, 'https://jobs.example/paperkite/ai-pm');
  const end = await done;
  assert.ok(goal.startsWith('Apply to the AI Product Manager role at Paperkite and submit the application. Start here: https://jobs.example/paperkite/ai-pm'));
  assert.equal(prepared, 0, 'no answers are saved for a form Tack has not seen');
  assert.equal(end.runs[0].status, 'failed');
  store.put('single', 'profile', profile);
  store.put('single', 'mode', 'demo');
});

test('when the engine stops to ask for a yes the person already gave, Tack answers it once and the form goes', async () => {
  const p = store.get<Posting>('posting', 'p21-quillhealth')!;
  const goals: string[] = [];
  const closed: string[] = [];
  const { done } = apply.startBatch([p], {
    engine: async () => handle, sync: async () => {}, kit: async () => undefined,
    runner: async () => ({
      ...noop,
      close: async (s) => { closed.push(s); },
      run: async (_s, g) => {
        goals.push(g);
        if (goals.length === 1) return { status: 'awaiting_approval', message: 'The form is ready to submit. Shall I press Submit?' };
        practice.acceptSubmission(p, { ...filled(), answers: practice.screeningQuestions(p).map((q) => ({ question: q.text, answer: 'x' })) });
        return { status: 'done', message: 'Application submitted.' };
      },
    }),
  });
  const end = await done;
  assert.equal(end.runs[0].status, 'applied');
  assert.equal(goals.length, 2);
  assert.equal(goals[1], apply.FOLLOW_UP);
  assert.equal(closed.length, 1, 'the session is closed once, after the follow-up');
  assert.ok(end.runs[0].steps.some((s) => s.kind === 'note'));
  assert.equal(apply.waitsOnYes('failed', 'Shall I?'), false);
  assert.equal(apply.waitsOnYes('done', 'Application submitted. Reference TQ-1.'), false);
});

// ---------------------------------------------------------------- the engine process

test('the engine child gets its own state, no sign-in, Tack\'s model and full automation by default', () => {
  const env = childEnv('/s/engine', { PATH: '/bin', GEMINI_API_KEY: 'k', TACK_MODEL_FAST: 'm-fast', OPENROUTER_API_KEY: 'nope', GOOGLE_CLIENT_ID: 'g' });
  assert.equal(env.BROWSER_AGENT_STATE_DIR, '/s/engine');
  assert.equal(env.FANFOLD_AUTH, 'off');
  assert.equal(env.BROWSER_AGENT_APPROVALS, 'none');
  assert.equal(env.FANFOLD_MODEL_URL, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(env.FANFOLD_MODEL_KEY, 'k');
  assert.equal(env.FANFOLD_MODEL_PLAN, 'm-fast');
  assert.equal(env.GOOGLE_CLIENT_ID, 'g');
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(childEnv('/s', { TACK_APPROVALS: 'IRREVERSIBLE' }).BROWSER_AGENT_APPROVALS, 'IRREVERSIBLE');
  assert.equal(modelBase('https://x.example/v1/chat/completions'), 'https://x.example/v1');
  assert.deepEqual(parseOwnerUrl('\nFanfold\nhttp://127.0.0.1:51234/?t=abc123DEF\n'), { port: 51234, token: 'abc123DEF' });
  assert.equal(parseOwnerUrl('nothing here'), null);
});
