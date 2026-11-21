import { randomUUID } from 'node:crypto';
import { HttpError, type Router } from '../server.ts';
import * as store from '../store.ts';
import * as llm from '../llm.ts';
import * as trace from '../trace.ts';
import { canonical, PREREQS, skillId } from '../skills.ts';
import { postingFit, recompute, setStatus } from '../gap.ts';
import type {
  Application, AppStatus, GapMap, Goal, InterviewSession, Plan, PlanTask, PortfolioProject, Posting, Profile,
} from '../types.ts';
import {
  buildPlan, localDate, replan, setCheckpoint, setTaskStatus, skillMoves, startLevels, toIcs, withRaises, wordPlan,
  type Ask, type Raise, type StartLevels,
} from '../plan.ts';
import { buildPortfolio } from '../portfolio.ts';
import { judge, latestFinishedScore, makeQuestions, recordTurn, skillEffects, type SessionKind } from '../interview.ts';
import { insights, isResponse, markGhosted, mulberry32 } from '../tracker.ts';
import { brief, computeProgress } from '../progress.ts';
import { buildKit, cachedKit, KitError } from '../kit.ts';

const SINGLE = 'single';
const START_KIND = 'skillbase';
const APP_STATUSES: AppStatus[] = ['applied', 'viewed', 'reply', 'interview', 'offer', 'rejected', 'ghosted'];

const ask = (): Ask | null => (llm.configured() ? (llm.json as Ask) : null);
const today = () => localDate(new Date());

function must<T>(kind: string, id: string, message: string, status = 409): T {
  const v = store.get<T>(kind, id);
  if (!v) throw new HttpError(status, message);
  return v;
}

const getPlan = () => must<Plan>(SINGLE, 'plan', 'No plan yet. Build one from the gap map first.', 404);

function safeRecompute(): GapMap | undefined {
  try { return recompute(); } catch { return store.get<GapMap>(SINGLE, 'gap'); }
}

export function raiseLevels(raise: Raise): boolean {
  const profile = store.get<Profile>(SINGLE, 'profile');
  if (!profile || !Object.keys(raise).length) return false;
  const gap = store.get<GapMap>(SINGLE, 'gap');
  const names = new Map((gap?.skills ?? []).map((s) => [s.id, s.name]));
  for (const id of Object.keys(raise)) if (!names.has(id)) names.set(id, canonical(id).name);
  const out = withRaises(profile, raise, names, skillId);
  if (out.changed) store.put(SINGLE, 'profile', out.profile);
  return out.changed;
}

// Task, checkpoint and interview progress moves skills between open, learning and closed.
export function syncSkills(plan: Plan | undefined): GapMap | undefined {
  const gap = store.get<GapMap>(SINGLE, 'gap');
  if (!gap || !plan) return gap;
  const start = store.get<StartLevels>(START_KIND, 'start') ?? startLevels(gap);
  const moves = skillMoves(gap, plan, start);
  for (const [id, status] of Object.entries(moves.status)) setStatus(id, status);
  return raiseLevels(moves.raise) ? safeRecompute() : store.get<GapMap>(SINGLE, 'gap');
}

// Questions on a skill averaging above 4 of 5 raise that skill one level, up to what the role needs.
export function applyInterviewEffects(session: InterviewSession): string[] {
  const gap = store.get<GapMap>(SINGLE, 'gap');
  if (!gap) return [];
  const raise: Raise = {};
  for (const [id, delta] of Object.entries(skillEffects(session))) {
    const s = gap.skills.find((x) => x.id === id);
    if (!s || s.have >= s.need) continue;
    raise[id] = { level: Math.min(s.need, s.have + delta), evidence: `Scored above 4 of 5 on ${s.name} questions in a mock interview` };
  }
  if (raiseLevels(raise)) safeRecompute();
  return Object.keys(raise);
}

async function engine(): Promise<typeof import('../engine.ts') | null> {
  try { return await import('../engine.ts'); } catch { return null; }
}

