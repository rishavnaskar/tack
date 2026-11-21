/**
 * Routes for the job-search surfaces: workers, applications, profile, the
 * site catalog, playbooks and settings.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context.ts';
import { readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import { DEFAULT_CAPS, DEFAULT_DOCUMENTS, type WorkerDef, type WorkerDocuments, type WorkerSpec, type Autonomy } from '../../workers/worker.ts';
import type { WorkerSchedule } from '../../workers/schedule.ts';
import { APPLICATION_STATUSES, CLAIM_LAPSES_MS, postingKey, type Answer, type Application, type ApplicationRow, type ApplicationStatus } from '../../jobs/jobs.ts';
import { factClash, factProblems, LABELS, PROFILE_FIELDS, type ProfileField } from '../../jobs/profile.ts';
import { answerPlace } from '../../jobs/scope.ts';
import { classifyLocal, everyCompanyKey, fieldAsked, placeWords } from '../../jobs/intents.ts';
import { folded } from '../../jobs/wording.ts';
import type { Question } from '../../jobs/questions.ts';
import { suggestionFor } from '../../jobs/known.ts';
import { countryChoices, COPY as RIGHTS_COPY, defaultSponsorship, ELSEWHERE_VALUES, entryWords, readRights, readSponsorship, RIGHTS_INTENTS, RIGHTS_STATUSES, rightsKind, rightsProblems, SPONSORSHIP_VALUES, statusExpires, WITH_THE } from '../../jobs/work-rights.ts';
import { countryIn, countryOfPlace, FREE_MOVEMENT } from '../../jobs/countries.ts';
import { companyFromUrl } from '../../jobs/page-title.ts';
import { judgedAgain } from '../../jobs/fit.ts';
import { whenSaid } from '../../policy/recipient.ts';

/** Settings the UI may write. Anything else in the body is ignored. */
const SETTINGS = new Set(['contributeLessons', 'browserMode', 'submitWithoutAsking', 'mailCodes']);

/** What the person reads. */
export const COPY = {
  declinedSkip: 'you chose not to answer: {question}',
  noAnswer: 'There is no saved answer with that ID.',
  noDerived: 'Fanfold found no saved result with that ID.',
  tooLong: 'That {what} is {n} characters long. Keep it to {max} or fewer.',
  noDocuments: 'Import a résumé first, then Fanfold can read it.',
  cleared: '{fields} came from that answer, so it’s blank again.',
  rightsChoices: 'Fanfold keeps where you can work as choices. Pick the country and your status instead of typing an answer.',
};

/** The longest a saved question and answer may be. */
const MAX_QUESTION = 300;
const MAX_ANSWER = 4_000;

const UNHANDLED = Symbol('unhandled');

/** Where a job is still waiting in Review, or not yet started: what declining a question it needs takes out. */
const SKIPPABLE: ReadonlySet<ApplicationStatus> = new Set(['found', 'needs_review', 'prepared', 'queued']);

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleJobRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  return (await route(ctx, req, res, url)) !== UNHANDLED;
}

