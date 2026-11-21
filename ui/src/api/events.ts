import { useSyncExternalStore } from 'react';
import { api, MOCK } from './client';
import { fetchQuery } from './query';
import type { TraceEvent } from './types';

/*
 * One shared subscription to /api/events (or the mock bus). The store keeps the last
 * events, whether a run is active, and whether the trace rail is open.
 */

const MAX_EVENTS = 400;
const QUIET_MS = 2600;

export interface TraceSnapshot {
  events: TraceEvent[];
  connected: boolean;
  /** Long calls this tab started that have not returned yet. */
  pending: number;
  /** Label of the newest pending long call. */
  pendingLabel?: string;
  /** An event arrived in the last few seconds. */
  hot: boolean;
  open: boolean;
  /** Events that arrived while the rail was closed. */
  unseen: number;
}

let snap: TraceSnapshot = { events: [], connected: false, pending: 0, hot: false, open: false, unseen: 0 };
const listeners = new Set<() => void>();
const labels: string[] = [];
let started = false;
let quietTimer: number | undefined;
let closeTimer: number | undefined;
// true while the rail is open only because a long call opened it
let autoOpened = false;

function set(patch: Partial<TraceSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

function push(e: TraceEvent) {
  if (snap.events.length && snap.events[snap.events.length - 1].id === e.id) return;
  const events = snap.events.length >= MAX_EVENTS ? [...snap.events.slice(-MAX_EVENTS + 1), e] : [...snap.events, e];
  set({ events, hot: true, unseen: snap.open ? 0 : snap.unseen + 1 });
  window.clearTimeout(quietTimer);
  quietTimer = window.setTimeout(() => set({ hot: false }), QUIET_MS);
}

function parse(raw: string): TraceEvent | null {
  try {
    const e = JSON.parse(raw) as Partial<TraceEvent>;
    if (!e || typeof e !== 'object' || !e.step) return null;
    return {
      id: e.id ?? `${e.at ?? Date.now()}-${e.step}`,
      at: e.at ?? new Date().toISOString(),
      run: e.run ?? 'run',
      step: e.step,
      detail: e.detail ?? '',
      status: e.status ?? 'ok',
      ms: e.ms,
    };
  } catch {
    return null;
  }
}

function connect() {
  if (started) return;
  started = true;
  if (MOCK) {
    import('./mock').then((m) => {
      set({ connected: true });
      m.bus.subscribe(push);
    });
    return;
  }
  if (typeof EventSource === 'undefined') return;
  // The stream opens once the server has answered the state request ('state' is the hooks' key),
  // so on the web preview it carries the session cookie that answer set.
  const open = () => {
    const source = new EventSource(api.eventsUrl());
    const onMessage = (ev: MessageEvent<string>) => {
      const e = parse(ev.data);
      if (e) push(e);
    };
    source.onopen = () => set({ connected: true });
    source.onerror = () => set({ connected: false });
    source.onmessage = onMessage;
    source.addEventListener('trace', onMessage as EventListener);
  };
  fetchQuery('state', api.state).catch(() => undefined).finally(open);
}

const wide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 720px)').matches;

export const trace = {
  subscribe(l: () => void) {
    listeners.add(l);
    connect();
    return () => {
      listeners.delete(l);
    };
  },
  get: () => snap,
  push,
  /**
   * Marks the start of a long call. Opens the rail on wide screens.
   * Returns a function that marks it done.
   */
  begin(label: string, opts: { open?: boolean } = {}) {
    labels.push(label);
    const open = opts.open ?? wide();
    window.clearTimeout(closeTimer);
    if (open && !snap.open) autoOpened = true;
    set({ pending: snap.pending + 1, pendingLabel: label, open: open ? true : snap.open, unseen: open ? 0 : snap.unseen });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = labels.lastIndexOf(label);
      if (i >= 0) labels.splice(i, 1);
      set({ pending: Math.max(0, snap.pending - 1), pendingLabel: labels[labels.length - 1] });
      if (snap.pending === 0 && autoOpened) {
        closeTimer = window.setTimeout(() => {
          if (snap.pending === 0 && autoOpened) {
            autoOpened = false;
            set({ open: false });
          }
        }, 2400);
      }
    };
  },
  setOpen(open: boolean) {
    autoOpened = false;
    window.clearTimeout(closeTimer);
    set({ open, unseen: open ? 0 : snap.unseen });
  },
  clear() {
    set({ events: [], unseen: 0 });
  },
};

/** Wraps a promise as a long call: rail opens, dot pulses until it settles. */
export async function tracked<T>(label: string, work: () => Promise<T>, opts?: { open?: boolean }): Promise<T> {
  const end = trace.begin(label, opts);
  try {
    return await work();
  } finally {
    end();
  }
}

export function useTrace(): TraceSnapshot {
  return useSyncExternalStore(trace.subscribe, trace.get);
}

export function useTraceActive(): boolean {
  const s = useTrace();
  return s.pending > 0 || s.hot;
}

/** The newest event, optionally limited to events that arrived after `since` (ms epoch). */
export function useLatestTrace(since = 0): TraceEvent | undefined {
  const s = useTrace();
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (Date.parse(e.at) >= since) return e;
    break;
  }
  return undefined;
}
