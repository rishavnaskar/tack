/**
 * One real learning cycle, measured end to end.
 *
 *   a run fails and recovers on the same page
 *     → the trajectory yields an eval case with ground truth in it
 *     → the reflector proposes lessons
 *     → the gate measures each against the suite and promotes or refuses
 *     → the same task is run again with whatever was promoted
 *
 * Every decision is the real model: what to do on the page, what to learn
 * from it, and — inside the gate — how it behaves on every suite case with
 * and without the candidate. The unit tests drive this pipeline with fakes;
 * this records what actually happens when it is driven for real.
 *
 * The PAGE is faked by default, for one measured reason: in the environment
 * this was built in a headless Chrome lives 0.6–1.1 seconds idle, and a model
 * call takes ~5 — so every action arrived at a dead browser. The fake models a
 * real fixture (test/fixtures/stuck.html) node for node, including what fails.
 * `--browser` runs the same cycle against that fixture in a real Chrome.
 *
 * Nothing here writes to the real state directory.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ModelClient, apiKeyFromEnv } from '../src/model/client.ts';
import { Store } from '../src/store/db.ts';
import { Memory } from '../src/memory/memory.ts';
import { runTask } from '../src/agent/loop.ts';
import { learnFromRuns } from '../src/agent/learn.ts';
import { deriveCasesFromRuns } from '../src/eval/derive-cases.ts';
import { launchChrome, type Launched } from '../src/cdp/launcher.ts';
import { Page } from '../src/observe/page.ts';
import { ResilientRuntime } from '../src/observe/resilient.ts';
import type { BrowserRuntime } from '../src/observe/runtime.ts';
import { startFixtureServer } from '../test/harness.ts';
import { FakeRuntime, ScriptedModel, action, type FakePage } from '../test/fakes.ts';
import { loadEnv } from '../src/lib/env.ts';

loadEnv();

const useBrowser = process.argv.includes('--browser');
const GOAL = 'Save the Senior AI Engineer role at Acme for later.';
const say = (s = ''): void => { process.stdout.write(s + '\n'); };

// stuck.html, as the serializer would report it. The obvious control is
// disabled and says so; the way forward is below a "scroll for more" hint.
// Clicking the disabled button fails exactly as the real one does.
const JOB = 'https://jobs.example/job/1';
const FAKE_PAGES: Record<string, FakePage> = {
  top: {
    url: JOB, title: 'Senior AI Engineer — Acme',
    nodes: [
      { ref: 'e1', role: 'heading', name: 'Senior AI Engineer — Acme', state: { level: 1 } },
      { ref: '', role: 'text', text: 'San Francisco · Hybrid · Posted 2 days ago' },
      { ref: 'e2', role: 'button', name: 'Save', state: { disabled: true }, evidence: { inputType: 'button' } },
      { ref: '', role: 'text', text: 'Scroll for more about this role' },
    ],
    failures: { 'click:e2': 'NOT_ACTIONABLE' },
    transitions: { 'scroll:': 'scrolled' },
  },
  scrolled: {
    url: JOB, title: 'Senior AI Engineer — Acme',
    nodes: [
      { ref: 'e1', role: 'heading', name: 'Senior AI Engineer — Acme', state: { level: 1 } },
      { ref: 'e2', role: 'button', name: 'Save', state: { disabled: true }, evidence: { inputType: 'button' } },
      { ref: 'e3', role: 'heading', name: 'About the role', state: { level: 2 } },
      { ref: '', role: 'text', text: 'Own the retrieval stack for a product used by 40,000 recruiters.' },
      { ref: 'e4', role: 'link', name: 'Add to saved roles',
        evidence: { href: '/roles.html', scheme: 'https', sameOrigin: true, destOrigin: 'https://jobs.example' } },
    ],
    failures: { 'click:e2': 'NOT_ACTIONABLE' },
    transitions: { 'click:e4': 'saved' },
  },
  saved: {
    url: 'https://jobs.example/roles.html', title: 'Saved roles',
    nodes: [
      { ref: 'e1', role: 'heading', name: 'Saved roles', state: { level: 1 } },
      { ref: '', role: 'text', text: 'Senior AI Engineer — Acme' },
    ],
  },
};

const dir = await mkdtemp(join(tmpdir(), 'ba-learn-cycle-'));
const db = new DatabaseSync(join(dir, 'agent.db'));
const store = new Store(db);
const memory = new Memory(db);
const model = new ModelClient({ apiKey: apiKeyFromEnv() });

let server: Awaited<ReturnType<typeof startFixtureServer>> | null = null;
let launched = null as Launched | null;
let page = null as Page | null;
let startUrl = JOB;
let runtime: BrowserRuntime;

if (useBrowser) {
  server = await startFixtureServer();
  startUrl = `${server.origin}/stuck.html`;
  runtime = new ResilientRuntime({
    create: async () => {
      await page?.close().catch(() => {});
      await launched?.close().catch(() => {});
      launched = await launchChrome({ profileDir: join(dir, 'profile'), headless: true });
      page = await Page.first(launched.client);
      return page;
    },
    maxReconnects: 40,
  });
}

/** A fresh page for every attempt, so one run's state cannot leak into the next. */
function freshRuntime(): BrowserRuntime {
  return useBrowser ? runtime : new FakeRuntime(structuredClone(FAKE_PAGES), 'top');
}

