import { useSyncExternalStore } from 'react';
import { api } from './client';
import { invalidate } from './query';
import { keys } from './hooks';
import type { ApplyBatch, ApplyRun } from './types';

/*
 * Batches of automated applications the person started from this tab, polled until every run ends.
 * Tracker and the kit sheet read the same store, so a run started in one shows in the other.
 */

const POLL_MS = 1200;
let batches: ApplyBatch[] = [];
const listeners = new Set<() => void>();
const polling = new Set<string>();

function set(next: ApplyBatch[]) {
  batches = next;
  listeners.forEach((l) => l());
}

function upsert(b: ApplyBatch) {
  const i = batches.findIndex((x) => x.id === b.id);
  set(i >= 0 ? batches.map((x) => (x.id === b.id ? b : x)) : [b, ...batches].slice(0, 6));
}

async function poll(id: string) {
  if (polling.has(id)) return;
  polling.add(id);
  let applied = 0;
  try {
    for (;;) {
      await new Promise((r) => window.setTimeout(r, POLL_MS));
      let b: ApplyBatch;
      try {
        b = await api.applyBatch(id);
      } catch {
        continue;
      }
      upsert(b);
      const now = b.runs.filter((r) => r.status === 'applied').length;
      // Each confirmed application lands in the pipeline as it happens, not when the last one ends.
      if (now !== applied) {
        applied = now;
        invalidate(keys.applications, keys.insights, keys.state);
      }
      if (b.endedAt) break;
    }
  } finally {
    polling.delete(id);
  }
}

export const applying = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => batches,
  async start(postingIds: string[]) {
    const res = await api.apply(postingIds);
    upsert(res.batch);
    void poll(res.batch.id);
    return res;
  },
  async top(n: number) {
    const res = await api.applyTop(n);
    upsert(res.batch);
    void poll(res.batch.id);
    return res;
  },
  dismiss(id: string) {
    set(batches.filter((b) => b.id !== id));
  },
};

export function useBatches(): ApplyBatch[] {
  return useSyncExternalStore(applying.subscribe, applying.get);
}

/** The newest run for a posting started from this tab, if any. */
export function useRunFor(postingId?: string): ApplyRun | undefined {
  const all = useBatches();
  if (!postingId) return undefined;
  for (const b of all) {
    const r = b.runs.find((x) => x.postingId === postingId);
    if (r) return r;
  }
  return undefined;
}

export const isActive = (r: ApplyRun) => r.status === 'queued' || r.status === 'running';
