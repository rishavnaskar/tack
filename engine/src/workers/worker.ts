/**
 * Workers: scheduled, recurring agent runs.
 *
 * A worker is a saved goal plus a schedule plus limits. The runner ties
 * together everything else: the scheduler decides whether a slot is owed, the
 * run record opens before any work, the governor is asked before anything
 * outbound, the loop does the work, and the reflector proposes what to learn
 * from it.
 *
 * The invariants below all come from the same place — what a scheduled agent
 * does when nobody is watching is the only thing that matters about it:
 *
 *  - The run record opens BEFORE work starts, so a crash is visible.
 *  - A skipped slot is skipped, not queued.
 *  - Every run closes with an honest summary, including "this pass found less
 *    than usual, and here is why". Padding a thin result to look productive
 *    is the specific dishonesty a recurring digest invites.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BrowserRuntime, Tab } from '../observe/runtime.ts';
import type { Store } from '../store/db.ts';
import type { Memory } from '../memory/memory.ts';
import type { Approvals } from '../agent/approvals.ts';
import { runTask, type ModelLike, type RunResult, type AgentEvent, type RunTaskOptions } from '../agent/loop.ts';
import { checkedUpTo, decideSlot, isPeakPricing, type Slot, type WorkerSchedule, type SlotDecision } from './schedule.ts';
import { reviewFor, startOfDay, workerBrief } from './brief.ts';
import type { Delegator } from '../agent/delegate-action.ts';
import { RateGovernor, type RateLimit } from './governor.ts';
import type { PolicyContext } from '../policy/engine.ts';
import type { Capabilities } from '../policy/capabilities.ts';
import type { Sensitivity } from '../types.ts';
import type { AgentTools } from '../agent/tools.ts';
import type { Objectives } from '../agent/objective.ts';
import { atsIdentity, type Jobs } from '../jobs/jobs.ts';
import { companyFromUrl } from '../jobs/page-title.ts';
import type { Profile } from '../jobs/profile.ts';
import { LOCKED_SITE_DAILY_CAP, TERMS_LOCKED, type SitePolicies } from '../jobs/site-policies.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  goal          TEXT NOT NULL,
  schedule      TEXT NOT NULL,          -- JSON WorkerSchedule
  limits        TEXT NOT NULL,          -- JSON RateLimit[]
  policy        TEXT NOT NULL,          -- JSON PolicyContext
  enabled       INTEGER NOT NULL DEFAULT 1,
  max_steps     INTEGER NOT NULL DEFAULT 40,
  created_at    TEXT NOT NULL,
  last_check_at TEXT,
  last_run_due  TEXT,
  last_run_id   TEXT,
  mandate       TEXT,                   -- JSON Mandate
  sites         TEXT,                   -- JSON WorkerSite[]
  autonomy      TEXT,                   -- review_all | auto_known | auto_within_caps
  caps          TEXT,                   -- JSON Caps
  documents     TEXT,                   -- JSON Documents
  browser_mode  TEXT,                   -- dedicated | extension | auto
  status        TEXT NOT NULL DEFAULT 'active',  -- proposed | active | paused
  status_reason TEXT,
  conversation_id TEXT
);

CREATE TABLE IF NOT EXISTS worker_runs (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL,
  slot_due      TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT NOT NULL,          -- running | done | failed | awaiting_approval | skipped
  run_id        TEXT,
  summary       TEXT,
  late_minutes  INTEGER,
  cost_usd      REAL
);
CREATE INDEX IF NOT EXISTS worker_runs_lookup ON worker_runs(worker_id, started_at);
`;

export type Autonomy = 'review_all' | 'auto_known' | 'auto_within_caps';
export type WorkerStatus = 'proposed' | 'active' | 'paused';
export type BrowserMode = 'dedicated' | 'extension' | 'auto';

export interface Mandate {
  roles?: string[];
  seniority?: string[];
  locations?: string[];
  remote?: string[];
  salaryFloor?: string | null;
  postingAgeDays?: number | null;
  exclusions?: string[];
}

export interface WorkerSite {
  /** A key from the site policy catalog, e.g. "greenhouse". */
  site: string;
  enabled: boolean;
  dailyCap: number;
}