interface Attempt {
  runId: string; status: string; steps: number; failedSteps: number; costUsd: number;
  recovered: boolean; actions: string[];
}

function summarise(runId: string, status: string, costUsd: number): Attempt {
  const steps = store.steps(runId);
  const failed = steps.filter((s) => s.outcome === 'failed');
  const recovered = failed.some((f) =>
    steps.some((s) => Number(s.idx) > Number(f.idx) && s.outcome === 'ok' && s.url === f.url));
  return {
    runId, status, steps: steps.length, failedSteps: failed.length, costUsd, recovered,
    actions: steps.map((s) => {
      const a = JSON.parse(String(s.action ?? '{}')) as { kind?: string; ref?: string; value?: string };
      const tag = a.ref ? ` ${a.ref}` : a.value ? `(${a.value})` : '';
      return `${a.kind}${tag}→${s.outcome}${s.failure && s.outcome !== 'ok' ? `:${String(s.failure).split(/[:\s]/)[0]}` : ''}`;
    }),
  };
}

async function attempt(useMemory: boolean): Promise<Attempt> {
  const rt = freshRuntime();
  await rt.goto(startUrl);
  const before = model.totalCostUsd();
  const result = await runTask({
    goal: GOAL, page: rt, model, store, maxSteps: 8,
    memory: useMemory ? memory : undefined, taskType: '*',
  });
  return summarise(result.runId, result.status, model.totalCostUsd() - before);
}

function show(label: string, a: Attempt): void {
  say(`  ${label.padEnd(12)} ${a.status.padEnd(17)} steps=${a.steps} failed=${a.failedSteps} `
    + `$${a.costUsd.toFixed(5)}  ${a.actions.join('  ')}`);
}

const done = (a: Attempt): boolean => a.status === 'done';