function sessions(): InterviewSession[] {
  return store.list<InterviewSession>('interview').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function applications(now = new Date()): Application[] {
  const apps = store.list<Application>('application');
  for (const a of markGhosted(apps, now)) store.put('application', a.id, a);
  return apps.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

function fitOf(profile?: Profile) {
  return (p: Posting) => {
    if (p.fit != null) return p.fit;
    if (!profile) return 50;
    try { return postingFit(profile, p); } catch { return 50; }
  };
}

// Thompson draws seeded by the day and the data, so the ranking holds between refreshes
// and moves when a new application or reply arrives.
function dailyRng(apps: Application[]) {
  const key = `${today()}|${apps.length}|${apps.filter((a) => isResponse(a.status)).length}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0);
}

function trackerInsights() {
  const profile = store.get<Profile>(SINGLE, 'profile');
  const apps = applications();
  return insights(apps, store.list<Posting>('posting'), { fitOf: fitOf(profile), rng: dailyRng(apps) });
}

function progressNow() {
  return computeProgress({
    plan: store.get<Plan>(SINGLE, 'plan'), gap: store.get<GapMap>(SINGLE, 'gap'),
    readiness: store.list<{ at: string; value: number }>('readiness'), sessions: sessions(),
    applications: store.list<Application>('application'), now: new Date(),
    start: store.get<StartLevels>(START_KIND, 'start'),
  });
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

export function mount(r: Router): void {
  // ---- plan ----
  r.post('/plan/build', async () => {
    const gap = must<GapMap>(SINGLE, 'gap', 'Build the gap map before the plan.');
    const goal = must<Goal>(SINGLE, 'goal', 'Set a goal before building the plan.');
    const profile = store.get<Profile>(SINGLE, 'profile');
    const t = trace.run('plan');
    try {
      let plan = buildPlan({ gap, goal, prereqs: PREREQS });
      const hours = plan.weeks.reduce((a, w) => a + w.hours, 0);
      const skills = new Set(plan.weeks.flatMap((w) => w.skillIds)).size;
      t.step('allocate', `${plan.weeks.length} weeks, ${hours}h, ${skills} skills in priority and prerequisite order`);
      const eng = await engine();
      const live = eng ? await eng.available().catch(() => false) : false;
      const model = ask();
      t.step('wording', model ? 'writing task titles, checkpoints and resources' : 'model not configured, using built-in wording');
      const out = await wordPlan(plan, { gap, goal, profile, verify: live && eng ? (u) => eng.verifyUrl(u) : undefined }, model);
      if (out.error) t.step('wording', `model failed, kept built-in wording: ${out.error}`);
      plan = out.plan;
      store.put(SINGLE, 'plan', plan);
      store.put(START_KIND, 'start', startLevels(gap));
      syncSkills(plan);
      t.ok(`plan v${plan.version}: ${plan.weeks.reduce((a, w) => a + w.tasks.length, 0)} tasks`);
      return plan;
    } catch (e) {
      t.fail((e as Error).message);
      throw e;
    }
  });

  r.get('/plan', () => getPlan());

  r.patch('/plan/tasks/:id', ({ params, body }) => {
    const status = body?.status as PlanTask['status'];
    if (!['todo', 'done', 'skipped'].includes(status)) throw new HttpError(400, 'status must be todo, done or skipped');
    const plan = setTaskStatus(getPlan(), params.id, status, new Date().toISOString());
    if (!plan) throw new HttpError(404, `No task ${params.id}`);
    store.put(SINGLE, 'plan', plan);
    syncSkills(plan);
    return { plan, progress: progressNow() };
  });

  r.post('/plan/checkpoint/:week', ({ params, body }) => {
    const passed = body?.passed;
    if (passed !== true && passed !== false && passed !== null) throw new HttpError(400, 'passed must be true, false or null');
    const plan = setCheckpoint(getPlan(), Number(params.week), passed ?? undefined);
    if (!plan) throw new HttpError(404, `No week ${params.week}`);
    store.put(SINGLE, 'plan', plan);
    syncSkills(plan);
    return plan;
  });

  r.post('/plan/replan', ({ body }) => {
    if (body?.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 300)) throw new HttpError(400, 'reason must be text of 300 characters at most');
    const current = getPlan();
    const goal = must<Goal>(SINGLE, 'goal', 'Set a goal before replanning.');
    const since = current.changes[current.changes.length - 1]?.at ?? current.createdAt;
    const recent = sessions().filter((s) => s.finishedAt && s.finishedAt > since);
    const t = trace.run('replan');
    const plan = replan({
      plan: current, goal, today: today(), gap: store.get<GapMap>(SINGLE, 'gap'),
      reason: typeof body?.reason === 'string' ? body.reason : undefined, interviewAvg: latestFinishedScore(recent),
    });
    store.put(SINGLE, 'plan', plan);
    syncSkills(plan);
    const change = plan.changes[plan.changes.length - 1];
    t.ok(`v${plan.version}: ${change.summary}`);
    return plan;
  });

  r.get('/plan/calendar.ics', ({ res }) => {
    const ics = toIcs(getPlan());
    res.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'attachment; filename="tack-plan.ics"',
      'content-length': Buffer.byteLength(ics),
    });
    res.end(ics);
    return undefined;
  });

  // ---- portfolio ----
  r.post('/portfolio/build', async () => {
    const gap = must<GapMap>(SINGLE, 'gap', 'Build the gap map before the portfolio.');
    const t = trace.run('portfolio');
    t.step('select', 'three projects from the plan blocks, two or more open skills each');
    const out = await buildPortfolio({
      plan: store.get<Plan>(SINGLE, 'plan'), gap, postings: store.list<Posting>('posting'),
      goal: store.get<Goal>(SINGLE, 'goal'), profile: store.get<Profile>(SINGLE, 'profile'),
    }, ask());
    if (out.error) t.step('wording', `model failed, kept built-in briefs: ${out.error}`);
    for (const p of store.list<PortfolioProject>('portfolio')) store.del('portfolio', p.id);
    for (const p of out.projects) store.put('portfolio', p.id, p);
    t.ok(out.projects.map((p) => p.title).join(' / '));
    return out.projects;
  });

  r.get('/portfolio', () => store.list<PortfolioProject>('portfolio'));

  r.patch('/portfolio/:id', ({ params, body }) => {
    const p = must<PortfolioProject>('portfolio', params.id, `No project ${params.id}`, 404);
    const done = body?.deliverablesDone;
    if (body?.status === undefined && done === undefined) throw new HttpError(400, 'send status and/or deliverablesDone');
    if (body?.status !== undefined) {
      if (!['idea', 'building', 'shipped'].includes(body.status)) throw new HttpError(400, 'status must be idea, building or shipped');
      p.status = body.status;
    }
    if (done !== undefined) {
      if (!Array.isArray(done) || done.some((d: unknown) => typeof d !== 'string')) throw new HttpError(400, 'deliverablesDone must be an array of strings');
      // Only deliverables the project has, in the project's order.
      p.deliverablesDone = p.deliverables.filter((d) => done.includes(d));
    }
    store.put('portfolio', p.id, p);
    return p;
  });

  // ---- interviews ----
  r.post('/interviews', async ({ body }) => {
    const kind = (body?.kind ?? 'mixed') as SessionKind;
    if (!['behavioural', 'technical', 'case', 'mixed'].includes(kind)) throw new HttpError(400, 'kind must be behavioural, technical, case or mixed');
    const postings = store.list<Posting>('posting');
    let posting: Posting | undefined;
    if (body?.postingId) {
      posting = postings.find((p) => p.id === body.postingId);
      if (!posting) throw new HttpError(404, `No posting ${body.postingId}`);
    }
    const t = trace.run('interview');
    t.step('questions', posting ? `from ${posting.title} at ${posting.company}` : 'from the target postings and open gaps');
    const out = await makeQuestions({
      kind, posting, postings, gap: store.get<GapMap>(SINGLE, 'gap'),
      goal: store.get<Goal>(SINGLE, 'goal'), profile: store.get<Profile>(SINGLE, 'profile'),
    }, ask());
    if (out.error) t.step('questions', `model failed, using the question bank: ${out.error}`);
    const session: InterviewSession = {
      id: newId('iv'), kind, ...(posting ? { postingId: posting.id } : {}),
      questions: out.questions, turns: [], startedAt: new Date().toISOString(),
    };
    store.put('interview', session.id, session);
    t.ok(`${session.questions.length} questions`);
    return session;
  });

  r.post('/interviews/:id/answer', async ({ params, body }) => {
    const session = must<InterviewSession>('interview', params.id, `No interview ${params.id}`, 404);
    const question = session.questions.find((q) => q.id === body?.questionId);
    if (!question) throw new HttpError(400, 'questionId does not match a question in this session');
    const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
    if (!answer) throw new HttpError(400, 'answer is empty');
    if (answer.length > 8000) throw new HttpError(400, 'answer is too long (8000 characters max)');
    const gap = store.get<GapMap>(SINGLE, 'gap');
    const goal = store.get<Goal>(SINGLE, 'goal');
    const posting = session.postingId ? store.get<Posting>('posting', session.postingId) : undefined;
    const t = trace.run('interview');
    t.step('judge', `scoring the answer to ${question.id} on five criteria`);
    const out = await judge({ question, answer, targetRole: goal?.targetRole ?? 'product manager', posting, skills: gap?.skills }, ask());
    if (out.error) t.step('judge', `model failed, used the built-in rubric: ${out.error}`);
    const turn = { ...out.turn, at: new Date().toISOString() };
    const wasFinished = !!session.finishedAt;
    const next = recordTurn(session, turn);
    store.put('interview', next.id, next);
    if (next.finishedAt && !wasFinished) {
      const raised = applyInterviewEffects(next);
      t.step('effects', raised.length ? `raised ${raised.join(', ')}` : `session score ${next.score}`);
    }
    t.ok(`${question.id}: ${turn.overall} (${out.judged})`);
    return { turn, session: next };
  });

  r.get('/interviews', () => sessions());

  // ---- applications ----
  r.get('/applications', () => applications());

  r.post('/applications', ({ body }) => {
    const raw = (body ?? {}) as Record<string, unknown>;
    if (raw.url !== undefined && raw.url !== '' && (typeof raw.url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(raw.url.trim()))) {
      throw new HttpError(400, 'url must be an http or https address');
    }
    const short = (k: string, max: number) => {
      const v = raw[k];
      if (v === undefined) return undefined;
      if (typeof v !== 'string') throw new HttpError(400, `${k} must be a string`);
      if (v.length > max) throw new HttpError(400, `${k} is too long (${max} characters at most)`);
      return v.trim();
    };
    const b = {
      ...(raw as Partial<Application>),
      postingId: short('postingId', 120), title: short('title', 200), company: short('company', 160), url: short('url', 2000),
      roleFamily: short('roleFamily', 60), seniority: short('seniority', 60), companySize: short('companySize', 60), source: short('source', 60),
      appliedAt: short('appliedAt', 40),
    } as Partial<Application>;
    const posting = b.postingId ? store.get<Posting>('posting', b.postingId) : undefined;
    if (b.postingId && !posting) throw new HttpError(404, `No posting ${b.postingId}`);
    const title = b.title || posting?.title;
    const company = b.company || posting?.company;
    if (!title || !company) throw new HttpError(400, 'title and company are required (or a postingId)');
    const status = b.status && APP_STATUSES.includes(b.status) ? b.status : 'applied';
    const appliedAt = b.appliedAt && !Number.isNaN(Date.parse(b.appliedAt)) ? new Date(b.appliedAt).toISOString() : new Date().toISOString();
    const profile = store.get<Profile>(SINGLE, 'profile');
    const app: Application = {
      id: newId('app'), title, company,
      ...(posting ? { postingId: posting.id } : {}),
      url: b.url ?? posting?.url ?? '',
      roleFamily: b.roleFamily ?? posting?.roleFamily ?? 'unknown',
      seniority: b.seniority ?? posting?.seniority ?? 'unknown',
      companySize: b.companySize ?? posting?.companySize ?? 'unknown',
      source: b.source ?? posting?.source ?? 'manual',
      fit: Math.round(b.fit ?? (posting ? fitOf(profile)(posting) : 50)),
      appliedAt, status, lastEventAt: appliedAt,
      events: [{ at: appliedAt, kind: 'applied', note: 'Logged by hand' }],
      origin: b.origin === 'fanfold' ? 'fanfold' : 'manual',
    };
    if (status !== 'applied') app.events.push({ at: appliedAt, kind: status, note: 'Status set when logged' });
    store.put('application', app.id, app);
    return app;
  });

  r.patch('/applications/:id', ({ params, body }) => {
    const app = must<Application>('application', params.id, `No application ${params.id}`, 404);
    const status = body?.status as AppStatus;
    if (!APP_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${APP_STATUSES.join(', ')}`);
    if (body?.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) throw new HttpError(400, 'note must be text of 500 characters at most');
    const at = new Date().toISOString();
    app.status = status;
    app.lastEventAt = at;
    app.events.push({ at, kind: status, note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : `Marked ${status}` });
    store.put('application', app.id, app);
    return app;
  });

  r.post('/applications/sync', async () => {
    const eng = await engine();
    if (!eng) return { added: 0, updated: 0, note: 'The engine module could not load.', source: 'none', searched: 0, messages: 0, classified: {}, by: 'none', changes: [], ms: 0 };
    const t = trace.run('sync');
    let added = 0;
    // Applications a real Fanfold sent, read-only, when TACK_FANFOLD_DB points at one.
    if (process.env.TACK_FANFOLD_DB) {
      const apps = store.list<Application>('application');
      const postings = store.list<Posting>('posting');
      const profile = store.get<Profile>(SINGLE, 'profile');
      t.step('applications', 'reading applications Fanfold submitted');
      for (const rec of await eng.applications().catch(() => [] as Partial<Application>[])) {
        if (!rec?.company || !rec?.title) continue;
        const at = rec.appliedAt && !Number.isNaN(Date.parse(rec.appliedAt)) ? new Date(rec.appliedAt).toISOString() : new Date().toISOString();
        const known = apps.some((a) => (rec.url && a.url === rec.url) || (rec.postingId && a.postingId === rec.postingId)
          || (a.company.toLowerCase() === rec.company!.toLowerCase() && a.title.toLowerCase() === rec.title!.toLowerCase()));
        if (known) continue;
        const posting = postings.find((p) => (rec.postingId && p.id === rec.postingId) || (rec.url && p.url === rec.url));
        const app: Application = {
          id: newId('app'), title: rec.title, company: rec.company, ...(posting ? { postingId: posting.id } : {}),
          url: rec.url ?? posting?.url ?? '', roleFamily: rec.roleFamily ?? posting?.roleFamily ?? 'unknown',
          seniority: rec.seniority ?? posting?.seniority ?? 'unknown', companySize: rec.companySize ?? posting?.companySize ?? 'unknown',
          source: rec.source ?? posting?.source ?? 'fanfold', fit: Math.round(rec.fit ?? (posting ? fitOf(profile)(posting) : 50)),
          appliedAt: at, status: rec.status && APP_STATUSES.includes(rec.status) ? rec.status : 'applied', lastEventAt: rec.lastEventAt ?? at,
          events: rec.events?.length ? rec.events : [{ at, kind: 'applied', note: 'Submitted through Fanfold' }], origin: 'fanfold',
        };
        apps.push(app);
        store.put('application', app.id, app);
        added++;
      }
    }
    try {
      const res = await eng.checkMail((step, detail) => t.step(step, detail));
      t.ok(`${res.source === 'sample' ? 'sample mailbox: ' : ''}${res.note}`);
      return { ...res, added };
    } catch (e) {
      t.fail((e as Error).message);
      throw e;
    }
  });

  r.get('/tracker/insights', () => trackerInsights());

  // ---- progress ----
  r.get('/progress', () => progressNow());

  r.get('/brief', () => {
    const progress = progressNow();
    return brief({
      plan: store.get<Plan>(SINGLE, 'plan'), gap: store.get<GapMap>(SINGLE, 'gap'), goal: store.get<Goal>(SINGLE, 'goal'),
      progress, sessions: sessions(), insights: store.list<Application>('application').length || store.list<Posting>('posting').length ? trackerInsights() : undefined,
      now: new Date(),
    });
  });

  // ---- application kit ----
  const kitError = (e: unknown) => (e instanceof KitError ? new HttpError(e.status, e.message) : e);

  r.post('/kit/:postingId', async ({ params, query }) => {
    try {
      return await buildKit(params.postingId, { fresh: query.get('fresh') === '1', ask: ask() });
    } catch (e) {
      throw kitError(e);
    }
  });

  r.get('/kit/:postingId', ({ params }) => {
    const kit = cachedKit(params.postingId);
    if (!kit) throw new HttpError(404, `No application kit for ${params.postingId} yet`);
    return kit;
  });
}
