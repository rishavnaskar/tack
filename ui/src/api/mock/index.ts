import { ApiError, type Method, type Transport } from '../client';
import type {
  AppState,
  Application,
  GapMap,
  Goal,
  InterviewSession,
  InterviewTurn,
  Plan,
  PortfolioProject,
  Posting,
  Profile,
  TraceEvent,
} from '../types';
import {
  buildApplications,
  buildBrief,
  buildGap,
  buildInterviews,
  buildPlan,
  buildPortfolio,
  buildPostings,
  computeInsights,
  computeProgress,
  demoGoal,
  demoProfile,
  ROLE_SUGGESTIONS,
} from './fixtures';

/*
 * In-browser stand-in for the coach server. Enabled with VITE_MOCK=1 (npm run dev:mock).
 * State persists in localStorage so reloads keep your place.
 *
 * URL switches for checking states: ?mock=slow (2.5 s latency), ?mock=error (every GET
 * fails), ?mock=fresh (start from an empty store).
 */

interface Db {
  profile?: Profile;
  goal?: Goal;
  postings: Posting[];
  gap?: GapMap;
  plan?: Plan;
  portfolio: PortfolioProject[];
  interviews: InterviewSession[];
  applications: Application[];
}

const KEY = 'tack.mock.v1';
const empty = (): Db => ({ postings: [], portfolio: [], interviews: [], applications: [] });

const flags = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('mock') ?? '';

function load(): Db {
  if (flags.includes('fresh')) return empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...empty(), ...(JSON.parse(raw) as Db) };
  } catch {
    /* storage may be blocked */
  }
  return empty();
}

let db: Db = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* storage may be blocked */
  }
}

/* trace bus */
type Listener = (e: TraceEvent) => void;
const subs = new Set<Listener>();
let seq = 0;

