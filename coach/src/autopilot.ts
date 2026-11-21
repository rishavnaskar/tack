// Autopilot: once switched on, Tack reads the market, rebuilds the gap, picks the best postings,
// prepares and sends the applications, reads the replies and replans, every few hours, by itself.
// Each run is a fixed list of idempotent steps stored as it goes, so a run cut short by a crash
// carries on from the step it was in. A lock in the store keeps two runs from ever overlapping.

import { randomUUID } from 'node:crypto';
import * as store from './store.ts';
import { emit } from './trace.ts';
import * as queue from './apply-queue.ts';
import type { Goal, Posting, Profile, SyncResult } from './types.ts';

// ---------------------------------------------------------------- settings

export interface QuietHours { from: string; to: string }

export interface AutopilotSettings {
  on: boolean;
  /** When it was last switched on: the first scheduled run follows shortly after. */
  onAt?: string;
  intervalHours: number;
  dailyCap: number;
  minFit: number;
  excludeRoles: string[];
  excludeCompanies: string[];
  quietHours: QuietHours | null;
  /** Off by default: fully automated. On, picks wait for the person's yes. */
  needsApproval: boolean;
  /** How often replies are read while the app runs; 0 turns the separate check off. */
  mailEveryHours: number;
}

export const DEFAULTS: AutopilotSettings = {
  on: false, intervalHours: 12, dailyCap: 5, minFit: 50, excludeRoles: [], excludeCompanies: [], quietHours: null, needsApproval: false, mailEveryHours: 6,
};
export const HARD_CAP = 15;
const SETTINGS = 'autopilot-settings';