export interface Caps {
  dailyTotal: number;
  dailySpendUsd: number | null;
}

export interface WorkerDocuments {
  resumeId: string | null;
  coverLetterPolicy: 'when_required' | 'always' | 'never';
}

export interface WorkerDef {
  id: string;
  name: string;
  goal: string;
  schedule: WorkerSchedule;
  limits: RateLimit[];
  policy: PolicyContext;
  enabled: boolean;
  maxSteps: number;
  lastCheckAt: string | null;
  lastRunDue: string | null;
  mandate: Mandate;
  sites: WorkerSite[];
  autonomy: Autonomy;
  caps: Caps;
  documents: WorkerDocuments;
  browserMode: BrowserMode;
  status: WorkerStatus;
  statusReason: string | null;
  conversationId: string | null;
}

export const DEFAULT_CAPS: Caps = { dailyTotal: 15, dailySpendUsd: 1.5 };
export const DEFAULT_DOCUMENTS: WorkerDocuments = { resumeId: null, coverLetterPolicy: 'when_required' };

/** What creating a worker takes: its mandate, sites, autonomy, caps, documents and the rest all have defaults. */
export type WorkerSpec = Omit<WorkerDef,
  'id' | 'lastCheckAt' | 'lastRunDue' | 'mandate' | 'sites' | 'autonomy' | 'caps' | 'documents' | 'browserMode' | 'status' | 'statusReason' | 'conversationId'
> & Partial<Pick<WorkerDef, 'id' | 'mandate' | 'sites' | 'autonomy' | 'caps' | 'documents' | 'browserMode' | 'status' | 'statusReason' | 'conversationId'>>;

export interface WorkerRunSummary {
  workerRunId: string;
  workerId: string;
  status: 'done' | 'failed' | 'awaiting_approval' | 'skipped';
  summary: string;
  steps: number;
  costUsd: number;
  lateMinutes?: number;
  runId?: string;
}