async function route(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void | typeof UNHANDLED> {
  if (url.pathname === '/api/workers' && req.method === 'POST') return await createWorker(ctx, req, res);
  const toggle = url.pathname.match(/^\/api\/workers\/([\w-]+)\/toggle$/);
  if (toggle && req.method === 'POST') return toggleWorker(ctx, res, toggle[1]);
  const tick = url.pathname.match(/^\/api\/workers\/([\w-]+)\/run$/);
  if (tick && req.method === 'POST') return runWorker(ctx, res, tick[1]);
  const stop = url.pathname.match(/^\/api\/workers\/([\w-]+)\/stop$/);
  if (stop && req.method === 'POST') {
    return sendJson(res, { stopped: ctx.app.stopWorker(stop[1]) });
  }
  if (url.pathname === '/api/workers/stop-all' && req.method === 'POST') {
    // Everything outbound, now: running workers stop and none starts again until resumed.
    const on = ctx.app.workers.list().filter((w) => w.enabled);
    for (const w of on) ctx.app.pauseWorker(w.id, 'stopped by you');
    const stopped = ctx.app.stopWorker();
    ctx.emit({ type: 'worker_changed' });
    // Requests waiting for the person stay: they send nothing until the person answers.
    return sendJson(res, { stopped, paused: on.length, waiting: ctx.app.approvals.pending().length });
  }
  if (url.pathname === '/api/workers' && req.method === 'GET') return sendJson(res, { workers: workersWithCounts(ctx) });
  if (url.pathname === '/api/workers/pause-all' && req.method === 'POST') {
    for (const w of ctx.app.workers.list()) if (w.status === 'active') ctx.app.pauseWorker(w.id);
    ctx.emit({ type: 'worker_changed' });
    return sendJson(res, { ok: true });
  }
  const workerRoute = url.pathname.match(/^\/api\/workers\/([\w-]+)$/);
  if (workerRoute && req.method === 'GET') return workerDetail(ctx, res, workerRoute[1]);
  if (workerRoute && req.method === 'PATCH') return await updateWorker(ctx, req, res, workerRoute[1]);
  if (workerRoute && req.method === 'DELETE') {
    const ok = ctx.app.removeWorker(workerRoute[1]);
    if (!ok) return sendJson(res, { error: 'no such worker' }, 404);
    ctx.emit({ type: 'worker_changed' });
    return sendJson(res, { deleted: true });
  }
  const enable = url.pathname.match(/^\/api\/workers\/([\w-]+)\/enable$/);
  if (enable && req.method === 'POST') {
    if (!ctx.app.workers.get(enable[1])) return sendJson(res, { error: 'no such worker' }, 404);
    const r = ctx.app.enableWorker(enable[1]);
    ctx.emit({ type: 'worker_changed' });
    return sendJson(res, { worker: r.worker, grantId: r.grantId });
  }
  const pause = url.pathname.match(/^\/api\/workers\/([\w-]+)\/pause$/);
  if (pause && req.method === 'POST') {
    if (!ctx.app.workers.get(pause[1])) return sendJson(res, { error: 'no such worker' }, 404);
    ctx.app.pauseWorker(pause[1]);
    ctx.emit({ type: 'worker_changed' });
    return sendJson(res, { worker: ctx.app.workers.get(pause[1]) });
  }

  // ---- applications
  if (url.pathname === '/api/applications' && req.method === 'GET') return applications(ctx, res, url);
  if (url.pathname === '/api/applications' && req.method === 'POST') return await addApplication(ctx, req, res);
  const appRoute = url.pathname.match(/^\/api\/applications\/([\w-]+)$/);
  if (appRoute && req.method === 'PATCH') return await updateApplication(ctx, req, res, appRoute[1]);

  // ---- profile, answers
  if (url.pathname === '/api/profile' && req.method === 'GET') return sendJson(res, await profileView(ctx));
  if (url.pathname === '/api/profile' && req.method === 'PUT') {
    const body = await readBody(req, Bodies.Profile);
    // Every value that cannot be its fact is named at once, each beside its own field, and nothing is saved.
    const problems = factProblems(body.fields ?? {});
    const first = Object.keys(problems)[0];
    if (first) return sendJson(res, { error: problems[first], field: first, problems }, 400);
    ctx.app.profile.set(body.fields ?? {}, { confirmed: true });
    ctx.emit({ type: 'profile_changed' });
    ctx.emit({ type: 'setup_changed' });
    const clash = factClash(ctx.app.profile.fact('noticePeriod')?.value, ctx.app.profile.fact('earliestStart')?.value);
    return sendJson(res, { ...await profileView(ctx), ...(clash ? { warning: clash } : {}) });
  }
  if (url.pathname === '/api/profile/extract' && req.method === 'POST') return await extractProfile(ctx, res);
  // Where the person may work: the whole list from Setup and Profile, or one country from the answer dialog.
  if (url.pathname === '/api/profile/rights' && req.method === 'PUT') {
    const body = await readBody(req, Bodies.Rights);
    const entries = body.entries ?? [];
    // Every part that cannot be saved is named at once, each beside its own field, and nothing is saved.
    const problems = rightsProblems(entries);
    const first = Object.keys(problems)[0];
    if (first) return sendJson(res, { error: problems[first], field: first, problems }, 400);
    ctx.app.profile.rights.save(entries, body.elsewhere ?? null);
    ctx.emit({ type: 'profile_changed' });
    ctx.emit({ type: 'setup_changed' });
    return sendJson(res, await profileView(ctx));
  }
  if (url.pathname === '/api/profile/rights' && req.method === 'POST') {
    const body = await readBody(req, Bodies.RightsEntry);
    const problems = Object.fromEntries(Object.entries(rightsProblems([body.entry])).map(([k, v]) => [k.replace(/^entries\.0\./, ''), v]));
    const first = Object.keys(problems)[0];
    if (first) return sendJson(res, { error: problems[first], field: first, problems }, 400);
    const saved = ctx.app.profile.rights.put(body.entry, 'you', body.elsewhere ?? undefined);
    // Opened from a saved answer: the choice takes its place, so the bank does not hold both.
    if (body.replacesAnswer) ctx.app.profile.deleteAnswer(body.replacesAnswer);
    ctx.emit({ type: 'profile_changed' });
    ctx.emit({ type: 'setup_changed' });
    return sendJson(res, { entry: saved, words: `${saved.country === FREE_MOVEMENT ? RIGHTS_COPY.freeMovementArea : saved.country}: ${entryWords(saved)}` });
  }
  if (url.pathname === '/api/answers' && req.method === 'POST') {
    const body = await readBody(req, Bodies.Answer);
    for (const [field, what, max] of [['question', 'question', MAX_QUESTION], ['answer', 'answer', MAX_ANSWER]] as const) {
      const n = (body[field] ?? '').trim().length;
      if (n > max) return sendJson(res, { error: COPY.tooLong.replace('{what}', what).replace('{n}', n.toLocaleString('en')).replace('{max}', max.toLocaleString('en')), field }, 400);
    }
    // Where they may work is kept as choices: a typed sentence is taken only when it reads plainly as them.
    if (!choiceForRights(ctx, body.question ?? '', body.answer ?? '')) return sendJson(res, { error: COPY.rightsChoices, field: 'answer', rights: true }, 400);
    try {
      const a = ctx.app.profile.addAnswer(body.question ?? '', body.answer ?? '', 'you');
      ctx.emit({ type: 'profile_changed' });
      return sendJson(res, a);
    } catch (err) {
      return sendJson(res, { error: (err as Error).message }, 400);
    }
  }
  const answerRoute = url.pathname.match(/^\/api\/answers\/(\d+)$/);
  if (answerRoute && req.method === 'DELETE') {
    // A fact the answer set goes with it, and the page says so.
    const cleared = ctx.app.profile.deleteAnswer(Number(answerRoute[1]));
    ctx.emit({ type: 'profile_changed' });
    if (cleared.length) ctx.emit({ type: 'setup_changed' });
    const fields = cleared.map((f) => LABELS[f]).join(' and ');
    return sendJson(res, { deleted: true, cleared, ...(cleared.length ? { note: COPY.cleared.replace('{fields}', fields) } : {}) });
  }
  // An answer an agent saved becomes the owner's, word for word, under the same question and job.
  const confirmRoute = url.pathname.match(/^\/api\/answers\/(\d+)\/confirm$/);
  if (confirmRoute && req.method === 'POST') {
    const a = ctx.app.profile.answers(1000).find((x) => x.id === Number(confirmRoute[1]));
    if (!a) return sendJson(res, { error: COPY.noAnswer }, 404);
    const saved = ctx.app.profile.addAnswer(a.question, a.answer, 'you', { key: a.questionNorm, jobId: a.jobId });
    ctx.emit({ type: 'profile_changed' });
    return sendJson(res, saved);
  }
  // What Fanfold worked out, taken back: a form that reports it again is shown to the owner as a draft.
  const derivedRoute = url.pathname.match(/^\/api\/derived\/(\d+)$/);
  if (derivedRoute && req.method === 'DELETE') {
    // Kept as the owner's refusal: the same answer is not worked out again for that question, which goes to them instead.
    if (!ctx.app.profile.forgetDerived(Number(derivedRoute[1]), 'user')) return sendJson(res, { error: COPY.noDerived }, 404);
    ctx.emit({ type: 'profile_changed' });
    return sendJson(res, { deleted: true });
  }
  // Only the owner's key reaches here: an agent can ask the user, never answer for them.
  const questionRoute = url.pathname.match(/^\/api\/questions\/(\d+)\/(answer|decline)$/);
  if (questionRoute && req.method === 'POST') return await answerQuestion(ctx, req, res, Number(questionRoute[1]), questionRoute[2]);

  // ---- site catalog, playbooks, settings, browser
  if (url.pathname === '/api/sites' && req.method === 'GET') return sendJson(res, { sites: ctx.app.sites.list() });
  const siteRoute = url.pathname.match(/^\/api\/sites\/([\w-]+)$/);
  if (siteRoute && req.method === 'PATCH') {
    const body = await readBody(req, Bodies.SitePosture);
    const hasCap = body.dailyCap !== undefined;
    if (!(hasCap && body.submit === undefined) && !['auto', 'prepare', 'never'].includes(body.submit ?? '')) {
      return sendJson(res, { error: 'submit must be auto, prepare or never' }, 400);
    }
    if (!ctx.app.sites.get(siteRoute[1])) return sendJson(res, { error: 'no such site' }, 404);
    try {
      if (body.submit !== undefined) ctx.app.sites.setSubmit(siteRoute[1], body.submit, { acceptedTerms: body.acceptTerms === true });
    } catch (err) {
      return sendJson(res, { error: (err as Error).message }, 400);
    }
    if (hasCap) ctx.app.sites.setDailyCap(siteRoute[1], body.dailyCap!);
    return sendJson(res, { site: ctx.app.sites.get(siteRoute[1]) });
  }
  if (url.pathname === '/api/playbooks' && req.method === 'GET') return sendJson(res, playbooks(ctx));
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req, Bodies.Settings);
    for (const [k, v] of Object.entries(body)) {
      if (k === 'browserMode') await ctx.app.setBrowserMode(v === 'extension' || v === 'auto' ? v : 'dedicated');
      else if (SETTINGS.has(k)) ctx.app.store.setSetting(k, v);
    }
    return sendJson(res, settingsView(ctx));
  }
  if (url.pathname === '/api/browser/open' && req.method === 'POST') {
    const body = await readBody(req, Bodies.OpenUrl);
    if (!/^https?:\/\//.test(body.url ?? '')) return sendJson(res, { error: 'an http(s) url is required' }, 400);
    try {
      // A form the agent filled is still open on its own tab. Bring that tab
      // forward: loading the address again would throw the filled form away.
      const runId = body.applicationId ? ctx.app.jobs.application(body.applicationId)?.runId : null;
      const kept = (body.applicationId ? ctx.app.applicationPage(body.applicationId) : null)
        ?? (runId && ctx.app.parkedRuns().includes(runId) ? ctx.app.pageForRun(runId) : null);
      if (kept) {
        await kept.focus?.();
        return sendJson(res, { opened: body.url, kept: true });
      }
      const page = await ctx.app.startBrowser();
      await page.goto(body.url!);
      // Opened for the person to use: it stays a while, rather than closing once nothing of Fanfold's has used it for a minute.
      ctx.app.keepMain(15 * 60_000);
      return sendJson(res, { opened: body.url, kept: false });
    } catch (err) {
      return sendJson(res, { error: (err as Error).message }, 502);
    }
  }
  return UNHANDLED;
}