export const bus = {
  subscribe(l: Listener) {
    subs.add(l);
    return () => subs.delete(l);
  },
  emit(run: string, step: string, detail: string, status: TraceEvent['status'] = 'ok', ms?: number) {
    const e: TraceEvent = { id: `m${++seq}`, at: new Date().toISOString(), run, step, detail, status, ms };
    subs.forEach((l) => l(e));
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.round(Math.random() * base * 0.6);

async function script(run: string, steps: [string, string, number][]) {
  const t0 = performance.now();
  bus.emit(run, run.split('-')[0], steps[0]?.[1] ?? '', 'start');
  for (const [step, detail, ms] of steps.slice(1)) {
    const d = jitter(ms);
    await sleep(d);
    bus.emit(run, step, detail, 'ok', d);
  }
  bus.emit(run, run.split('-')[0], 'done', 'ok', Math.round(performance.now() - t0));
}

function state(): AppState {
  return {
    mode: 'demo',
    engine: { available: false, note: 'Engine not attached. Postings come from the bundled sample.' },
    model: { configured: true, name: 'gemini-flash (mock)' },
    profile: db.profile,
    goal: db.goal,
    counts: { postings: db.postings.length, applications: db.applications.length, interviews: db.interviews.length },
    has: { gap: !!db.gap, plan: !!db.plan, portfolio: db.portfolio.length > 0 },
  };
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new ApiError(404, `No ${what} yet.`, what);
  return v;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function scoreAnswer(answer: string): InterviewTurn['scores'] {
  const words = answer.trim().split(/\s+/).length;
  const hasNumber = /\d/.test(answer);
  const hasI = /\bI\b/.test(answer);
  const base = Math.min(5, Math.max(1, Math.round(words / 25)));
  const firstClause = answer.split(/[.,;]/)[0]?.trim().slice(0, 80);
  return [
    { criterion: 'Structure', score: Math.min(5, base + (answer.includes('.') ? 1 : 0)), why: 'Situation, action and result are in order.', quote: firstClause },
    { criterion: 'Relevance to the role', score: Math.min(5, base + 1), why: 'Ties back to the kind of work the posting describes.' },
    { criterion: 'Depth', score: Math.max(1, base - 1), why: 'Name the hardest trade-off and what you decided.' },
    { criterion: 'Evidence and metrics', score: hasNumber ? 4 : 2, why: hasNumber ? 'Uses a number to show the result.' : 'Add one number that shows the result.' },
    { criterion: 'Clarity', score: hasI ? 4 : 3, why: hasI ? 'Clear about what you did yourself.' : 'Say "I" where you mean your own part.' },
  ];
}

type Handler = (params: string[], body: any) => Promise<unknown> | unknown;
const routes: [Method, RegExp, Handler][] = [];
const on = (method: Method, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:[a-z]+/gi, '([^/]+)')}$`), h]);

on('GET', '/state', () => state());

on('POST', '/demo/load', async () => {
  await script('demo-load', [
    ['demo', 'Avery Quinn snapshot', 0],
    ['load', 'profile and goal', 150],
    ['load', '40 postings', 180],
    ['load', 'gap map, plan and portfolio', 180],
    ['load', '2 interviews, 24 applications', 150],
  ]);
  const profile = demoProfile();
  const goal = demoGoal();
  const postings = buildPostings(profile);
  const gap = buildGap(postings, profile);
  db = {
    profile,
    goal,
    postings,
    gap,
    plan: buildPlan(goal),
    portfolio: buildPortfolio(),
    interviews: buildInterviews(),
    applications: buildApplications(),
  };
  save();
  return state();
});

on('POST', '/reset', () => {
  db = empty();
  save();
  return state();
});

on('POST', '/profile/resume', async (_p, body: { text?: string; pdfBase64?: string; filename?: string }) => {
  if (!body?.text?.trim() && !body?.pdfBase64) throw new ApiError(400, 'Send résumé text or a PDF.', '/profile/resume');
  if (body.text && body.text.trim().length < 40) throw new ApiError(422, 'That looks too short to be a résumé. Paste the whole thing.', '/profile/resume');
  await script('intake-1', [
    ['intake', body.filename ? `Reading ${body.filename}` : 'Reading pasted text', 0],
    ['llm', 'intake.profile · smart · not cached', 900],
    ['intake', '18 skills proposed', 250],
    ['intake', '16 kept with a quote from the résumé, 2 dropped', 300],
  ]);
  const profile = demoProfile(body.pdfBase64 ? 'pdf' : 'text');
  db.profile = profile;
  save();
  return profile;
});

on('PUT', '/profile', (_p, body: Profile) => {
  db.profile = body;
  save();
  return body;
});

on('PUT', '/goal', (_p, body: Goal) => {
  db.goal = body;
  save();
  return body;
});

on('POST', '/roles/suggest', async () => {
  need(db.profile, 'profile');
  await sleep(700);
  return { roles: ROLE_SUGGESTIONS };
});

on('POST', '/postings/harvest', async (_p, body: { count?: number }) => {
  const count = Math.min(40, body?.count ?? 40);
  const goal = db.goal ?? demoGoal();
  const postings = buildPostings(db.profile).slice(0, count);
  const reads: [string, string, number][] = postings
    .filter((_, i) => i % 3 === 0)
    .map((p, i) => ['read', `${Math.min(count, (i + 1) * 3)}/${count} ${hostOf(p.url)} · ${p.title}`, 140]);
  await script('harvest-1', [
    ['harvest', `${goal.targetRole} · ${goal.location}${goal.remote ? ' + remote' : ''} · ${count} postings`, 0],
    ['engine', 'Engine not attached; using the bundled sample', 300],
    ['search', `${new Set(postings.map((p) => p.company)).size} companies found`, 400],
    ...reads,
    ['dedupe', `${postings.length} unique postings`, 200],
  ]);
  db.postings = postings;
  save();
  return { postings, live: false };
});

on('GET', '/postings', () => db.postings);

on('POST', '/gap/build', async () => {
  const profile = need(db.profile, 'profile');
  if (!db.postings.length) throw new ApiError(409, 'Read the market first; there are no postings to compare against.', '/gap/build');
  const batches = Math.ceil(db.postings.length / 5);
  await script('gap-1', [
    ['gap', `${db.postings.length} postings against ${profile.skills.length} résumé skills`, 0],
    ...Array.from({ length: batches }, (_, i): [string, string, number] => ['extract', `batch ${i + 1}/${batches} · skills with must/nice and a quote`, 260]),
    ['normalise', '22 skills after aliases', 220],
    ['score', 'demand, need, have, priority', 260],
    ['bridge', '7 transferable skills found', 220],
  ]);
  const gap = buildGap(db.postings, profile);
  db.gap = gap;
  db.postings = buildPostings(profile).slice(0, db.postings.length);
  save();
  bus.emit('gap-1', 'readiness', `${gap.readiness} / 100`, 'ok');
  return gap;
});

on('GET', '/gap', () => need(db.gap, 'gap map'));

on('POST', '/plan/build', async () => {
  const goal = need(db.goal, 'goal');
  need(db.gap, 'gap map');
  await script('plan-1', [
    ['plan', `${goal.weeks} weeks at ${goal.hoursPerWeek} h`, 0],
    ['allocate', 'skills to weeks by priority', 400],
    ['llm', 'plan.tasks · smart', 1200],
    ['resources', 'search links built for 14 tasks', 300],
  ]);
  db.plan = buildPlan(goal);
  save();
  return db.plan;
});

on('GET', '/plan', () => need(db.plan, 'plan'));

on('PATCH', '/plan/tasks/:id', (p, body: { status: 'todo' | 'done' | 'skipped' }) => {
  const plan = need(db.plan, 'plan');
  const task = plan.weeks.flatMap((w) => w.tasks).find((t) => t.id === decodeURIComponent(p[0]));
  if (!task) throw new ApiError(404, 'No such task.', '/plan/tasks');
  task.status = body.status;
  task.doneAt = body.status === 'done' ? new Date().toISOString() : undefined;
  save();
  return { plan, progress: computeProgress(plan, db.gap, db.interviews) };
});

on('POST', '/plan/checkpoint/:week', (p, body: { passed: boolean }) => {
  const plan = need(db.plan, 'plan');
  const week = plan.weeks.find((w) => w.index === Number(p[0]));
  if (!week) throw new ApiError(404, 'No such week.', '/plan/checkpoint');
  week.checkpoint.passed = body.passed;
  save();
  return plan;
});

on('POST', '/plan/replan', async (_p, body: { reason?: string }) => {
  const plan = need(db.plan, 'plan');
  await script('replan-1', [
    ['replan', body?.reason ?? 'progress check', 0],
    ['roll', '2 late tasks moved forward', 300],
    ['balance', 'weeks 4 and 5 rebalanced to 10 h', 300],
  ]);
  const late = plan.weeks.flatMap((w) => w.tasks).filter((t) => t.status === 'todo').slice(0, 2);
  plan.version += 1;
  plan.changes.unshift({
    at: new Date().toISOString(),
    reason: body?.reason ?? 'Progress check',
    summary: `Moved ${late.length} late task${late.length === 1 ? '' : 's'} into next week and trimmed reading so each week stays inside 10 hours.`,
    moved: late.map((t) => t.id),
  });
  save();
  return plan;
});

on('GET', '/plan/calendar.ics', () => {
  const plan = need(db.plan, 'plan');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tack//Plan//EN'];
  for (const w of plan.weeks) {
    const d = w.startDate.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:week-${w.index}@tack.example`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:Week ${w.index}: ${w.theme}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
});

