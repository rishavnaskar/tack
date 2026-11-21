import type { TraceEvent } from './types.ts';

type Listener = (ev: TraceEvent) => void;

const listeners = new Set<Listener>();
const history: TraceEvent[] = [];
const KEEP = 200;
let seq = 0;

export function emit(ev: Omit<TraceEvent, 'id' | 'at'>): TraceEvent {
  const full: TraceEvent = { id: `${Date.now().toString(36).padStart(9, '0')}-${(seq++).toString(36).padStart(5, '0')}`, at: new Date().toISOString(), ...ev };
  history.push(full);
  if (history.length > KEEP) history.shift();
  for (const fn of listeners) {
    try { fn(full); } catch { /* a broken listener must not stop the others */ }
  }
  return full;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function recent(limit = 50): TraceEvent[] {
  return history.slice(-limit);
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