export class Workers {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /** Workers made before v2 keep running: every new column has a default. */
  #migrate(): void {
    const have = new Set((this.#db.prepare("PRAGMA table_info('workers')").all() as Array<{ name: string }>).map((c) => c.name));
    const add: Array<[string, string]> = [
      ['mandate', 'TEXT'], ['sites', 'TEXT'], ['autonomy', 'TEXT'], ['caps', 'TEXT'], ['documents', 'TEXT'],
      ['browser_mode', 'TEXT'], ['status', "TEXT NOT NULL DEFAULT 'active'"], ['status_reason', 'TEXT'], ['conversation_id', 'TEXT'],
    ];
    for (const [name, decl] of add) if (!have.has(name)) this.#db.exec(`ALTER TABLE workers ADD COLUMN ${name} ${decl}`);
  }

  create(def: WorkerSpec): WorkerDef {
    const id = def.id ?? randomUUID();
    const status: WorkerStatus = def.status ?? (def.enabled ? 'active' : 'paused');
    this.#db.prepare(`
      INSERT INTO workers (id, name, goal, schedule, limits, policy, enabled, max_steps, created_at,
                           mandate, sites, autonomy, caps, documents, browser_mode, status, status_reason, conversation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, def.name, def.goal, JSON.stringify(def.schedule), JSON.stringify(def.limits),
           JSON.stringify(def.policy), def.enabled && status === 'active' ? 1 : 0, def.maxSteps, new Date().toISOString(),
           JSON.stringify(def.mandate ?? {}), JSON.stringify(def.sites ?? []), def.autonomy ?? 'auto_known',
           JSON.stringify(def.caps ?? DEFAULT_CAPS), JSON.stringify(def.documents ?? DEFAULT_DOCUMENTS),
           def.browserMode ?? 'dedicated', status, def.statusReason ?? null, def.conversationId ?? null);
    return this.get(id)!;
  }

  /** Change anything but identity. Everything here can change while the worker is running. */
  update(id: string, patch: Partial<Omit<WorkerDef, 'id' | 'lastCheckAt' | 'lastRunDue'>>): WorkerDef | null {
    const current = this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.#db.prepare(`
      UPDATE workers SET name = ?, goal = ?, schedule = ?, limits = ?, policy = ?, enabled = ?, max_steps = ?,
        mandate = ?, sites = ?, autonomy = ?, caps = ?, documents = ?, browser_mode = ?, status = ?, status_reason = ?,
        conversation_id = ?
      WHERE id = ?
    `).run(next.name, next.goal, JSON.stringify(next.schedule), JSON.stringify(next.limits), JSON.stringify(next.policy),
      next.enabled && next.status === 'active' ? 1 : 0, next.maxSteps, JSON.stringify(next.mandate), JSON.stringify(next.sites),
      next.autonomy, JSON.stringify(next.caps), JSON.stringify(next.documents), next.browserMode, next.status,
      next.statusReason ?? null, next.conversationId ?? null, id);
    return this.get(id);
  }

  /** Delete a worker. Its runs and applications stay: they happened. */
  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM workers WHERE id = ?').run(id).changes > 0;
  }

  setStatus(id: string, status: WorkerStatus, reason: string | null = null): void {
    // A slot from before the worker was on is not owed: start checking from now.
    this.#db.prepare(`UPDATE workers SET status = ?, status_reason = ?, enabled = ?,
      last_check_at = CASE WHEN ? = 1 AND enabled = 0 THEN ? ELSE last_check_at END WHERE id = ?`)
      .run(status, reason, status === 'active' ? 1 : 0, status === 'active' ? 1 : 0, new Date().toISOString(), id);
  }

  /** Workers proposed from a thread, waiting for the user to turn them on. */
  proposedIn(conversationId: string): WorkerDef[] {
    return (this.#db.prepare("SELECT * FROM workers WHERE conversation_id = ? AND status = 'proposed' ORDER BY created_at")
      .all(conversationId) as Array<Record<string, unknown>>).map(toWorker);
  }

  get(id: string): WorkerDef | null {
    const row = this.#db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toWorker(row) : null;
  }

  list(): WorkerDef[] {
    return (this.#db.prepare('SELECT * FROM workers ORDER BY name').all() as Array<Record<string, unknown>>)
      .map(toWorker);
  }

  /** What this worker should do right now, without doing it. */
  decide(id: string, now = new Date()): SlotDecision | { action: 'disabled' } {
    const worker = this.get(id);
    if (!worker) throw new Error(`no such worker: ${id}`);
    if (!worker.enabled) return { action: 'disabled' };
    const { lastCheck, lastRunDue } = this.#window(worker, now);
    return decideSlot(worker.schedule, lastCheck, now, lastRunDue);
  }

  #window(worker: WorkerDef, now: Date): { lastCheck: Date; lastRunDue?: Date } {
    // Never look back past the day the worker was made: slots before it are not owed.
    const row = this.#db.prepare('SELECT created_at FROM workers WHERE id = ?').get(worker.id) as { created_at: string } | undefined;
    const earliest = row?.created_at ? new Date(row.created_at) : new Date(now.getTime() - 86_400_000);
    return {
      lastCheck: worker.lastCheckAt ? new Date(worker.lastCheckAt) : earliest,
      lastRunDue: worker.lastRunDue ? new Date(worker.lastRunDue) : undefined,
    };
  }

  /** Note that the schedule was looked at, up to a slot still waiting out its jitter. */
  recordCheck(id: string, now = new Date()): void {
    const worker = this.get(id);
    const window = worker ? this.#window(worker, now) : null;
    const upTo = worker && window ? checkedUpTo(worker.schedule, window.lastCheck, now, window.lastRunDue) : now;
    this.#db.prepare('UPDATE workers SET last_check_at = ? WHERE id = ?').run(upTo.toISOString(), id);
  }

  /** What this worker's runs have cost since a moment, for the daily spend cap. */
  spentSince(workerId: string, since: Date): number {
    const row = this.#db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM worker_runs WHERE worker_id = ? AND started_at >= ?',
    ).get(workerId, since.toISOString()) as { spent: number };
    return Number(row.spent);
  }

  /**
   * What this worker's runs did since a moment: presses that reach someone
   * outside (a Submit, a message) against everything else they carried out.
   * Read from the runs' own steps, so the ordinary ones are counted too.
   */
  outreachSince(workerId: string, since: Date): { outreach: number; ordinary: number } {
    try {
      const rows = this.#db.prepare(`
        SELECT s.sensitivity AS sensitivity, COUNT(*) AS n FROM steps s JOIN worker_runs w ON w.run_id = s.run_id
        WHERE w.worker_id = ? AND w.started_at >= ? AND s.outcome = 'ok' AND s.sensitivity IS NOT NULL GROUP BY s.sensitivity
      `).all(workerId, since.toISOString()) as Array<{ sensitivity: string; n: number }>;
      let outreach = 0;
      let ordinary = 0;
      for (const r of rows) {
        if (r.sensitivity === 'CONTACT_EXTERNAL') outreach += Number(r.n);
        else ordinary += Number(r.n);
      }
      return { outreach, ordinary };
    } catch {
      // A store kept apart from the workers' (some tests) has no steps to read here.
      return { outreach: 0, ordinary: 0 };
    }
  }

  /** Tie a worker run to its agent run while it is still going. */
  linkRun(workerRunId: string, runId: string): void {
    this.#db.prepare('UPDATE worker_runs SET run_id = ? WHERE id = ?').run(runId, workerRunId);
  }

  runs(workerId: string, limit = 20): Array<Record<string, unknown>> {
    return this.#db.prepare(
      'SELECT * FROM worker_runs WHERE worker_id = ? ORDER BY started_at DESC LIMIT ?',
    ).all(workerId, limit) as Array<Record<string, unknown>>;
  }

  openRun(workerId: string, slotDue: Date | null, lateMinutes?: number): string {
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO worker_runs (id, worker_id, slot_due, started_at, status, late_minutes)
      VALUES (?,?,?,?,?,?)
    `).run(id, workerId, slotDue?.toISOString() ?? null, new Date().toISOString(), 'running', lateMinutes ?? null);
    return id;
  }

