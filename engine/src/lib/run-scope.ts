/**
 * Which run the code currently executing belongs to.
 *
 * Several runs can be in flight at once, each awaiting its own model calls.
 * A single "current run" field would attribute one run's spend to another,
 * so the run id travels with the async call chain instead.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<string>();

export function inRun<T>(runId: string, work: () => Promise<T>): Promise<T> {
  return scope.run(runId, work);
}

export function currentRun(): string | null {
  return scope.getStore() ?? null;
}
