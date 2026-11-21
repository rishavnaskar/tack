/**
 * Worker runs in flight: starting one by hand, and stopping one.
 *
 * A worker has at most one run at a time, whether the schedule started it or
 * a person did. Each has a signal, so "stop" reaches the run itself.
 */
import type { Logger } from '../lib/log.ts';
import { tickWorker, type TickContext, type TickOptions, type Workers } from './worker.ts';

export interface WorkerRunsDeps {
  workers: Workers;
  /** Everything a run of this worker needs, apart from how it is stopped. */
  context(workerId: string): Promise<TickContext>;
  emit(event: { type: string; [key: string]: unknown }): void;
  log: Logger;
}

export class WorkerRuns {
  readonly #deps: WorkerRunsDeps;
  readonly #running = new Map<string, { abort: AbortController; workerRunId: string | null }>();

  constructor(deps: WorkerRunsDeps) {
    this.#deps = deps;
  }

  /** What a run of this worker calls around its work, so it can be stopped from outside. */
  control(workerId: string): NonNullable<TickOptions['control']> {
    return {
      begin: (workerRunId) => {
        // Made when the run was asked for, if it was asked for by hand, so a
        // stop pressed before this still lands.
        const run = this.#running.get(workerId) ?? { abort: new AbortController(), workerRunId: null };
        run.workerRunId = workerRunId;
        this.#running.set(workerId, run);
        this.#deps.emit({ type: 'worker_run_started', workerId, workerRunId });
        return run.abort.signal;
      },
      end: () => { this.#running.delete(workerId); },
    };
  }

  /**
   * Run a worker now, in the background. A worker that is not turned on runs
   * as a dry run: it holds no grant, so nothing is submitted without review.
   */
  start(workerId: string): { started: boolean; why?: string } {
    if (!this.#deps.workers.get(workerId)) throw new Error(`no such worker: ${workerId}`);
    if (this.#running.has(workerId)) return { started: false, why: 'this worker is already running' };
    // Claimed before the first await, so two presses cannot start two runs.
    this.#running.set(workerId, { abort: new AbortController(), workerRunId: null });
    void (async () => {
      try {
        const summary = await tickWorker({
          ...(await this.#deps.context(workerId)), workers: this.#deps.workers, workerId, force: true,
        });
        this.#deps.emit({ type: 'worker_tick', id: workerId, summary });
      } catch (err) {
        this.#deps.log.error('worker run failed', { component: 'worker', workerId, err });
        this.#deps.emit({ type: 'worker_tick', id: workerId, summary: { status: 'failed', summary: (err as Error).message } });
      } finally {
        this.#running.delete(workerId);
      }
    })();
    return { started: true };
  }

  active(): Array<{ workerId: string; workerRunId: string | null }> {
    return [...this.#running.entries()].map(([workerId, run]) => ({ workerId, workerRunId: run.workerRunId }));
  }

  /** Stop one worker's run, or every run. Returns how many were told to stop. */
  stop(workerId?: string): number {
    let stopped = 0;
    for (const [id, run] of this.#running) {
      if (workerId && id !== workerId) continue;
      run.abort.abort();
      stopped++;
    }
    return stopped;
  }
}
