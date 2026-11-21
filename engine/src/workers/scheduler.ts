/**
 * The thing that makes a scheduled worker actually run.
 *
 * Without it a worker is a manual run with a schedule written next to it.
 * This is the loop that checks due slots while the machine is on, so workers
 * recur.
 *
 * Two properties it has to have:
 *
 *  - Exactly one scheduler runs at a time, across processes. A lease in the
 *    database, not a variable in memory: the UI, a CLI and a restarted daemon
 *    can all be alive at once, and two schedulers would run the same slot
 *    twice. The lease expires, so a scheduler killed without cleanup does not
 *    block the next one forever.
 *
 *  - One slot runs once. The due-slot decision is persisted per worker
 *    (`last_run_due`) before the work starts, so a crash mid-run does not
 *    re-arm the same slot, and a concurrent trigger cannot claim it either.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Workers, tickWorker, type TickContext, type TickOptions, type WorkerRunSummary } from './worker.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';

function resolvePage(page: TickOptions['page']): Promise<BrowserRuntime> {
  return typeof page === 'function' ? page() : Promise.resolve(page);
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_lease (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

const LEASE_ID = 'singleton';

function sitesOf(worker: { sites?: Array<{ site: string; enabled?: boolean }> }): string[] {
  return (worker.sites ?? []).filter((entry) => entry.enabled !== false).map((entry) => entry.site);
}

export interface SchedulerOptions {
  db: DatabaseSync;
  workers: Workers;
  /**
   * Everything tickWorker needs, minus the worker being ticked.
   *
   * Async and called only once a slot is actually owed, because building it
   * means starting a browser. An eagerly evaluated context would throw on a
   * fresh app — `page` is not available until the browser has been launched —
   * so every tick would fail before doing any work.
   */
  context: (workerId: string) => Promise<TickContext>;
  /** How often to look for due slots. */
  intervalMs?: number;
  /**
   * How many workers may run at the same time in one pass. One unless the
   * caller says otherwise: workers may only overlap when each run works on a
   * tab of its own, which is the caller's to promise. Workers that share a
   * site never overlap, whatever this is.
   */
  concurrency?: number;
  /** How long a lease survives without a heartbeat. */
  leaseMs?: number;
  onRun?: (summary: WorkerRunSummary) => void;
  onError?: (workerId: string, err: Error) => void;
  now?: () => Date;
  /**
   * Reflect on recent runs this often.
   *
   * Learning that only happens when someone presses a button is not
   * continuous improvement. It runs on the same lease as the workers, so two
   * processes cannot reflect over the same runs at once, and far less often
   * than the worker tick because gating costs a full eval suite per
   * candidate.
   */
  learnEveryMs?: number;
  /**
   * Reflection, which must stop if the lease is lost mid-pass.
   *
   * Without the signal the heartbeat could only report the loss; a reflection
   * already running would carry on spending model calls alongside whoever
   * holds the lease now.
   */
  learn?: (signal: AbortSignal) => Promise<unknown>;
  onLearned?: (result: unknown) => void;
  /** True while nothing may run by itself (Fanfold is locked): a pass then does nothing at all. */
  held?: () => boolean;
}

export class Scheduler {
  #db: DatabaseSync;
  #workers: Workers;
  #opts: SchedulerOptions;
  #owner = randomUUID();
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #ticking = false;
  #learning = false;
  #lastLearnedAt = 0;
  #heartbeat: NodeJS.Timeout | null = null;
  #learnAbort: AbortController | null = null;

  constructor(opts: SchedulerOptions) {
    this.#db = opts.db;
    this.#db.exec(SCHEMA);
    this.#workers = opts.workers;
    this.#opts = opts;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get holdsLease(): boolean {
    const row = this.#db.prepare('SELECT owner, expires_at FROM scheduler_lease WHERE id = ?').get(LEASE_ID) as
      { owner: string; expires_at: string } | undefined;
    if (!row) return false;
    return row.owner === this.#owner && new Date(row.expires_at) > this.#now();
  }

