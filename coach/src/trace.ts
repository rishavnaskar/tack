import type { TraceEvent } from './types.ts';
import { currentVisitor, isHosted, limits, onDrop, onTick } from './hosted.ts';

type Listener = (ev: TraceEvent) => void;

interface Hub { listeners: Set<Listener>; history: TraceEvent[]; seq: number; used: number }

const KEEP = 200;
const newHub = (): Hub => ({ listeners: new Set(), history: [], seq: 0, used: Date.now() });

// One hub for the desktop; in hosted mode one per visitor, so nobody sees another person's runs.
const local = newHub();
const hubs = new Map<string, Hub>();

onDrop((key) => { hubs.delete(key); });
onTick((now) => {
  const idle = limits().idleCloseMs;
  for (const [key, h] of [...hubs.entries()]) if (!h.listeners.size && now - h.used > idle) hubs.delete(key);
});

function hub(): Hub | null {
  if (!isHosted()) return local;
  const v = currentVisitor();
  if (!v) return null;
  let h = hubs.get(v.key);
  if (!h) { h = newHub(); hubs.set(v.key, h); }
  h.used = Date.now();
  return h;
}

export function emit(ev: Omit<TraceEvent, 'id' | 'at'>): TraceEvent {
  const h = hub();
  const full: TraceEvent = { id: `${Date.now().toString(36).padStart(9, '0')}-${((h?.seq ?? 0)).toString(36).padStart(5, '0')}`, at: new Date().toISOString(), ...ev };
  // Hosted events outside any visitor's request belong to nobody and go nowhere.
  if (!h) return full;
  h.seq++;
  h.history.push(full);
  if (h.history.length > KEEP) h.history.shift();
  for (const fn of h.listeners) {
    try { fn(full); } catch { /* a broken listener must not stop the others */ }
  }
  return full;
}

export function subscribe(fn: Listener): () => void {
  const h = hub();
  if (!h) return () => {};
  h.listeners.add(fn);
  return () => { h.listeners.delete(fn); };
}

export function recent(limit = 50): TraceEvent[] {
  return hub()?.history.slice(-limit) ?? [];
}

export function run(name: string) {
  const t0 = Date.now();
  const since = () => Date.now() - t0;
  emit({ run: name, step: 'start', detail: '', status: 'start', ms: 0 });
  return {
    step(step: string, detail = '') { emit({ run: name, step, detail, status: 'start', ms: since() }); },
    ok(detail = '') { emit({ run: name, step: 'done', detail, status: 'ok', ms: since() }); },
    fail(detail: string) { emit({ run: name, step: 'failed', detail, status: 'fail', ms: since() }); },
  };
}

export type Run = ReturnType<typeof run>;