on('POST', '/portfolio/build', async () => {
  need(db.gap, 'gap map');
  await script('portfolio-1', [
    ['portfolio', 'three projects from open gaps', 0],
    ['llm', 'portfolio.projects · smart', 1400],
    ['link', 'tied to plan weeks and posting quotes', 300],
  ]);
  db.portfolio = buildPortfolio();
  save();
  return db.portfolio;
});

on('GET', '/portfolio', () => db.portfolio);

on('PATCH', '/portfolio/:id', (p, body: { status: PortfolioProject['status'] }) => {
  const project = db.portfolio.find((x) => x.id === decodeURIComponent(p[0]));
  if (!project) throw new ApiError(404, 'No such project.', '/portfolio');
  project.status = body.status;
  save();
  return project;
});

on('POST', '/interviews', async (_p, body: { kind: InterviewSession['kind']; postingId?: string }) => {
  await script('interview-1', [
    ['interview', `${body.kind} session`, 0],
    ['llm', 'interview.questions · smart', 1100],
  ]);
  const template = buildInterviews()[0];
  const session: InterviewSession = {
    id: `iv-${Date.now().toString(36)}`,
    kind: body.kind,
    postingId: body.postingId,
    questions: template.questions,
    turns: [],
    startedAt: new Date().toISOString(),
  };
  db.interviews.unshift(session);
  save();
  return session;
});