export function workersWithCounts(ctx: RouteContext): Array<WorkerDef & Record<string, unknown>> {
  const dayStart = new Date(startOfToday());
  const running = new Set(ctx.app.activeWorkerRuns().map((r) => r.workerId));
  return ctx.app.workers.list().map((w) => {
    const funnel = ctx.app.jobs.funnel(w.id);
    const today = todayCounts(ctx, w.id);
    return {
      ...w,
      recentRuns: ctx.app.workers.runs(w.id, 3),
      running: running.has(w.id),
      // What its daily cap counts: sent today, confirmed or not.
      sentToday: ctx.app.jobs.submittedSince(w.id, dayStart),
      appliedToday: today.applied,
      skippedToday: today.skipped,
      toReview: funnel.needs_review + funnel.prepared + funnel.unconfirmed,
      skipped: funnel.skipped,
      applied: funnel.applied,
      grant: ctx.app.capabilities.list().find((c) => c.workerId === w.id) ?? null,
    };
  });
}

/** Midnight today, local time, in the form the ledger writes times. */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Applied and skipped today, for one worker or for all: the same words mean the same count everywhere. */
export function todayCounts(ctx: RouteContext, workerId?: string): { applied: number; skipped: number } {
  const start = startOfToday();
  const mine = workerId ? ' AND worker_id = ?' : '';
  const args = workerId ? [start, workerId] : [start];
  const count = (sql: string): number => Number((ctx.app.store.raw.prepare(sql + mine).get(...args) as { n: number }).n);
  return {
    applied: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'applied' AND submitted_at >= ?"),
    skipped: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'skipped' AND updated_at >= ?"),
  };
}

/**
 * What waits on the owner, counted once on the server so the nav badge, the
 * Review header and the side panel cannot disagree. Questions are counted as
 * Review shows them: one row for one question, however many jobs ask it.
 */
export interface Attention {
  questions: number;
  approvals: number;
  /** Applications that need a decision, a Submit press, or a check; jobs started and not finished among them. */
  applications: number;
  /** Approved by the owner, and being sent now: nothing to do but wait. */
  submitting: number;
  /** Queued jobs nobody is working on any more, past the claim lapse: resume or drop. */
  started: number;
  /** Files an agent added, waiting for the owner's OK. */
  files: number;
  /** Actions a run attempted and never confirmed. */
  unconfirmedActions: number;
  total: number;
}

/**
 * Where a queued job stands: `sending`, approved by the owner and being
 * carried out now; `working`, claimed by a run or session still at it or
 * waiting on the owner's approval; `started`, claimed and left past the
 * claim lapse, with nothing waiting on it.
 */
export type QueuedState = 'sending' | 'working' | 'started';

export function queuedStates(ctx: RouteContext, now = Date.now()): (a: Application & { job?: { url?: string | null; sourceUrls: string[] } }) => QueuedState {
  const sending = new Set([...ctx.app.submissions.status().running, ...ctx.app.submissions.status().waiting]);
  const pending = ctx.app.approvals.pending();
  const runs = new Set(pending.map((p) => p.runId));
  const postings = new Set(pending.map((p) => postingKey(p.url)).filter(Boolean));
  return (a) => {
    if (sending.has(a.id)) return 'sending';
    const waits = (!!a.runId && runs.has(a.runId)) || [a.url, a.job?.url, ...(a.job?.sourceUrls ?? [])].some((u) => postings.has(postingKey(u)));
    return !waits && now - Date.parse(a.updatedAt) > CLAIM_LAPSES_MS ? 'started' : 'working';
  };
}

/** `groups` when the caller already has them, so one state read groups the questions once. */
export function attentionView(ctx: RouteContext, groups?: Array<{ questionIds: number[] }>): Attention {
  const f = ctx.app.jobs.funnel();
  const questions = (groups ?? questionGroups(ctx, ctx.app.questions.list('open', 500)).groups).reduce((n, g) => n + g.questionIds.length, 0);
  const approvals = ctx.app.approvals.pending().length;
  const state = queuedStates(ctx);
  const queuedRows = f.queued ? ctx.app.jobs.list({ status: 'queued', limit: 500 }) : [];
  const queued = queuedRows.map(state);
  const started = queued.filter((q) => q === 'started').length;
  // Each job once, however many rows it has: by its id, and a row with no address by its company and title.
  const waiting = [...ctx.app.jobs.list({ status: ['needs_review', 'prepared', 'unconfirmed'], limit: 2000 }), ...queuedRows.filter((_, i) => queued[i] === 'started')];
  const named = (r: ApplicationRow): string => `${r.job.company.trim().toLowerCase()}|${r.job.title.trim().toLowerCase()}`;
  const addressed = (r: ApplicationRow): boolean => !!(r.url || r.job.url || r.job.sourceUrls.length);
  const jobOfName = new Map(waiting.filter(addressed).map((r) => [named(r), r.jobId]));
  const applications = new Set(waiting.map((r) => (addressed(r) ? r.jobId : jobOfName.get(named(r)) ?? r.jobId))).size;
  return {
    questions, approvals, applications, submitting: queued.filter((q) => q === 'sending').length, started,
    files: ctx.app.memory.listDocuments({ includeHeld: true }).filter((d) => d.held).length,
    unconfirmedActions: ctx.app.store.unsettledEffects().length,
    total: questions + approvals + applications,
  };
}