try {
  say(`Mode: ${useBrowser ? 'real Chrome against test/fixtures/stuck.html' : 'faithful fake of stuck.html; real model throughout'}`);
  say();

  say('Phase A — a failure the agent then recovers from, made by the model itself');
  say('  the Save button is disabled; the working control is below a "scroll for more" hint');
  const naturals: Attempt[] = [];
  for (let i = 0; i < 4; i++) {
    const a = await attempt(false);
    naturals.push(a);
    show(`natural #${i + 1}`, a);
    if (a.recovered) break;
  }
  let sourceRun = naturals.find((a) => a.recovered)?.runId ?? null;
  let induced = false;

  if (!sourceRun) {
    // The model never made the mistake and recovered from it in one run, so
    // the rest of the cycle is fed a scripted first attempt on the SAME page.
    // Labelled as such in the summary.
    induced = true;
    say('  no natural failure-then-recovery in 4 runs; recording an induced one on the same page');
    const rt = freshRuntime();
    await rt.goto(startUrl);
    const obs = await rt.observe({ interactive: false });
    const save = obs.nodes.find((n) => n.role === 'button' && n.name === 'Save')!;
    const scripted = new ScriptedModel([
      action('click', { ref: save.ref! }),           // NOT_ACTIONABLE: disabled
      action('scroll', { amount: 600 }),
      action('done', { message: 'found the saved-roles link' }),
    ]);
    const r = await runTask({ goal: GOAL, page: rt, model: scripted, store, maxSteps: 6 });
    const a = summarise(r.runId, r.status, 0);
    show('induced', a);
    sourceRun = r.runId;
  }

  // Everything from phase A goes to the reflector, not only the recovery: an
  // induced run alone is three scripted steps with nothing to learn in them.
  // The lesson, if there is one, is in the contrast: runs that declared the
  // task done without doing anything next to the one that found the way forward.
  const evidence = [...naturals.map((a) => a.runId), sourceRun].filter((id, i, all) => all.indexOf(id) === i);
  const derived = deriveCasesFromRuns(store, evidence);
  say(`  runs handed to the reflector: ${evidence.length}; eval cases derived from them: ${derived.length}`);
  for (const c of derived) say(`    - "${c.name}" accepts ${JSON.stringify(c.accept)}`);
  say();

  say('Phase B — reflect on the run, then gate every proposal case by case');
  const learned = await learnFromRuns({ model, store, memory, runIds: evidence });
  say(`  proposed: ${learned.proposed.lessons} lesson(s), ${learned.proposed.skills} skill(s)`);
  if (learned.notes) say(`  reflector: ${learned.notes.slice(0, 220)}`);
  for (const g of learned.gated) {
    const l = memory.getLesson(g.id);
    say(`  [${g.status.toUpperCase()}] domain=${l?.domain} trigger="${l?.trigger.slice(0, 80)}"`);
    say(`      lesson: "${l?.lesson.slice(0, 160)}"`);
    say(`      gate:   ${g.why.slice(0, 260)}`);
  }
  for (const s of learned.skillsRejected) say(`  skill rejected: ${s.why.slice(0, 140)}`);
  const active = memory.lessonsByStatus('active');
  say(`  learning cost $${learned.costUsd.toFixed(5)}; active lessons afterwards: ${active.length}`);
  say();

  if (active.length) {
    say('Phase C — the same task, three runs without what was learned and three with');
  } else {
    // Nothing was promoted, so "with memory" recalls nothing. The two groups
    // below are the same treatment run twice, and the difference between them
    // is the model's own run-to-run variance — worth seeing, but not a
    // measurement of learning.
    say('Phase C — nothing was promoted, so both groups run WITHOUT a lesson; the gap between them is model variance');
  }
  const without: Attempt[] = [];
  const withLesson: Attempt[] = [];
  const withLabel = active.length ? 'with' : 'control';
  for (let i = 0; i < 3; i++) { const a = await attempt(false); without.push(a); show(`without #${i + 1}`, a); }
  for (let i = 0; i < 3; i++) { const a = await attempt(true); withLesson.push(a); show(`${withLabel} #${i + 1}`, a); }

  const avg = (xs: number[]): string => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  const line = (label: string, xs: Attempt[]): string =>
    `  ${label.padEnd(16)} done ${xs.filter(done).length}/${xs.length}   avg steps ${avg(xs.map((a) => a.steps))}   `
    + `avg failed steps ${avg(xs.map((a) => a.failedSteps))}   avg cost $${avg(xs.map((a) => a.costUsd))}`;
  say();
  say('Summary');
  say(`  failure source:  ${induced ? 'induced — a scripted first attempt on the same page' : 'natural — the model made the mistake and recovered on its own'}`);
  say(`  derived cases ${derived.length} · proposed ${learned.proposed.lessons} · promoted ${active.length} · `
    + `refused ${learned.gated.filter((g) => g.status === 'rejected').length} · unproven ${learned.gated.filter((g) => g.status === 'unproven').length}`);
  say(line('without lesson', without));
  say(line(active.length ? 'with lesson' : 'control (no lesson)', withLesson));
  say(`  model spend for the whole cycle: $${model.totalCostUsd().toFixed(5)}`);
} finally {
  await page?.close().catch(() => {});
  await launched?.close().catch(() => {});
  if (server) {
    (server.server as unknown as { destroyConnections?: () => void }).destroyConnections?.();
    server.server.close();
  }
  store.close();
  await rm(dir, { recursive: true, force: true });
}