  closeRun(id: string, status: string, summary: string, runId?: string, costUsd?: number): void {
    this.#db.prepare(
      'UPDATE worker_runs SET status = ?, summary = ?, run_id = ?, cost_usd = ?, ended_at = ? WHERE id = ?',
    ).run(status, summary, runId ?? null, costUsd ?? null, new Date().toISOString(), id);
  }

  noteSlotRan(workerId: string, slotDue: Date): void {
    this.#db.prepare('UPDATE workers SET last_run_due = ? WHERE id = ?')
      .run(slotDue.toISOString(), workerId);
  }

  /**
   * Record that a slot could not even be attempted — typically because the
   * browser would not start.
   *
   * Recorded at most once per slot, so a scheduler retrying every thirty
   * seconds does not fill the log, and deliberately does NOT consume the
   * slot: the work is still owed and should run as soon as the browser is
   * available. Visible, because a worker that silently does nothing for an
   * hour is the failure this table exists to prevent.
   */
  recordSlotFailure(workerId: string, slotDue: Date, reason: string): boolean {
    const existing = this.#db.prepare(
      "SELECT id FROM worker_runs WHERE worker_id = ? AND slot_due = ? AND status = 'unstarted'",
    ).get(workerId, slotDue.toISOString());
    if (existing) return false;

    this.#db.prepare(`
      INSERT INTO worker_runs (id, worker_id, slot_due, started_at, ended_at, status, summary)
      VALUES (?,?,?,?,?,?,?)
    `).run(randomUUID(), workerId, slotDue.toISOString(), new Date().toISOString(),
           new Date().toISOString(), 'unstarted', reason);
    return true;
  }

  /** Runs left open by a crash. Surfacing these is the point of the table. */
  staleRuns(): Array<Record<string, unknown>> {
    return this.#db.prepare("SELECT * FROM worker_runs WHERE status = 'running'").all() as Array<Record<string, unknown>>;
  }
}

export interface TickOptions {
  workers: Workers;
  workerId: string;
  /**
   * The browser, or a function that produces one.
   *
   * A thunk matters for the scheduler: deciding a slot is skipped needs no
   * browser at all, and starting Chrome to write "skipped, past the grace
   * window" would keep one open on an idle machine.
   */
  page: BrowserRuntime | (() => Promise<BrowserRuntime>);
  model: ModelLike;
  store: Store;
  memory?: Memory;
  approvals?: Approvals;
  governor?: RateGovernor;
  capabilities?: Capabilities;
  /** Sensitivities that still stop for a person. Empty means the worker acts. */
  gate?: ReadonlySet<Sensitivity>;
  tools?: AgentTools;
  objectives?: Objectives;
  jobs?: Jobs;
  profile?: Profile;
  /** What answer_questions needs, so a worker parks a form's unknown questions on Review instead of stopping on each. */
  answering?: RunTaskOptions['answering'];
  sites?: SitePolicies;
  now?: Date;
  onEvent?: (e: AgentEvent) => void;
  /**
   * Run now, whatever the schedule says. Also runs a worker that is not
   * turned on: it holds no grant, so every submission stops for review,
   * which is what "run once first and show me" means.
   */
  force?: boolean;
  /** A tab of its own for this run, instead of the shared page. */
  openTab?: () => Promise<Tab>;
  /** Whether the run's tab is in the user's own Chrome, where sites that rule out extension automation are refused. */
  viaExtension?: () => boolean;
  /** Takes over the run's tab when a person still has to come back to it. */
  park?: (runId: string, tab: Tab) => void;
  /** Sub-agents for this run, held to the same policy as the worker. */
  delegatorFor?: (policy: PolicyContext) => Delegator;
  /** Called around the run itself, so it can be stopped from outside. */
  control?: { begin(workerRunId: string): AbortSignal; end(workerRunId: string): void };
}

/** Everything a tick needs beyond the worker being ticked and the time. */
export type TickContext = Omit<TickOptions, 'workers' | 'workerId' | 'now'>;

/**
 * Per-site daily caps as governor limits, keyed by the hosts the catalog
 * knows for each site.
 */
export function limitsFor(worker: WorkerDef, sites: SitePolicies | undefined): RateLimit[] {
  if (!sites) return worker.limits;
  const out: RateLimit[] = [...worker.limits];
  for (const s of worker.sites) {
    if (!s.enabled) continue;
    const policy = sites.get(s.site);
    if (!policy) continue;
    // A site whose terms forbid automated applying is never left uncapped,
    // whatever the worker was given before the person turned it on.
    const cap = s.dailyCap || (TERMS_LOCKED.has(policy.key) ? LOCKED_SITE_DAILY_CAP : 0);
    if (!cap) continue;
    for (const host of policy.hosts) {
      out.push({ platform: host.replace(/^\./, ''), action: 'apply', perDay: cap });
    }
  }
  return out;
}

/** A catalog site this worker is not given: the owner's standing yes sends nothing there for it. */
function notGiven(worker: WorkerDef, sites: SitePolicies | undefined): (url: string) => boolean {
  return (url) => {
    const site = sites?.forUrl(url);
    return !!site && !worker.sites.some((s) => s.enabled && s.site === site.key);
  };
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/** A run started by hand has no slot of its own; this stands in for one. */
function manualSlot(now: Date): Slot {
  return { due: now, fireAt: now, label: 'run now' };
}

/**
 * Advance one worker by one tick: run the owed slot, or explain why not.
 *
 * Returns null when there is nothing to do, so a caller polling many workers
 * can tell "nothing owed" from "ran and produced nothing".
 */
export async function tickWorker(opts: TickOptions): Promise<WorkerRunSummary | null> {
  const { workers, workerId, model, store, memory, approvals, governor, capabilities, gate, tools, objectives, jobs, profile, sites } = opts;
  const now = opts.now ?? new Date();

  const worker = workers.get(workerId);
  if (!worker) throw new Error(`no such worker: ${workerId}`);

  const forced: SlotDecision = { action: 'run', slot: manualSlot(now), lateMinutes: 0 };
  const decision = opts.force ? forced : workers.decide(workerId, now);
  if (!opts.force) workers.recordCheck(workerId, now);

  if (decision.action === 'disabled' || decision.action === 'wait') return null;

  const dayStart = startOfDay(now);
  // The daily total is checked before the browser opens. A worker at its cap
  // records the slot and says so, rather than running and applying to nothing.
  if (decision.action === 'run' && jobs && worker.caps.dailyTotal > 0) {
    const used = jobs.submittedSince(workerId, dayStart);
    if (used >= worker.caps.dailyTotal) {
      const why = `cap reached: ${used}/${worker.caps.dailyTotal} applications today`;
      const workerRunId = workers.openRun(workerId, opts.force ? null : decision.slot.due);
      workers.closeRun(workerRunId, 'skipped', why);
      if (!opts.force) workers.noteSlotRan(workerId, decision.slot.due);
      workers.update(workerId, { statusReason: 'cap reached' });
      return { workerRunId, workerId, status: 'skipped', summary: why, steps: 0, costUsd: 0 };
    }
  }

  if (decision.action === 'skip') {
    const workerRunId = workers.openRun(workerId, decision.slot.due);
    workers.closeRun(workerRunId, 'skipped', decision.why);
    workers.noteSlotRan(workerId, decision.slot.due);
    return {
      workerRunId, workerId, status: 'skipped', summary: decision.why, steps: 0, costUsd: 0,
    };
  }

  // Open the record BEFORE any work, so a crash leaves evidence. A manual
  // run claims no slot: it must not use up the one the schedule still owes.
  const workerRunId = workers.openRun(workerId, opts.force ? null : decision.slot.due, decision.lateMinutes);
  if (!opts.force) workers.noteSlotRan(workerId, decision.slot.due);

  // The worker's configured limits are installed before the run, so the
  // governor the loop consults is the one this worker was set up with.
  if (governor) for (const limit of limitsFor(worker, sites)) governor.setLimit(limit);

  const spendCap = worker.caps.dailySpendUsd;
  const spentToday = workers.spentSince(workerId, dayStart);
  if (spendCap !== null && spendCap > 0 && spentToday >= spendCap) {
    const why = `spend cap reached: ${usd(spentToday)} of ${usd(spendCap)} today`;
    workers.closeRun(workerRunId, 'skipped', why);
    workers.update(workerId, { statusReason: 'cap reached' });
    return { workerRunId, workerId, status: 'skipped', summary: why, steps: 0, costUsd: 0 };
  }

  let tab: Tab | null = null;
  let page: BrowserRuntime;
  try {
    if (opts.openTab) {
      tab = await opts.openTab();
      page = tab.page;
    } else {
      page = typeof opts.page === 'function' ? await opts.page() : opts.page;
    }
  } catch (err) {
    // The slot was already claimed above, so record the failure against it
    // rather than leaving a run open forever.
    const summary = `could not start the browser: ${(err as Error).message}`;
    workers.closeRun(workerRunId, 'failed', summary);
    return { workerRunId, workerId, status: 'failed', summary, steps: 0, costUsd: 0 };
  }

  const remainingToday = jobs && worker.caps.dailyTotal > 0
    ? Math.max(0, worker.caps.dailyTotal - jobs.submittedSince(workerId, dayStart))
    : null;
  // A grant can be scoped to this worker, so the loop has to know which
  // worker is asking. Without the id, a worker-scoped grant never matches.
  const policy: PolicyContext = {
    ...worker.policy, capabilities, gate, workerId, sites,
    ...(opts.viaExtension ? { viaExtension: opts.viaExtension } : {}),
    review: reviewFor(worker, { jobs, profile }),
  };
  const signal = opts.control?.begin(workerRunId);

  let result: RunResult;
  try {
    result = await runTask({
      goal: `${worker.goal}\n\n${workerBrief(worker, { sites, memory, remainingToday })}`,
      page, model, store, approvals, memory, governor, tools, objectives, jobs, profile, answering: opts.answering,
      maxSteps: worker.maxSteps,
      policy, signal,
      budgetUsd: spendCap !== null && spendCap > 0 ? Math.max(0, spendCap - spentToday) : undefined,
      delegate: opts.delegatorFor?.(policy),
      taskType: 'job_application',
      // Set to review everything, or not turned on and run once to be shown: the owner's standing yes sends nothing for it.
      askFirst: worker.autonomy === 'review_all' || worker.status !== 'active' ? true : notGiven(worker, sites),
      onEvent: (e) => {
        // Known as soon as the run exists, so a live view can read its steps.
        if (e.type === 'run_started') workers.linkRun(workerRunId, e.runId);
        opts.onEvent?.(e);
      },
    });
  } catch (err) {
    const summary = `run failed to start: ${(err as Error).message}`;
    workers.closeRun(workerRunId, 'failed', summary);
    await tab?.close().catch(() => {});
    return { workerRunId, workerId, status: 'failed', summary, steps: 0, costUsd: 0 };
  } finally {
    opts.control?.end(workerRunId);
  }

  if (tab) {
    // A page someone still has to come back to is handed over, not closed.
    if (result.status === 'awaiting_approval' && opts.park) opts.park(result.runId, tab);
    else await tab.close().catch(() => {});
  }

  // Roles the run named but never recorded are kept as found, by their address, so the list shows them.
  const named = jobs && result.runId ? keepNamed(jobs, workerId, result) : 0;
  // A job not judged for fit is worked on like one that fits; the summary says how many there were.
  const unjudged = jobs && result.runId ? jobs.list({ runId: result.runId, limit: 500 }).filter((a) => a.fit?.verdict === 'unknown').length : 0;
  const summary = summarise(worker, decision, result, workers, now) + (named ? `\n${(named === 1 ? COPY.namedOne : COPY.namedMany).replace('{n}', String(named))}` : '')
    + (unjudged ? `\n${(unjudged === 1 ? COPY.unjudgedOne : COPY.unjudgedMany).replace('{n}', String(unjudged))}` : '');
  const status = result.status === 'step_limit' || result.status === 'rate_limited' || result.status === 'continuing'
    ? 'failed' : result.status;
  workers.closeRun(workerRunId, status, summary, result.runId, result.costUsd);
  workers.update(workerId, { statusReason: statusReasonFor(result) });

  return {
    workerRunId, workerId,
    status: status as WorkerRunSummary['status'],
    summary, steps: result.steps, costUsd: result.costUsd,
    lateMinutes: decision.lateMinutes, runId: result.runId,
  };
}

/**
 * An honest close-out.
 *
 * States what happened, including when the answer is "less than usual". A
 * recurring digest creates constant pressure to look productive, and a worker
 * that pads a thin pass is worse than one that says the pass was thin.
 */
function summarise(
  worker: WorkerDef,
  decision: Extract<SlotDecision, { action: 'run' }>,
  result: RunResult,
  workers: Pick<Workers, 'outreachSince'>,
  now: Date,
): string {
  const lines: string[] = [];
  lines.push(`${worker.name} — slot ${decision.slot.label}`);
  if (decision.lateMinutes > 0) lines.push(`started ${decision.lateMinutes} min late, inside the grace window`);

  switch (result.status) {
    case 'done':
      lines.push(result.message);
      break;
    case 'awaiting_approval':
      lines.push(`paused for your approval: ${result.message}`);
      break;
    case 'step_limit':
      lines.push(`did not finish within ${worker.maxSteps} steps. Nothing was completed; this is not a partial result.`);
      break;
    case 'rate_limited':
      lines.push(`stopped at a rate limit: ${result.message}`);
      break;
    case 'failed':
      // A halt already says it stopped, and why.
      lines.push(result.halted ? result.message : `failed: ${result.message}`);
      break;
  }

  lines.push(`${result.steps} step${result.steps === 1 ? '' : 's'}, $${result.costUsd.toFixed(4)}${isPeakPricing(now) ? ' (peak pricing window)' : ''}`);

  // Counted from this worker's own runs: the governor's events are kept by site and hold outbound actions only.
  const week = workers.outreachSince(worker.id, new Date(now.getTime() - 7 * 86_400_000));
  if (week.outreach > 0 && week.outreach > week.ordinary) {
    lines.push(
      `note: ${week.outreach} outbound actions against ${week.ordinary} ordinary ones this week — ` +
      'that is not how a person uses this service.',
    );
  }
  return lines.join('\n');
}

/** What the person reads about roles a run named and did not record. */
const COPY = {
  namedNote: 'Named in a worker’s run that did not record it. Open it to check.',
  namedOne: 'One role named in this run was not recorded by it, so it is listed under Found.',
  namedMany: '{n} roles named in this run were not recorded by it, so they are listed under Found.',
  unjudgedOne: 'One job in this run was not judged for fit, because Fanfold doesn’t know enough about you yet. Add your résumé on Profile so Fanfold can judge your fit.',
  unjudgedMany: '{n} jobs in this run were not judged for fit, because Fanfold doesn’t know enough about you yet. Add your résumé on Profile so Fanfold can judge your fit.',
};

/**
 * Postings a run named in its last message but recorded nothing about, kept
 * as found by their address alone: nothing is said about them that the run
 * did not record. Only when the run recorded nothing at all, and only
 * addresses that are a posting on an applicant-tracking site.
 */
function keepNamed(jobs: Jobs, workerId: string, result: RunResult): number {
  if (jobs.list({ runId: result.runId, limit: 1 }).length) return 0;
  const urls = new Set([...result.message.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, '')));
  let n = 0;
  for (const url of urls) {
    if (!atsIdentity(url) || jobs.forPosting(url)) continue;
    const r = jobs.record({ job: { company: companyFromUrl(url), title: 'Posting', url }, status: 'found', workerId, runId: result.runId, url, fitNote: COPY.namedNote });
    if (r.ok) n++;
  }
  return n;
}

/** A first-class reason the board can show, derived from how the run ended. */
function statusReasonFor(result: RunResult): string | null {
  // A paused site or a sleeping display is not the browser failing to start.
  if (result.halted) return null;
  if (result.status === 'awaiting_approval') {
    if (/sign[- ]?in|log[- ]?in|signed out/i.test(result.message)) return 'sign-in needed';
    return 'waiting for you';
  }
  if (result.status === 'rate_limited') return 'cap reached';
  if (result.status === 'failed' && /browser/i.test(result.message)) return 'browser unavailable';
  return null;
}

function parse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function toWorker(row: Record<string, unknown>): WorkerDef {
  return {
    id: String(row.id),
    name: String(row.name),
    goal: String(row.goal),
    schedule: JSON.parse(String(row.schedule)) as WorkerSchedule,
    limits: JSON.parse(String(row.limits)) as RateLimit[],
    policy: JSON.parse(String(row.policy)) as PolicyContext,
    enabled: Number(row.enabled) === 1,
    maxSteps: Number(row.max_steps),
    lastCheckAt: row.last_check_at === null ? null : String(row.last_check_at),
    lastRunDue: row.last_run_due === null ? null : String(row.last_run_due),
    mandate: parse<Mandate>(row.mandate, {}),
    sites: parse<WorkerSite[]>(row.sites, []),
    autonomy: (row.autonomy as Autonomy) ?? 'auto_known',
    caps: parse<Caps>(row.caps, DEFAULT_CAPS),
    documents: parse<WorkerDocuments>(row.documents, DEFAULT_DOCUMENTS),
    browserMode: (row.browser_mode as BrowserMode) ?? 'dedicated',
    status: (row.status as WorkerStatus) ?? 'active',
    statusReason: row.status_reason === null || row.status_reason === undefined ? null : String(row.status_reason),
    conversationId: row.conversation_id === null || row.conversation_id === undefined ? null : String(row.conversation_id),
  };
}