/** Where a job has gone when nothing waits on it any more. */
const GONE_STATUSES: ReadonlySet<ApplicationStatus> = new Set(['skipped', 'failed', 'applied', 'unconfirmed']);

/** A job that asked, as Review links to it. */
export interface AskingJob {
  company: string;
  title: string;
  url: string | null;
  jobId: string | null;
  /** The ledger's application for it, when there is one, and where it stands. */
  applicationId: string | null;
  status: ApplicationStatus | null;
}

/** What an open question carries on Review besides itself. */
export interface QuestionPlace {
  /** Every job known to wait on it, newest first. */
  jobs: AskingJob[];
  blocks: number;
  /** The stable name of what it asks, when Fanfold has one. */
  intentKey: string | null;
  /** Other open questions asking the same thing in other words: one answer settles them all. */
  sameIntent: number[];
}

/** The intent a question carries, once questions are classified; null before. */
function intentOf(q: Question): string | null {
  const v = (q as unknown as Record<string, unknown>).intentKey ?? (q as unknown as Record<string, unknown>).intent;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Open questions grouped by the job that last asked, each once. A question
 * several jobs ask sits under the newest of them and says how many it holds
 * up; questions asking the same thing in other words ride on the first.
 */
export function questionGroups(ctx: RouteContext, open: Question[]): {
  groups: Array<{ job: AskingJob | null; questionIds: number[] }>;
  places: Map<number, QuestionPlace>;
} {
  const rows = ctx.app.jobs.list({ limit: 2000 });
  const byJob = new Map<string, ApplicationRow>();
  const byPosting = new Map<string, ApplicationRow>();
  const live = (r: ApplicationRow): boolean => r.status !== 'skipped' && r.status !== 'failed';
  for (const r of rows) {
    const keep = (map: Map<string, ApplicationRow>, k: string | null): void => {
      if (k && (!map.has(k) || (live(r) && !live(map.get(k)!)))) map.set(k, r);
    };
    keep(byJob, r.jobId);
    for (const u of [r.url, r.job.url, ...r.job.sourceUrls]) keep(byPosting, postingKey(u));
  }
  const asking = (a: Question['askedBy'][number], jobId: string | null): AskingJob => {
    const row = byJob.get(jobId ?? a.jobId ?? '') ?? byPosting.get(postingKey(a.url) ?? '') ?? null;
    return {
      company: a.company || row?.job.company || '', title: a.title || row?.job.title || '',
      url: a.url || row?.url || row?.job.url || null, jobId: row?.jobId ?? a.jobId ?? jobId ?? null,
      applicationId: row?.id ?? null, status: row?.status ?? null,
    };
  };
  const identity = (j: AskingJob): string => j.jobId ?? (postingKey(j.url) || `${j.company.toLowerCase()}|${j.title.toLowerCase()}`);

  // Held up is still waiting: a job skipped, sent or given up is not held up by anything.
  const holds = (list: AskingJob[]): number => list.filter((j) => !j.status || !GONE_STATUSES.has(j.status)).length;

  const places = new Map<number, QuestionPlace>();
  const firstOfIntent = new Map<string, number>();
  const riders = new Set<number>();
  for (const q of open) {
    const seen = new Set<string>();
    const jobs = q.askedBy.map((a) => asking(a, q.jobId)).filter((j) => {
      const id = identity(j);
      if (seen.has(id) || id === '|') return false;
      seen.add(id);
      return true;
    });
    const intentKey = intentOf(q);
    places.set(q.id, { jobs, blocks: holds(jobs), intentKey, sameIntent: [] });
    // Two essays on one topic are two essays: each is answered in its own words.
    const shared = intentKey && !intentKey.startsWith('essay.') ? intentKey : null;
    const first = shared ? firstOfIntent.get(shared) : undefined;
    if (shared && first === undefined) firstOfIntent.set(shared, q.id);
    if (first !== undefined) {
      const lead = places.get(first)!;
      lead.sameIntent.push(q.id);
      const have = new Set(lead.jobs.map(identity));
      for (const j of jobs) if (!have.has(identity(j))) { lead.jobs.push(j); have.add(identity(j)); }
      lead.blocks = holds(lead.jobs);
      riders.add(q.id);
    }
  }

  const groups: Array<{ job: AskingJob | null; questionIds: number[] }> = [];
  const groupOf = new Map<string, { job: AskingJob | null; questionIds: number[] }>();
  for (const q of open) {
    if (riders.has(q.id)) continue;
    const job = places.get(q.id)!.jobs[0] ?? null;
    const k = job ? identity(job) : '';
    let g = groupOf.get(k);
    if (!g) { g = { job, questionIds: [] }; groupOf.set(k, g); groups.push(g); }
    g.questionIds.push(q.id);
  }
  return { groups, places };
}

/** What Fanfold worked out and kept, with the job it was for, for the owner to audit on Review. */
export function workedOut(ctx: RouteContext): Array<Record<string, unknown>> {
  return ctx.app.profile.derivedAnswers(200).map((d) => {
    const job = d.jobId ? ctx.app.jobs.job(d.jobId) : null;
    return { ...d, job: job ? { company: job.company, title: job.title, url: job.url } : null };
  });
}

/**
 * Why each answer on an application is labelled as it is: what Fanfold
 * worked out rests on its record; a draft that is a profile value not yet
 * confirmed says which, so confirming it there also clears the card.
 */
function explainAnswers(ctx: RouteContext): (row: ApplicationRow) => Array<Answer & { basis?: Record<string, unknown> | null; proposed?: { field: ProfileField; value: string; from: string | null; byAgent: boolean } }> {
  // Read once for a whole list, not once per answer.
  const facts = new Map(ctx.app.profile.facts().map((f) => [f.field, f]));
  const places = placeWords(facts.get('location')?.value);
  return (row) => row.answers.map((a) => {
    if (a.source === 'FANFOLD') return { ...a, basis: ctx.app.profile.derivedAnswer(a.question, row.jobId)?.basis ?? null };
    if (a.source !== 'DRAFT') return a;
    const asked = fieldAsked(a.question, places);
    const fact = asked && !asked.draft ? facts.get(asked.field) : null;
    if (!fact || fact.confirmed || folded(fact.value) !== folded(a.answer)) return a;
    return { ...a, proposed: { field: fact.field, value: fact.value, from: fact.from, byAgent: fact.source === 'agent' } };
  });
}

function workerDetail(ctx: RouteContext, res: ServerResponse, id: string): void {
  const worker = ctx.app.workers.get(id);
  if (!worker) return sendJson(res, { error: 'no such worker' }, 404);
  const runs = ctx.app.workers.runs(id, 30);
  const live = runs.find((r) => r.status === 'running');
  sendJson(res, {
    worker: workersWithCounts(ctx).find((w) => w.id === id),
    runs,
    liveSteps: live?.run_id ? ctx.app.store.steps(String(live.run_id)) : [],
    applications: judged(ctx, ctx.app.jobs.list({ workerId: id, limit: 100 })),
    funnel: ctx.app.jobs.funnel(id),
    grants: ctx.app.capabilities.list(true).filter((c) => c.workerId === id),
    lessons: ctx.app.memory.allLessons().filter((l) => l.status === 'active' || l.status === 'unproven')
      .filter((l) => worker.sites.some((s) => (ctx.app.sites.get(s.site)?.hosts ?? []).some((h) => l.domain.endsWith(h.replace(/^\./, '')))))
      .slice(0, 12),
  });
}

/** A worker's settings from a request body: what the body leaves out or gets wrong is kept from `existing`, or defaulted. */
function workerSpecFrom(ctx: RouteContext, body: Record<string, unknown>, existing?: WorkerDef): WorkerSpec {
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);
  const times = Array.isArray(body.times) ? (body.times as unknown[]).map((t) => str(t)).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).map((t) => t.padStart(5, '0')) : [];
  const days = Array.isArray(body.days) ? (body.days as unknown[]).filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6) : undefined;
  const schedule: WorkerSchedule = {
    times: times.length ? times : existing?.schedule.times ?? ['09:00'],
    days: days === undefined ? existing?.schedule.days : days.length ? [...new Set(days)].sort() : undefined,
    timezone: str(body.timezone) || existing?.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    jitterMinutes: 5,
    graceMinutes: 90,
    preferOffPeak: typeof body.preferOffPeak === 'boolean' ? body.preferOffPeak : existing?.schedule.preferOffPeak,
  };
  const sites = Array.isArray(body.sites)
    ? (body.sites as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x) => ({ site: str(x.site), enabled: x.enabled !== false, dailyCap: Math.max(0, Math.round(Number(x.dailyCap) || 0)) }))
        .filter((x) => ctx.app.sites.get(x.site))
    : existing?.sites ?? [];
  const autonomy = ['review_all', 'auto_known', 'auto_within_caps'].includes(str(body.autonomy)) ? str(body.autonomy) as Autonomy : existing?.autonomy ?? 'auto_known';
  const capsBody = body.caps && typeof body.caps === 'object' ? body.caps as Record<string, unknown> : null;
  const caps = capsBody
    ? { dailyTotal: Math.max(0, Math.round(Number(capsBody.dailyTotal) || 0)),
        dailySpendUsd: capsBody.dailySpendUsd === null ? null : Number(capsBody.dailySpendUsd) || null }
    : existing?.caps ?? DEFAULT_CAPS;
  const documentsBody = body.documents && typeof body.documents === 'object' ? body.documents as Record<string, unknown> : null;
  const coverLetterPolicy = str(documentsBody?.coverLetterPolicy);
  const documents = documentsBody
    ? { resumeId: str(documentsBody.resumeId) || null,
        coverLetterPolicy: (['when_required', 'always', 'never'].includes(coverLetterPolicy) ? coverLetterPolicy : 'when_required') as WorkerDocuments['coverLetterPolicy'] }
    : existing?.documents ?? DEFAULT_DOCUMENTS;
  return {
    name: str(body.name) || existing?.name || 'Worker',
    goal: str(body.goal) || existing?.goal || '',
    schedule, limits: existing?.limits ?? [], policy: existing?.policy ?? {},
    enabled: existing?.enabled ?? false, maxSteps: Number(body.maxSteps) || existing?.maxSteps || 40,
    mandate: body.mandate && typeof body.mandate === 'object' ? body.mandate as WorkerSpec['mandate'] : existing?.mandate ?? {},
    sites, autonomy, caps, documents,
    browserMode: ['dedicated', 'extension', 'auto'].includes(str(body.browserMode)) ? str(body.browserMode) as WorkerSpec['browserMode'] : existing?.browserMode ?? 'auto',
    status: existing?.status ?? 'paused',
    statusReason: existing?.statusReason ?? null,
    conversationId: existing?.conversationId ?? (str(body.conversationId) || null),
  };
}