export class SettingsError extends Error {
  problems: Record<string, string>;
  constructor(problems: Record<string, string>) {
    super(Object.values(problems).join(' '));
    this.problems = problems;
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function list(v: unknown, field: string, problems: Record<string, string>): string[] | undefined {
  if (v === undefined) return undefined;
  const raw = typeof v === 'string' ? v.split(/[,\n]/) : Array.isArray(v) ? v : null;
  if (!raw) { problems[field] = 'Give a list, one item per line or separated by commas.'; return undefined; }
  const out = [...new Set(raw.map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (out.some((x) => x.length > 80)) problems[field] = 'Keep each item under 80 characters.';
  if (out.length > 50) problems[field] = 'At most 50 items.';
  return out.slice(0, 50);
}

function int(v: unknown, field: string, lo: number, hi: number, problems: Record<string, string>, what: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || Math.round(n) !== n || n < lo || n > hi) { problems[field] = `${what} must be a whole number from ${lo} to ${hi}.`; return undefined; }
  return n;
}

/** Applies a partial update on top of what is stored. Throws SettingsError naming every bad field. */
export function validateSettings(body: any, prev: AutopilotSettings = DEFAULTS, now = new Date()): AutopilotSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SettingsError({ body: 'Send the settings as an object.' });
  const problems: Record<string, string> = {};
  const next: AutopilotSettings = { ...prev };
  if (body.on !== undefined) {
    if (typeof body.on !== 'boolean') problems.on = 'on must be true or false.';
    else {
      if (body.on && !prev.on) next.onAt = now.toISOString();
      next.on = body.on;
    }
  }
  if (body.needsApproval !== undefined) {
    if (typeof body.needsApproval !== 'boolean') problems.needsApproval = 'needsApproval must be true or false.';
    else next.needsApproval = body.needsApproval;
  }
  next.intervalHours = int(body.intervalHours, 'intervalHours', 1, 168, problems, 'The interval in hours') ?? next.intervalHours;
  next.dailyCap = int(body.dailyCap, 'dailyCap', 1, HARD_CAP, problems, 'The daily cap') ?? next.dailyCap;
  next.minFit = int(body.minFit, 'minFit', 0, 100, problems, 'The minimum fit') ?? next.minFit;
  next.mailEveryHours = int(body.mailEveryHours, 'mailEveryHours', 0, 168, problems, 'The mail interval in hours') ?? next.mailEveryHours;
  next.excludeRoles = list(body.excludeRoles, 'excludeRoles', problems) ?? next.excludeRoles;
  next.excludeCompanies = list(body.excludeCompanies, 'excludeCompanies', problems) ?? next.excludeCompanies;
  if (body.quietHours !== undefined) {
    const q = body.quietHours;
    if (q === null || (q && q.from === '' && q.to === '')) next.quietHours = null;
    else if (!q || typeof q !== 'object' || !HHMM.test(String(q.from)) || !HHMM.test(String(q.to))) problems.quietHours = 'Quiet hours need a start and an end as HH:MM, like 22:00 and 07:00.';
    else if (q.from === q.to) problems.quietHours = 'Quiet hours need a start and an end that differ.';
    else next.quietHours = { from: String(q.from), to: String(q.to) };
  }
  if (Object.keys(problems).length) throw new SettingsError(problems);
  return next;
}

export function getSettings(): AutopilotSettings {
  return { ...DEFAULTS, ...(store.get<AutopilotSettings>('single', SETTINGS) ?? {}) };
}

export function saveSettings(s: AutopilotSettings): AutopilotSettings {
  store.put('single', SETTINGS, s);
  return s;
}

// ---------------------------------------------------------------- time

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Inside the quiet window, in local time; a window may run past midnight. */
export function inQuiet(now: Date, q: QuietHours | null): boolean {
  if (!q) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const a = minutes(q.from);
  const b = minutes(q.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** When the quiet window around `now` ends. */
export function quietEnd(now: Date, q: QuietHours): Date {
  const end = new Date(now);
  end.setHours(Number(q.to.slice(0, 2)), Number(q.to.slice(3, 5)), 0, 0);
  if (end <= now) end.setDate(end.getDate() + 1);
  return end;
}

const FIRST_RUN_MS = 2 * 60_000;

/** When the next scheduled run is due: an interval after the last run, or shortly after it was switched on; never in quiet hours. */
export function nextRunAt(s: AutopilotSettings, last: Pick<AutopilotRun, 'startedAt'> | undefined, now: Date): Date | null {
  if (!s.on) return null;
  const onAt = s.onAt ? Date.parse(s.onAt) : now.getTime();
  let at = new Date(last && Date.parse(last.startedAt) >= onAt - 1000 ? Date.parse(last.startedAt) + s.intervalHours * 3_600_000 : onAt + FIRST_RUN_MS);
  if (s.quietHours && inQuiet(at, s.quietHours)) at = quietEnd(at, s.quietHours);
  return at;
}

// ---------------------------------------------------------------- runs

export type StepName = 'harvest' | 'gap' | 'rank' | 'kits' | 'apply' | 'mail' | 'replan' | 'report';

export const STEPS: { name: StepName; label: string; needs?: StepName[] }[] = [
  { name: 'harvest', label: 'Read fresh postings' },
  { name: 'gap', label: 'Rebuild the gap map' },
  { name: 'rank', label: 'Rank and pick postings', needs: ['gap'] },
  { name: 'kits', label: 'Prepare application kits', needs: ['rank'] },
  { name: 'apply', label: 'Apply in parallel', needs: ['rank'] },
  { name: 'mail', label: 'Read replies' },
  { name: 'replan', label: 'Replan if needed' },
  { name: 'report', label: 'Write the report' },
];

export interface RunStep {
  name: StepName; label: string; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: string; endedAt?: string; ms?: number; note?: string; data?: any; attempts?: number;
}

export interface Chosen { postingId: string; company: string; title: string; fit: number; why: string; responseChance?: number }

export interface Report {
  summary: string;
  read: { postings: number; live: boolean; note: string; fresh: { company: string; title: string }[]; closed: { company: string; title: string }[] };
  readiness: { before?: number; after?: number };
  applied: { company: string; title: string; fit: number; why: string; state: string; detail?: string }[];
  replies: { source: string; searched: number; messages: number; note: string; changes: { company: string; from: string; to: string; subject: string }[] } | null;
  plan: { changed: boolean; summary: string } | null;
  needsYou: number;
  problems: string[];
}

export interface AutopilotRun {
  id: string; trigger: 'schedule' | 'manual'; startedAt: string; endedAt?: string; ms?: number;
  status: 'running' | 'done' | 'partial' | 'failed' | 'interrupted';
  steps: RunStep[]; report?: Report; resumes: number; dryRun?: boolean; owner?: string;
}

export const RUN_KIND = 'autopilot-run';
const LOCK = 'autopilot-lock';
const LOCK_STALE_MS = 90_000;
const BEAT_MS = 15_000;

export interface StepCtx {
  run: AutopilotRun;
  settings: AutopilotSettings;
  now: () => Date;
  /** Data an earlier step of this run left. */
  data: Partial<Record<StepName, any>>;
  note: (detail: string) => void;
}

export interface StepResult { note: string; data?: any; skipped?: boolean }
export type StepFns = Record<StepName, (ctx: StepCtx) => Promise<StepResult>>;

export interface Lock { runId: string; owner: string; at: string; beat: string }

export interface AutopilotDeps {
  steps: StepFns;
  now?: () => Date;
  /** This process; a lock held under another owner with no heartbeat is a crashed run's. */
  owner?: string;
  beatMs?: number;
}

export class BusyError extends Error {}

export function listRuns(limit = 30): AutopilotRun[] {
  return store.list<AutopilotRun>(RUN_KIND).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

export function getRun(id: string): AutopilotRun | undefined {
  return store.get<AutopilotRun>(RUN_KIND, id);
}

export function createAutopilot(d: AutopilotDeps) {
  const now = d.now ?? (() => new Date());
  const owner = d.owner ?? randomUUID();
  let active: Promise<AutopilotRun> | null = null;
  let activeId: string | null = null;

  const trace = (step: string, detail: string, status: 'start' | 'ok' | 'fail' = 'start') => {
    try { emit({ run: 'autopilot', step, detail, status }); } catch { /* best effort */ }
  };

  function lockHeld(): Lock | undefined {
    return store.get<Lock>('single', LOCK);
  }

  function takeLock(runId: string): boolean {
    const l = lockHeld();
    const t = now();
    if (l && l.runId !== runId) {
      const stale = t.getTime() - Date.parse(l.beat) > LOCK_STALE_MS;
      const mineIdle = l.owner === owner && !active;
      if (!stale && !mineIdle) return false;
    }
    store.put('single', LOCK, { runId, owner, at: t.toISOString(), beat: t.toISOString() } satisfies Lock);
    return true;
  }

  function beat(runId: string): void {
    const l = lockHeld();
    if (l?.runId === runId && l.owner === owner) store.put('single', LOCK, { ...l, beat: now().toISOString() });
  }

  function dropLock(runId: string): void {
    const l = lockHeld();
    if (l?.runId === runId && l.owner === owner) store.del('single', LOCK);
  }

  function save(run: AutopilotRun): AutopilotRun {
    store.put(RUN_KIND, run.id, run);
    return run;
  }

  async function execute(run: AutopilotRun): Promise<AutopilotRun> {
    const settings = getSettings();
    const data: Partial<Record<StepName, any>> = {};
    for (const s of run.steps) if (s.status === 'done' || s.status === 'skipped') data[s.name] = s.data;
    const timer = setInterval(() => beat(run.id), d.beatMs ?? BEAT_MS);
    timer.unref?.();
    try {
      for (const def of STEPS) {
        const step = run.steps.find((s) => s.name === def.name)!;
        if (step.status === 'done' || step.status === 'skipped') continue;
        // A step whose input failed, or was itself skipped for that reason, is skipped too.
        const missing = (def.needs ?? []).filter((n) => {
          const dep = run.steps.find((s) => s.name === n);
          return dep?.status === 'failed' || (dep?.status === 'skipped' && dep.note?.startsWith('skipped:'));
        });
        if (missing.length) {
          Object.assign(step, { status: 'skipped', note: `skipped: ${missing.join(', ')} failed`, endedAt: now().toISOString(), ms: 0 });
          save(run);
          continue;
        }
        const t0 = now();
        Object.assign(step, { status: 'running', startedAt: t0.toISOString(), attempts: (step.attempts ?? 0) + 1 });
        delete step.note;
        save(run);
        trace(def.name, def.label);
        try {
          const out = await d.steps[def.name]({ run, settings, now, data, note: (detail) => trace(def.name, detail) });
          const t1 = now();
          Object.assign(step, { status: out.skipped ? 'skipped' : 'done', note: out.note, data: out.data, endedAt: t1.toISOString(), ms: t1.getTime() - t0.getTime() });
          data[def.name] = out.data;
          trace(def.name, out.note, 'ok');
        } catch (e) {
          const t1 = now();
          Object.assign(step, { status: 'failed', note: (e as Error).message.slice(0, 300), endedAt: t1.toISOString(), ms: t1.getTime() - t0.getTime() });
          trace(def.name, (e as Error).message.slice(0, 200), 'fail');
        }
        save(run);
        beat(run.id);
      }
      const end = now();
      run.endedAt = end.toISOString();
      run.ms = end.getTime() - Date.parse(run.startedAt);
      const failed = run.steps.filter((s) => s.status === 'failed').length;
      run.status = failed === 0 ? 'done' : failed >= run.steps.length - 1 ? 'failed' : 'partial';
      run.report = data.report ?? run.report;
      save(run);
      trace('done', run.report?.summary ?? `${run.status} in ${Math.round((run.ms ?? 0) / 1000)} s`, run.status === 'failed' ? 'fail' : 'ok');
      return run;
    } finally {
      clearInterval(timer);
      dropLock(run.id);
    }
  }

  function launch(run: AutopilotRun): Promise<AutopilotRun> {
    activeId = run.id;
    active = execute(run).finally(() => { active = null; activeId = null; });
    return active;
  }

  return {
    owner,
    running: () => activeId,
    wait: () => active ?? Promise.resolve(null),

    /** Starts a run now. Refused while another runs, here or in a process that still holds the lock. */
    start(trigger: AutopilotRun['trigger'], o: { dryRun?: boolean } = {}): { run: AutopilotRun; done: Promise<AutopilotRun> } {
      if (active) throw new BusyError('A run is already going.');
      const t = now();
      const run: AutopilotRun = {
        id: `ap-${t.getTime().toString(36)}${randomUUID().slice(0, 4)}`, trigger, startedAt: t.toISOString(), status: 'running', resumes: 0, owner,
        steps: STEPS.map((s) => ({ name: s.name, label: s.label, status: 'pending' })), ...(o.dryRun ? { dryRun: true } : {}),
      };
      if (!takeLock(run.id)) throw new BusyError('Another Tack process is running the autopilot.');
      save(run);
      trace('start', `${trigger === 'manual' ? 'Run now' : 'Scheduled run'}${o.dryRun ? ' (dry run: nothing is submitted)' : ''}`);
      return { run, done: launch(run) };
    },

    /**
     * After a crash or restart: a run left "running" under a lock nobody keeps alive carries on from
     * the step it was in. Done steps are not repeated.
     */
    recover(): { run: AutopilotRun; done: Promise<AutopilotRun> } | null {
      if (active) return null;
      const left = store.list<AutopilotRun>(RUN_KIND).filter((r) => r.status === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (!left.length) return null;
      const [run, ...older] = left;
      for (const o of older) save({ ...o, status: 'interrupted', endedAt: now().toISOString() });
      const l = lockHeld();
      const alive = l && l.runId === run.id && l.owner !== owner && now().getTime() - Date.parse(l.beat) <= LOCK_STALE_MS;
      if (alive) return null;
      if (!takeLock(run.id)) return null;
      run.resumes++;
      run.owner = owner;
      for (const s of run.steps) if (s.status === 'running') s.status = 'pending';
      save(run);
      trace('resume', `carrying on run ${run.id} from ${run.steps.find((s) => s.status === 'pending')?.label ?? 'the report'}`);
      return { run, done: launch(run) };
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;

// ---------------------------------------------------------------- what the person sees

export interface Missing { key: string; label: string; where: string }

/** What a person still has to give before the autopilot can run, in the words the screen uses. */
export function readinessOf(i: {
  profile?: Profile; goal?: Goal; details?: { fullName?: string; email?: string; phone?: string }; resume: boolean; model: boolean; consent: boolean; demo: boolean;
}): { ready: boolean; missing: Missing[]; warnings: string[] } {
  const missing: Missing[] = [];
  if (!i.profile) missing.push({ key: 'profile', label: 'Your résumé, read into a profile', where: 'Start, step 01' });
  if (!i.goal?.targetRole) missing.push({ key: 'goal', label: 'A target role and place', where: 'Start, step 02' });
  const d = i.details ?? {};
  const contact = [!d.fullName && 'full name', !d.email && 'email', !d.phone && 'phone'].filter(Boolean) as string[];
  if (contact.length) missing.push({ key: 'details', label: `Your ${contact.join(', ').replace(/, ([^,]*)$/, ' and $1')}`, where: 'Start, Application details' });
  if (!i.resume) missing.push({ key: 'resume', label: 'Your résumé file, which forms upload', where: 'Start, step 01' });
  if (!i.model) missing.push({ key: 'model', label: 'A model key (GEMINI_API_KEY or TACK_MODEL_KEY)', where: 'the .env file or the desktop settings' });
  const warnings: string[] = [];
  if (!i.consent && !i.demo) warnings.push('Without your standing consent, Tack fills each form and stops before Submit. Give it under Application details on Start.');
  return { ready: !missing.length, missing, warnings };
}

/** Plain sentences for the run's report, written by code from what each step left. */
export function compileReport(data: Partial<Record<StepName, any>>, steps: RunStep[], jobs: queue.ApplyJob[]): Report {
  const h = data.harvest ?? {};
  const g = data.gap ?? {};
  const picks: Chosen[] = data.rank?.picks ?? [];
  const applied = picks.map((p) => {
    const j = jobs.filter((x) => x.postingId === p.postingId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { company: p.company, title: p.title, fit: p.fit, why: p.why, state: j?.state ?? (data.apply?.skipped?.find((s: { postingId: string }) => s.postingId === p.postingId) ? 'skipped' : 'not started'), detail: j?.detail ?? j?.reason };
  });
  const m: SyncResult | undefined = data.mail?.result;
  const replies = m ? {
    source: m.source, searched: m.searched, messages: m.messages, note: m.note,
    changes: m.changes.map((c) => ({ company: c.company, from: c.from, to: c.to, subject: c.subject })),
  } : null;
  const plan = data.replan ? { changed: !!data.replan.changed, summary: data.replan.summary ?? '' } : null;
  const problems = steps.filter((s) => s.status === 'failed').map((s) => `${s.label}: ${s.note ?? 'failed'}`);
  const sent = applied.filter((a) => a.state === 'submitted').length;
  const dry = applied.filter((a) => a.state === 'dry-run').length;
  const waiting = applied.filter((a) => a.state === 'needs-you' || a.state === 'awaiting-approval').length;
  const parts = [
    `Read ${h.postings ?? 0} postings${h.fresh?.length ? `, ${h.fresh.length} new` : ''}${h.closed?.length ? `, ${h.closed.length} closed` : ''}.`,
    g.after != null ? `Readiness ${g.before != null && g.before !== g.after ? `${g.before} to ${g.after}` : g.after}.` : '',
    picks.length ? `Picked ${picks.length}: ${dry ? `${dry} filled as a dry run` : `${sent} submitted`}${waiting ? `, ${waiting} waiting on you` : ''}.` : 'Nothing new cleared the bar to apply.',
    replies ? `Replies: ${replies.note}` : '',
    plan?.changed ? `Plan: ${plan.summary}` : '',
  ].filter(Boolean);
  return {
    summary: parts.join(' '),
    read: { postings: h.postings ?? 0, live: !!h.live, note: h.note ?? '', fresh: h.fresh ?? [], closed: h.closed ?? [] },
    readiness: { before: g.before, after: g.after },
    applied, replies, plan, needsYou: queue.needsYou().length, problems,
  };
}

/** Postings the settings let the autopilot apply to, best first, up to what is left of today's cap. */
export function choosePicks(next: { postingId: string; title: string; company: string; fit: number; why: string; responseChance: number }[], postings: Map<string, Posting>, s: AutopilotSettings, left: number): Chosen[] {
  const roles = s.excludeRoles.map((r) => r.toLowerCase());
  const companies = s.excludeCompanies.map((c) => queue.jobKey(c, '').split('|')[0]);
  const out: Chosen[] = [];
  for (const x of next) {
    if (out.length >= left) break;
    const p = postings.get(x.postingId);
    if (!p || p.closedAt) continue;
    if (x.fit < s.minFit) continue;
    if (roles.some((r) => x.title.toLowerCase().includes(r))) continue;
    if (companies.includes(queue.jobKey(x.company, '').split('|')[0])) continue;
    if (queue.duplicateOf(p)) continue;
    out.push({ postingId: x.postingId, company: x.company, title: x.title, fit: x.fit, why: x.why, responseChance: x.responseChance });
  }
  return out;
}

/** Whether progress or interviews call for a replan, and why. */
export function replanReason(i: { onTrack: boolean; interviewAvg: number | null; invites: number }): string | null {
  const why: string[] = [];
  if (!i.onTrack) why.push('behind the plan');
  if (i.interviewAvg != null && i.interviewAvg < 50) why.push(`the last mock interview scored ${i.interviewAvg}`);
  if (i.invites) why.push(`${i.invites} interview invitation${i.invites === 1 ? '' : 's'} came in`);
  return why.length ? `Autopilot: ${why.join(', ')}` : null;
}