  #now(): Date {
    return this.#opts.now ? this.#opts.now() : new Date();
  }

  /**
   * Take the lease if it is free or expired, or renew our own.
   *
   * A compare-and-set on the row rather than a read-then-write, so two
   * schedulers racing cannot both conclude they won.
   */
  acquireLease(): boolean {
    const now = this.#now();
    const expires = new Date(now.getTime() + (this.#opts.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();

    const updated = this.#db.prepare(`
      UPDATE scheduler_lease
      SET owner = ?, renewed_at = ?, expires_at = ?,
          acquired_at = CASE WHEN owner = ? THEN acquired_at ELSE ? END
      WHERE id = ? AND (owner = ? OR expires_at <= ?)
    `).run(this.#owner, now.toISOString(), expires, this.#owner, now.toISOString(),
           LEASE_ID, this.#owner, now.toISOString());

    if (Number(updated.changes) > 0) return true;

    // No row yet. INSERT OR IGNORE so a racing scheduler's row wins cleanly
    // rather than both of us believing we created it.
    const inserted = this.#db.prepare(`
      INSERT OR IGNORE INTO scheduler_lease (id, owner, acquired_at, renewed_at, expires_at)
      VALUES (?,?,?,?,?)
    `).run(LEASE_ID, this.#owner, now.toISOString(), now.toISOString(), expires);
    return Number(inserted.changes) > 0;
  }

  releaseLease(): void {
    this.#db.prepare('DELETE FROM scheduler_lease WHERE id = ? AND owner = ?').run(LEASE_ID, this.#owner);
  }

  /**
   * One pass: run whatever is owed. Safe to call directly in tests.
   *
   * Returns the summaries produced, so "nothing was due" is distinguishable
   * from "ran and found nothing".
   */
  async tickOnce(): Promise<WorkerRunSummary[]> {
    if (this.#ticking) return [];        // never overlap a pass with itself
    if (this.#opts.held?.()) return [];   // locked: no worker, no reflection
    if (!this.acquireLease()) return [];  // someone else is the scheduler
    this.#ticking = true;
    // A single worker run or a full eval suite can easily outlive the lease
    // window. Renewing only between workers would let a second process take
    // over while a long one was still going; the heartbeat keeps "one
    // scheduler at a time" an invariant.
    this.#startHeartbeat();

    const summaries: WorkerRunSummary[] = [];
    try {
      const pending = this.#workers.list().filter((worker) => worker.enabled);
      const lanes = Math.max(1, this.#opts.concurrency ?? 1);
      // Sites being worked right now. Two workers never apply on one site at
      // the same moment, however many lanes are free.
      const busy = new Set<string>();
      let active = 0;
      let stoodDown = false;
      await new Promise<void>((resolve) => {
        const pump = (): void => {
          while (active < lanes && !stoodDown) {
            const at = pending.findIndex((worker) => !sitesOf(worker).some((site) => busy.has(site)));
            if (at < 0) break;
            // Fence each worker on the lease. If it was lost, stop rather
            // than racing whoever holds it now.
            if (!this.holdsLease) {
              stoodDown = true;
              this.#opts.onError?.('scheduler', new Error('lease lost; standing down mid-pass'));
              break;
            }
            const [worker] = pending.splice(at, 1);
            const sites = sitesOf(worker);
            active++;
            for (const site of sites) busy.add(site);
            // Nothing here may reject: an error with nowhere to go ends the
            // whole process, and a pass that never resolves holds the lease
            // for good. Every failure is reported and the pass carries on.
            void this.#runIfOwed(worker.id).then((summary) => {
              if (!summary) return;
              summaries.push(summary);
              this.#opts.onRun?.(summary);
            }).catch((err: unknown) => {
              this.#opts.onError?.(worker.id, err as Error);
            }).finally(() => {
              active--;
              for (const site of sites) busy.delete(site);
              try {
                // Renew between workers: a long run must not let the lease
                // lapse and invite a second scheduler to start alongside it.
                this.acquireLease();
                pump();
              } catch (err) {
                stoodDown = true;
                this.#opts.onError?.('scheduler', err as Error);
                if (active === 0) resolve();
              }
            });
          }
          // With nothing running no site is busy, so whatever is left could
          // have started: the pass is over, or it stood down.
          if (active === 0) resolve();
        };
        pump();
      });
    } finally {
      this.#ticking = false;
    }

    try {
      await this.#maybeLearn();
    } finally {
      this.#stopHeartbeat();
    }
    return summaries;
  }

  /** Run one worker if a slot is owed. Null when nothing was, or when it could not start. */
  async #runIfOwed(workerId: string): Promise<WorkerRunSummary | null> {
    // Ask first whether anything is owed. Building a browser for a pass
    // with nothing due would keep Chrome open all day for nothing.
    const decision = this.#workers.decide(workerId, this.#now());
    if (decision.action === 'wait' || decision.action === 'disabled') {
      this.#workers.recordCheck(workerId, this.#now());
      return null;
    }
    // Build the context BEFORE claiming the slot. If the browser will not
    // start, the slot stays owed and is retried on the next pass, with
    // one visible record rather than silence. Skips get here too and cost
    // nothing, because the page inside the context is a thunk.
    let context: TickContext;
    try {
      context = await this.#opts.context(workerId);
      if (decision.action === 'run') {
        // Prove the browser is actually available before claiming the
        // slot; a thunk that throws later would burn it.
        context = { ...context, page: await resolvePage(context.page) };
      }
    } catch (err) {
      const reason = `could not start the browser: ${(err as Error).message}`;
      const slotDue = decision.action === 'run' || decision.action === 'skip' ? decision.slot.due : this.#now();
      const recorded = this.#workers.recordSlotFailure(workerId, slotDue, reason);
      if (recorded) this.#opts.onError?.(workerId, new Error(reason));
      return null;
    }

    try {
      return await tickWorker({ ...context, workers: this.#workers, workerId, now: this.#now() }) ?? null;
    } catch (err) {
      this.#opts.onError?.(workerId, err as Error);
      return null;
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) return;
    const lease = this.#opts.leaseMs ?? DEFAULT_LEASE_MS;
    // Renew well inside the window so a slow tick does not let it lapse.
    this.#heartbeat = setInterval(() => {
      if (!this.acquireLease()) {
        // Lost it despite renewing — another process took over. Reporting it
        // is not enough: a reflection already in flight would keep spending
        // model calls alongside whoever holds the lease now, so it is
        // cancelled rather than left to finish.
        this.#opts.onError?.('scheduler', new Error('lost the scheduler lease while working'));
        this.#learnAbort?.abort(new Error('scheduler lease lost'));
      }
    }, Math.max(1_000, Math.floor(lease / 3)));
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat(): void {
    if (!this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  /**
   * Reflect on recent runs, if it is time and nothing else is doing it.
   *
   * Deliberately after the worker pass: a reflection that takes a minute
   * should not delay a due slot.
   */
  async #maybeLearn(): Promise<void> {
    const every = this.#opts.learnEveryMs;
    if (!every || !this.#opts.learn || this.#learning) return;
    // Reflection is the longest thing this process does and costs real model
    // calls; two processes doing it at once would duplicate that spend.
    if (!this.holdsLease) return;
    const now = this.#now().getTime();
    if (this.#lastLearnedAt && now - this.#lastLearnedAt < every) return;

    this.#learning = true;
    this.#lastLearnedAt = now;
    this.#learnAbort = new AbortController();
    try {
      const result = await this.#opts.learn(this.#learnAbort.signal);
      this.#opts.onLearned?.(result);
    } catch (err) {
      this.#opts.onError?.('learning', err as Error);
    } finally {
      this.#learning = false;
      this.#learnAbort = null;
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const interval = this.#opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const pump = (): void => {
      void this.tickOnce().catch((err) => this.#opts.onError?.('scheduler', err as Error));
    };
    this.#timer = setInterval(pump, interval);
    // Do not hold the process open on the scheduler's account; the server's
    // listener is what keeps it alive.
    this.#timer.unref?.();
    pump();
  }

  stop(): void {
    this.#running = false;
    this.#learnAbort?.abort(new Error('scheduler stopped'));
    this.#stopHeartbeat();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.releaseLease();
  }
}