/** A schedule time the scheduler would choke on later, said now instead. */
/** A salary floor a worker cannot compare a posting's range against, said now: it needs an amount. */
function badFloor(mandate: unknown): string | null {
  const floor = mandate && typeof mandate === 'object' ? (mandate as Record<string, unknown>).salaryFloor : null;
  if (typeof floor !== 'string' || !floor.trim() || /\d/.test(floor)) return null;
  return 'Write the salary floor as an amount, like 60,000 a year or 30 LPA.';
}

function badTime(times: unknown): string | null {
  for (const t of Array.isArray(times) ? times : []) {
    if (typeof t !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t.trim())) {
      return `${JSON.stringify(t)} is not a time: use the 24-hour clock, like 08:00 or 17:30`;
    }
  }
  return null;
}

/**
 * Create a worker. It starts paused unless `enable` is set, and enabling is
 * what mints its grant, so a worker is never running with autonomy nobody
 * chose for it.
 */
async function createWorker(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, Bodies.Worker) as Record<string, unknown>;
  const timeError = badTime(body.times);
  if (timeError) return sendJson(res, { error: timeError }, 400);
  const floorError = badFloor(body.mandate);
  if (floorError) return sendJson(res, { error: floorError, field: 'salaryFloor' }, 400);
  const spec = workerSpecFrom(ctx, body);
  if (!spec.name || !spec.goal) return sendJson(res, { error: 'name and goal are required' }, 400);
  const worker = ctx.app.workers.create({ ...spec, status: 'paused', statusReason: 'paused by you' });
  const enabled = body.enable === true ? ctx.app.enableWorker(worker.id) : null;
  ctx.emit({ type: 'worker_created', id: worker.id, name: worker.name });
  sendJson(res, enabled?.worker ?? worker);
}