on('POST', '/interviews/:id/answer', async (p, body: { questionId: string; answer: string }) => {
  const session = db.interviews.find((s) => s.id === decodeURIComponent(p[0]));
  if (!session) throw new ApiError(404, 'No such session.', '/interviews');
  await script('score-1', [
    ['score', 'five criteria', 0],
    ['llm', 'interview.score · smart', 1300],
  ]);
  const scores = scoreAnswer(body.answer);
  const overall = Math.round((scores.reduce((a, s) => a + s.score, 0) / 25) * 100);
  const turn: InterviewTurn = {
    questionId: body.questionId,
    answer: body.answer,
    scores,
    overall,
    strengths: ['Answers the question that was asked'],
    fixes: ['Name one trade-off you made', 'End with the result and a number'],
    betterAnswer: `${body.answer.trim()} The hardest call was what to leave out; I chose to ship the smaller version first, and it moved the main metric within two weeks.`,
    followUp: 'What would you do differently next time?',
    at: new Date().toISOString(),
  };
  session.turns = [...session.turns.filter((t) => t.questionId !== body.questionId), turn];
  if (session.turns.length >= session.questions.length) {
    session.finishedAt = new Date().toISOString();
    session.score = Math.round(session.turns.reduce((a, t) => a + t.overall, 0) / session.turns.length);
  }
  save();
  return { turn, session };
});

on('GET', '/interviews', () => db.interviews);

on('GET', '/applications', () => db.applications);

on('POST', '/applications', (_p, body: Partial<Application>) => {
  const now = new Date().toISOString();
  const app: Application = {
    id: `a${Date.now().toString(36)}`,
    title: body.title ?? 'Untitled role',
    company: body.company ?? 'Unknown company',
    url: body.url ?? '',
    roleFamily: body.roleFamily ?? 'AI product',
    seniority: body.seniority ?? 'Mid',
    companySize: body.companySize ?? 'scaleup',
    source: body.source ?? 'manual',
    fit: body.fit ?? 50,
    appliedAt: body.appliedAt ?? now,
    status: body.status ?? 'applied',
    lastEventAt: now,
    events: [{ at: now, kind: 'applied', note: 'Added by hand' }],
    origin: 'manual',
    postingId: body.postingId,
  };
  db.applications.unshift(app);
  save();
  return app;
});

on('PATCH', '/applications/:id', (p, body: { status: Application['status']; note?: string }) => {
  const app = db.applications.find((a) => a.id === decodeURIComponent(p[0]));
  if (!app) throw new ApiError(404, 'No such application.', '/applications');
  const now = new Date().toISOString();
  app.status = body.status;
  app.lastEventAt = now;
  app.events.push({ at: now, kind: body.status, note: body.note ?? `Marked as ${body.status}` });
  save();
  return app;
});

on('POST', '/applications/sync', async () => {
  await script('sync-1', [
    ['sync', 'engine records and mail replies', 0],
    ['engine', 'Engine not attached; nothing to pull', 500],
  ]);
  return { added: 0, updated: 0 };
});

on('GET', '/tracker/insights', () => computeInsights(db.applications, db.postings));

on('POST', '/apply', () => ({
  started: false,
  note: 'Applying needs the engine. Start Tack in live mode to hand postings to the browser.',
}));

on('GET', '/progress', () => computeProgress(db.plan, db.gap, db.interviews));

on('GET', '/brief', () => buildBrief(db.plan, db.applications.length ? computeInsights(db.applications, db.postings) : undefined));

const clone = <T,>(v: T): T => (v === undefined || typeof v === 'string' ? v : JSON.parse(JSON.stringify(v)));

export function createMockTransport(): Transport {
  const latency = flags.includes('slow') ? 2500 : 220;
  return async (method, path, body) => {
    await sleep(method === 'GET' ? jitter(latency * 0.6) : jitter(latency));
    if (flags.includes('error') && method === 'GET' && path !== '/state') {
      throw new ApiError(500, `Mock error for GET ${path}`, path);
    }
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = path.match(re);
      if (match) return clone(await h(match.slice(1), clone(body)));
    }
    throw new ApiError(404, `No mock route for ${method} ${path}`, path);
  };
}