async function updateWorker(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const existing = ctx.app.workers.get(id);
  if (!existing) return sendJson(res, { error: 'no such worker' }, 404);
  const body = await readBody(req, Bodies.Worker) as Record<string, unknown>;
  const timeError = badTime(body.times);
  if (timeError) return sendJson(res, { error: timeError }, 400);
  const floorError = badFloor(body.mandate);
  if (floorError) return sendJson(res, { error: floorError, field: 'salaryFloor' }, 400);
  const spec = workerSpecFrom(ctx, body, existing);
  const updated = ctx.app.workers.update(id, {
    name: spec.name, goal: spec.goal, schedule: spec.schedule, maxSteps: spec.maxSteps,
    mandate: spec.mandate, sites: spec.sites, autonomy: spec.autonomy, caps: spec.caps,
    documents: spec.documents, browserMode: spec.browserMode,
  });
  // A changed site list or autonomy level changes what the grant may cover.
  if (existing.status === 'active') ctx.app.enableWorker(id);
  ctx.emit({ type: 'worker_changed' });
  sendJson(res, ctx.app.workers.get(id) ?? updated);
}

function toggleWorker(ctx: RouteContext, res: ServerResponse, id: string): void {
  const worker = ctx.app.workers.get(id);
  if (!worker) return sendJson(res, { error: 'no such worker' }, 404);
  if (worker.status === 'active') ctx.app.pauseWorker(id); else ctx.app.enableWorker(id);
  ctx.emit({ type: 'worker_changed' });
  sendJson(res, { enabled: ctx.app.workers.get(id)!.enabled });
}

function applications(ctx: RouteContext, res: ServerResponse, url: URL): void {
  sendJson(res, applicationsView(ctx, url));
}

/** Rows as the page shows them: a fit verdict that judged nothing is judged again against what the user has added since. */
export function judged<T extends ApplicationRow>(ctx: RouteContext, rows: T[]): T[] {
  return judgedAgain({ jobs: ctx.app.jobs, profile: ctx.app.profile, memory: ctx.app.memory, careers: ctx.app.careers }, rows);
}

/** The Applications list as the page asks for it: filtered, each answer explained, and the funnel. */
export function applicationsView(ctx: RouteContext, url: URL): { applications: Array<ApplicationRow & Record<string, unknown>>; funnel: Record<string, number> } {
  const status = url.searchParams.get('status');
  const statuses = status ? status.split(',').filter((s): s is ApplicationStatus => (APPLICATION_STATUSES as readonly string[]).includes(s)) : undefined;
  const rows = judged(ctx, ctx.app.jobs.list({
    status: statuses?.length ? statuses : undefined,
    workerId: url.searchParams.get('worker') ?? undefined,
    ats: url.searchParams.get('ats') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
    limit: Number(url.searchParams.get('limit')) || 200,
  }));
  const explain = explainAnswers(ctx);
  const state = queuedStates(ctx);
  // A job skipped once and taken up again later is one job, as it stands now.
  const shown = rows.filter((r) => !(r.status === 'skipped' && rows.some((o) => o.id !== r.id && o.jobId === r.jobId && o.updatedAt >= r.updatedAt)));
  return {
    // A queued row says whether it is being sent, still being worked on, or was started and left.
    applications: shown.map((r) => ({ ...r, answers: explain(r), ...(r.status === 'queued' ? { queued: state(r) } : {}) })),
    funnel: ctx.app.jobs.funnel(),
  };
}

/** What the person reads when they add a job by its address. */
export const ADD_COPY = {
  badLink: 'Paste the job’s link, such as https://jobs.example.com/123.',
  already: '{job} is already in your list ({status}). Nothing new was added.',
  skipped: 'You skipped {job} on {when}{reason}. Add it again?',
  because: ', because “{reason}”',
};

/** A status as the person reads it. */
const STATUS_WORDS: Record<ApplicationStatus, string> = {
  found: 'found', skipped: 'skipped', queued: 'queued', needs_review: 'waiting in Review', prepared: 'ready for you to submit',
  applying: 'being sent', applied: 'applied', unconfirmed: 'sent, not confirmed', failed: 'not sent',
};

/**
 * "Add a job by URL": recorded as found, for "Fill it now", a worker or the
 * chat to pick up. An address already in the list adds nothing; one the
 * person skipped is taken up again only when they say so (`again`).
 */
async function addApplication(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, Bodies.AddApplication);
  let target = (body.url ?? '').trim();
  // "jobs.example.com/123" is a link too.
  if (target && !/^[a-z][a-z\d+.-]*:/i.test(target) && /^[\w-]+(\.[\w-]+)+([/:?#]|$)/.test(target)) target = `https://${target}`;
  let parsed: URL | null = null;
  try { parsed = new URL(target); } catch { /* said below */ }
  if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) return sendJson(res, { error: ADD_COPY.badLink }, 400);
  const known = ctx.app.jobs.forPosting(target);
  if (known) {
    const job = `${known.job.company} — ${known.job.title}`;
    if (known.status === 'skipped' && body.again !== true) {
      const reason = known.skipReason ? ADD_COPY.because.replace('{reason}', known.skipReason) : '';
      // `field: again` is how the page knows to ask, and to send the same link back with `again`.
      return sendJson(res, { error: ADD_COPY.skipped.replace('{job}', job).replace('{when}', whenSaid(known.updatedAt)).replace('{reason}', reason), field: 'again', application: known }, 409);
    }
    if (known.status !== 'skipped') {
      return sendJson(res, { error: ADD_COPY.already.replace('{job}', job).replace('{status}', STATUS_WORDS[known.status]), application: known }, 409);
    }
    // Taken up again, as they asked: the same row, found once more.
    const again = ctx.app.jobs.transition(known.id, 'found');
    ctx.emit({ type: 'application_changed' });
    return sendJson(res, again);
  }
  // Never named after its host: the company its address names, until the fill reads the page's own job data.
  const r = ctx.app.jobs.record({
    job: { company: (body.company ?? '').trim() || companyFromUrl(target), title: (body.title ?? '').trim() || 'Posting', url: target },
    status: 'found', url: target,
  });
  if (!r.ok) return sendJson(res, { error: r.why }, 409);
  ctx.emit({ type: 'application_changed' });
  sendJson(res, r.application);
}

/**
 * Move an application by hand: approve, skip with a reason, snooze, mark an
 * unconfirmed one applied or not. Edited answers can be saved to the bank.
 */
async function updateApplication(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const current = ctx.app.jobs.application(id);
  if (!current) return sendJson(res, { error: 'no such application' }, 404);
  const body = await readBody(req, Bodies.UpdateApplication);
  const answers = Array.isArray(body.answers)
    ? body.answers.filter((a) => a && typeof a.question === 'string' && typeof a.answer === 'string')
        .map((a) => ({ question: a.question.slice(0, 300), answer: a.answer.slice(0, 4000), source: String(a.source ?? 'DRAFT').slice(0, 20) }))
    : undefined;
  if (body.saveToBank && answers) saveEditedAnswers(ctx, current, answers);
  const status = body.status && (APPLICATION_STATUSES as readonly string[]).includes(body.status) ? body.status : current.status;
  if (status === 'skipped' && !(body.skipReason ?? current.skipReason)) return sendJson(res, { error: 'a skip needs a reason' }, 400);
  try {
    const updated = ctx.app.jobs.transition(id, status, { skipReason: body.skipReason ?? null, answers });
    ctx.emit({ type: 'application_changed' });
    sendJson(res, updated);
  } catch (err) {
    sendJson(res, { error: (err as Error).message }, 409);
  }
}

/** Answers the owner changed on Review, kept as their own for the question, filed by where it applies. */
export function saveEditedAnswers(ctx: RouteContext, row: Application, answers: Answer[]): void {
  const job = ctx.app.jobs.job(row.jobId);
  for (const [i, a] of answers.entries()) {
    const before = row.answers[i];
    if (a.answer?.trim() && (!before || before.answer !== a.answer)) ctx.app.profile.addAnswer(a.question, a.answer, 'review', answerPlace(a.question, job));
  }
}

/** The user answers a question an application asked, or would rather not: it is not put to them again either way. */
async function answerQuestion(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, id: number, verb: string): Promise<void> {
  if (!ctx.app.questions.get(id)) return sendJson(res, { error: 'no such question' }, 404);
  if (verb === 'decline') {
    const asked = ctx.app.questions.get(id)!;
    if (!ctx.app.questions.decline(id)) return sendJson(res, { error: 'that question is not waiting for an answer' }, 409);
    // "Skip the jobs that need this": every job still waiting on it leaves Review as skipped, saying why.
    const state = queuedStates(ctx);
    const skipped: string[] = [];
    for (const job of questionGroups(ctx, [asked]).places.get(id)?.jobs ?? []) {
      const row = job.applicationId ? ctx.app.jobs.application(job.applicationId) : null;
      if (!row || !SKIPPABLE.has(row.status) || (row.status === 'queued' && state(row) === 'sending')) continue;
      ctx.app.jobs.transition(row.id, 'skipped', { skipReason: COPY.declinedSkip.replace('{question}', asked.question) });
      skipped.push(row.id);
    }
    ctx.emit({ type: 'question_declined', ids: [id] });
    if (skipped.length) ctx.emit({ type: 'application_changed' });
    ctx.app.settleKeeps();
    return sendJson(res, { declined: true, skipped });
  }
  const body = await readBody(req, Bodies.QuestionAnswer);
  const answer = (body.answer ?? '').trim();
  if (!answer) return sendJson(res, { error: 'Type an answer first.' }, 400);
  // "Use this for every company": a "know anyone there" answer the owner says holds for all of them.
  const question = ctx.app.questions.get(id)!;
  const general = body.forEveryCompany === true ? everyCompanyKey(question.intent ? { intent: question.intent.split(':')[0], params: {}, exact: true, by: 'pattern' } : classifyLocal(question.question, question.kind, null)) : null;
  // The jobs waiting on it, read before it is answered: an answered question no longer says who asked.
  const waiting = questionGroups(ctx, [question]).places.get(id)?.jobs ?? [];
  const saved = ctx.app.questions.answer(id, answer, 'you', { intentKey: general });
  // What they said goes on each waiting job's card too, so it is what Review shows and what the submit sends.
  let carded = false;
  for (const job of waiting) {
    const row = job.applicationId ? ctx.app.jobs.application(job.applicationId) : null;
    if (!row || !SKIPPABLE.has(row.status)) continue;
    if (ctx.app.jobs.keepAnswers(row.id, { answers: [{ question: question.question, answer, source: 'BANK' }] })) carded = true;
  }
  ctx.emit({ type: 'question_answered', ids: [id] });
  if (carded) ctx.emit({ type: 'application_changed' });
  ctx.app.settleKeeps();
  sendJson(res, saved);
}

/**
 * The profile page: each fact with where it came from and whether forms may
 * use it yet, a suggestion for each blank field from the user's answers, and
 * the documents, each saying whether it is the owner's own.
 */
export async function profileView(ctx: RouteContext): Promise<Record<string, unknown>> {
  const facts = ctx.app.profile.facts();
  // The page shows every field but EEO, which is a choice of how to answer, not a fact.
  const shown = PROFILE_FIELDS.filter((f) => f !== 'eeoPreference');
  const on = facts.filter((f) => (shown as readonly string[]).includes(f.field));
  const jobName = (jobId: string | null): { company: string; title: string } | null => {
    const job = jobId ? ctx.app.jobs.job(jobId) : null;
    return job ? { company: job.company, title: job.title } : null;
  };
  const resumeId = ctx.app.resumeDocument()?.id ?? null;
  return {
    facts,
    fields: [...PROFILE_FIELDS],
    completeness: ctx.app.profile.completeness(),
    counts: { total: shown.length, filled: on.filter((f) => f.usable).length, confirmed: on.filter((f) => f.confirmed).length, proposed: on.filter((f) => !f.usable).length },
    suggestions: await profileSuggestions(ctx),
    answers: ctx.app.profile.answers(1000).map((a) => ({ ...a, job: jobName(a.jobId) })),
    derived: workedOut(ctx),
    // Each document says whose name it carries when it is somebody else's, and which one is the résumé.
    documents: ctx.app.memory.listDocuments({ includeHeld: true }).map((d) => ({
      ...d, otherName: ctx.app.owners.otherName(d.id), resume: resumeId === d.id,
    })),
    career: await careerOf(ctx),
    rights: rightsView(ctx),
  };
}

/**
 * Whether an answer typed for this question may be saved as it is: any
 * answer to a question that is not about where they may work; for one that
 * is, a plain Yes or No to a yes-or-no question, or a sentence that reads
 * plainly as entries ("India: Citizen").
 */
function choiceForRights(ctx: RouteContext, question: string, answer: string): boolean {
  const q = question.trim();
  const places = placeWords(ctx.app.profile.fact('location')?.value);
  const cls = classifyLocal(q, 'text', null, { intents: ctx.app.intents, places });
  const intent = cls && RIGHTS_INTENTS.has(cls.intent) ? cls.intent : null;
  if (!intent) return true;
  const kind = rightsKind(intent, q, { kind: 'text', choices: [] })?.kind;
  if (kind && kind !== 'status' && kind !== 'nationality' && /^(?:yes|no)\.?$/i.test(answer.trim())) return true;
  const read = intent === 'work.sponsorship' ? readSponsorship(answer) : readRights(answer);
  return !read.unread.length && ('entries' in read ? read.entries.length > 0 || !!read.elsewhere : read.countries.length > 0 || !!read.elsewhere);
}

/** Where the person may work, and the lists they pick from, the country they live in first. */
function rightsView(ctx: RouteContext): Record<string, unknown> {
  const state = ctx.app.profile.rights.state();
  const location = ctx.app.profile.fact('location')?.value ?? '';
  const own = location ? countryOfPlace(location) ?? countryIn(location) : null;
  return {
    entries: state.entries.map((e) => ({ ...e, words: entryWords(e) })),
    elsewhere: state.elsewhere?.value ?? null,
    earlierSponsorship: state.earlierSponsorship,
    statuses: RIGHTS_STATUSES.map((id) => ({ id, label: RIGHTS_COPY.status[id], hint: RIGHTS_COPY.statusHint[id], expires: statusExpires(id), sponsorship: defaultSponsorship(id) })),
    sponsorship: SPONSORSHIP_VALUES.map((id) => ({ id, label: RIGHTS_COPY.sponsorship[id] })),
    toChangeEmployer: RIGHTS_COPY.sponsorshipToChange,
    elsewhereChoices: ELSEWHERE_VALUES.map((id) => ({ id, label: RIGHTS_COPY.elsewhere[id] })),
    countries: countryChoices(own),
    withThe: [...WITH_THE],
    area: { name: FREE_MOVEMENT, label: RIGHTS_COPY.freeMovementArea },
  };
}

/**
 * A suggestion for each blank field: from the user's answers, and for their
 * years of experience, what the career record read from their documents
 * works out, the way a form asking it would be answered.
 */
async function profileSuggestions(ctx: RouteContext): Promise<ReturnType<RouteContext['app']['profile']['suggestions']>> {
  const out = ctx.app.profile.suggestions();
  if (out.yearsExperience || ctx.app.profile.fact('yearsExperience')) return out;
  const years = await suggestionFor({ question: 'Total years of experience', kind: 'number' }, null, {
    profile: ctx.app.profile, jobs: ctx.app.jobs, memory: ctx.app.memory, careers: ctx.app.careers, intents: ctx.app.intents,
  }).catch(() => null);
  if (years) out.yearsExperience = years;
  return out;
}

/** What Fanfold read from the owner's documents; null when it has read nothing, or cannot say. */
async function careerOf(ctx: RouteContext): Promise<unknown> {
  try {
    return (await ctx.app.career()) ?? null;
  } catch (err) {
    ctx.log.warn('could not read the career record', { err });
    return null;
  }
}

/** Read every document the user gave into the profile again, the owner's own first, the whole of each. */
async function extractProfile(ctx: RouteContext, res: ServerResponse): Promise<void> {
  const docs = ctx.app.memory.listDocuments().filter((d) => d.chunks > 0);
  if (!docs.length) return sendJson(res, { error: COPY.noDocuments }, 400);
  // Each field counted once, however many documents state it: the profile has one of each.
  const usableFields = new Set<string>();
  const proposedFields = new Set<string>();
  let costUsd = 0;
  // Why a document gave nothing, so a result of nothing can be explained.
  const skipped: Array<{ title: string; why: string }> = [];
  // Whether the model read them: a count of facts never stands alone when it failed.
  const problems: string[] = [];
  let answered = false;
  // An agent's documents first and the owner's after, oldest first, so the owner's newest résumé has the last word.
  for (const d of [...docs].reverse().sort((a, b) => Number(a.trusted) - Number(b.trusted))) {
    const { profile: r, career } = await ctx.app.readDocument(d.id);
    for (const f of r?.usable ?? []) usableFields.add(f);
    for (const f of r?.proposed ?? []) proposedFields.add(f);
    costUsd += r?.costUsd ?? 0;
    if (r?.skipped) skipped.push({ title: d.title, why: r.skipped });
    else if (!r) skipped.push({ title: d.title, why: '' });
    for (const p of [r?.problem ?? null, career.problem]) if (p && !problems.includes(p)) problems.push(p);
    if (r?.model === 'answered' || career.by === 'model') answered = true;
  }
  ctx.emit({ type: 'profile_changed' });
  // `reading`: the model answered, it failed and patterns read what they could (with what the provider said), or there is no model.
  const reading = problems.length ? { by: 'patterns', problem: problems.join('; ') } : { by: answered ? 'model' : ctx.app.profileModel ? 'kept' : 'none', problem: null };
  // A field a document states for the user to confirm, which another already states ready to use, is ready to use.
  for (const f of usableFields) proposedFields.delete(f);
  sendJson(res, { proposed: proposedFields.size, usable: usableFields.size, costUsd, skipped, read: docs.length, model: Boolean(ctx.app.profileModel), reading, ...await profileView(ctx) });
}

export function settingsView(ctx: RouteContext): Record<string, unknown> {
  return {
    contributeLessons: ctx.app.store.setting('contributeLessons', false),
    browserMode: ctx.app.browserMode,
    submitWithoutAsking: ctx.app.store.setting('submitWithoutAsking', false),
    mailCodes: ctx.app.store.setting('mailCodes', true),
  };
}

/** What is known about each site: policy, lessons, skills, counts. */
function playbooks(ctx: RouteContext): Record<string, unknown> {
  const lessons = ctx.app.memory.allLessons(true);
  const skills = ctx.app.memory.listSkills();
  const sites = ctx.app.sites.list().map((site) => {
    const belongs = (domain: string): boolean => site.hosts.some((h) => domain === h.replace(/^\./, '') || domain.endsWith(h));
    const mine = lessons.filter((l) => belongs(l.domain));
    const skillsHere = skills.filter((sk) => belongs(sk.domain));
    return {
      ...site,
      lessons: mine.map((l) => ({ id: l.id, trigger: l.trigger, lesson: l.lesson, status: l.status, verdict: l.gateVerdict, uses: l.uses, helped: l.helped })),
      skills: skillsHere.map((sk) => ({ id: sk.id, intent: sk.intent, status: sk.status, runs: sk.runs, successes: sk.successes, steps: sk.steps })),
      runs: skillsHere.reduce((n, sk) => n + sk.runs, 0),
      successes: skillsHere.reduce((n, sk) => n + sk.successes, 0),
    };
  });
  const counts = { active: 0, proposed: 0, unproven: 0, rejected: 0, shadow: 0 };
  for (const l of lessons) if (l.status in counts) counts[l.status as keyof typeof counts]++;
  // Every flow in use, on any site: a flow the user taught need not be on a job site.
  const flows = skills.filter((sk) => sk.status === 'active').map((sk) => ({
    id: sk.id, domain: sk.domain, intent: sk.intent, params: sk.params, steps: sk.steps.length, runs: sk.runs, successes: sk.successes,
  }));
  return { sites, counts, flows, derivedCases: 0, contribute: ctx.app.store.setting('contributeLessons', false) };
}

/**
 * Start a worker now and answer at once. The run goes on in the background
 * and reports through the event stream, so the page does not hang on it.
 */
function runWorker(ctx: RouteContext, res: ServerResponse, id: string): void {
  if (!ctx.app.workers.get(id)) return sendJson(res, { error: 'no such worker' }, 404);
  const outcome = ctx.app.runWorkerNow(id);
  sendJson(res, outcome.started ? outcome : { ...outcome, error: outcome.why }, outcome.started ? 202 : 409);
}
