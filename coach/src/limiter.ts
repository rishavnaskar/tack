// One model request budget for the whole app. Tack's own calls and the engine's (which reach the
// provider through a pass-through served on localhost) draw from the same per-minute window, lanes
// take turns so one busy session cannot starve the others, and every long wait shows in the trace.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { emit } from './trace.ts';
import { isHosted } from './hosted.ts';

const WINDOW_MS = 60_000;
export const MAX_PAUSE_MS = 65_000;

interface Waiter { lane: string; resolve: (waitedMs: number) => void; reject: (e: Error) => void; at: number; done: boolean }

export interface BudgetOpts {
  /** Requests a minute; read on every turn so a change in the environment applies at once. */
  rpm: () => number;
  now?: () => number;
  /** Schedules the next look at the queue. Replaced in tests by a manual clock. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  onWait?: (lane: string, waitedMs: number, queued: number) => void;
}

const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export class Budget {
  readonly #o: Required<Omit<BudgetOpts, 'onWait'>> & Pick<BudgetOpts, 'onWait'>;
  readonly #stamps: number[] = [];
  readonly #queues = new Map<string, Waiter[]>();
  // Lanes with someone waiting, in the order they take turns.
  readonly #ring: string[] = [];
  #pos = 0;
  #pausedUntil = 0;
  #cap: number | null = null;
  #cutAt = 0;
  #timer: { cancel(): void } | null = null;
  #timerAt = 0;

  constructor(o: BudgetOpts) {
    this.#o = { now: Date.now, schedule: realSchedule, ...o };
  }

  /** Resolves with how long it waited once this lane may send one request. */
  acquire(lane: string, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const w: Waiter = { lane, resolve, reject, at: this.#o.now(), done: false };
      const q = this.#queues.get(lane) ?? [];
      q.push(w);
      if (!this.#queues.has(lane)) { this.#queues.set(lane, q); this.#ring.push(lane); }
      signal?.addEventListener('abort', () => {
        if (w.done) return;
        w.done = true;
        const list = this.#queues.get(lane);
        if (list) {
          const i = list.indexOf(w);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this.#dropLane(lane);
        }
        reject(new Error('cancelled'));
      }, { once: true });
      this.#pump();
    });
  }

  /**
   * The provider said to slow down: nobody sends until then. A per-day quota can name hours; the
   * pause stops at a minute so the app keeps answering and the person sees the provider's refusals.
   */
  pause(ms: number): void {
    const now = this.#o.now();
    this.#pausedUntil = Math.max(this.#pausedUntil, now + Math.min(MAX_PAUSE_MS, Math.max(0, ms)));
    // The provider's real limit is lower than ours: send less from now on, and win it back a request a minute.
    this.#cap = Math.max(2, Math.floor(this.limit() * 0.6));
    this.#cutAt = now;
    this.#pump();
  }

  /** Requests a minute allowed now: the configured rate, or less for a while after the provider said no. */
  limit(): number {
    const max = Math.max(1, this.#o.rpm());
    if (this.#cap == null) return max;
    const v = Math.min(max, this.#cap + Math.floor((this.#o.now() - this.#cutAt) / WINDOW_MS));
    if (v >= max) this.#cap = null;
    return v;
  }

  /** How long a request asked for now would wait, roughly. */
  estimate(): number {
    const now = this.#o.now();
    this.#trim(now);
    const queued = this.queued();
    const rpm = this.limit();
    const free = Math.max(0, rpm - this.#stamps.length);
    const pause = Math.max(0, this.#pausedUntil - now);
    if (queued < free) return pause;
    const ahead = queued - free;
    return Math.max(pause, (this.#stamps[0] ?? now) + WINDOW_MS - now + Math.floor(ahead / rpm) * WINDOW_MS);
  }

  queued(): number {
    let n = 0;
    for (const q of this.#queues.values()) n += q.length;
    return n;
  }

  stats(): { rpm: number; limit: number; used: number; queued: Record<string, number>; pausedMs: number } {
    const now = this.#o.now();
    this.#trim(now);
    return {
      rpm: this.#o.rpm(), limit: this.limit(), used: this.#stamps.length, pausedMs: Math.max(0, this.#pausedUntil - now),
      queued: Object.fromEntries([...this.#queues].map(([k, v]) => [k, v.length])),
    };
  }

  #trim(now: number): void {
    while (this.#stamps.length && now - this.#stamps[0] >= WINDOW_MS) this.#stamps.shift();
  }

  #dropLane(lane: string): void {
    this.#queues.delete(lane);
    const i = this.#ring.indexOf(lane);
    if (i < 0) return;
    this.#ring.splice(i, 1);
    if (i < this.#pos) this.#pos--;
    if (this.#pos >= this.#ring.length) this.#pos = 0;
  }

  // Round robin over the lanes that have someone waiting.
  #next(): Waiter | undefined {
    if (!this.#ring.length) return undefined;
    if (this.#pos >= this.#ring.length) this.#pos = 0;
    const lane = this.#ring[this.#pos];
    const q = this.#queues.get(lane)!;
    const w = q.shift()!;
    if (!q.length) this.#dropLane(lane);
    else this.#pos = (this.#pos + 1) % this.#ring.length;
    return w;
  }

  #pump(): void {
    for (;;) {
      if (!this.#queues.size) return;
      const now = this.#o.now();
      this.#trim(now);
      const full = this.#stamps.length >= this.limit();
      const wait = Math.max(this.#pausedUntil - now, full ? this.#stamps[0] + WINDOW_MS - now + 5 : 0);
      if (wait > 0) {
        const at = now + wait;
        if (!this.#timer || at < this.#timerAt) {
          this.#timer?.cancel();
          this.#timerAt = at;
          this.#timer = this.#o.schedule(() => { this.#timer = null; this.#pump(); }, wait);
        }
        return;
      }
      const w = this.#next();
      if (!w) return;
      w.done = true;
      this.#stamps.push(now);
      const waited = now - w.at;
      if (waited > 1500) this.#o.onWait?.(w.lane, waited, this.queued());
      w.resolve(waited);
    }
  }
}

let shared: Budget | null = null;

/** Requests a minute the provider allows this key. A paid tier sets TACK_MODEL_RPM higher and simply runs faster. */
export function modelRpm(): number {
  return Number(process.env.TACK_MODEL_RPM) || 12;
}

export function sharedBudget(): Budget {
  shared ??= new Budget({
    rpm: modelRpm,
    onWait: (lane, ms, queued) => {
      // A turn is handed out from whichever request happened to run the queue, so in hosted mode
      // this line could land in another visitor's trace. llm.ts traces each caller's own wait.
      if (isHosted()) return;
      try {
        emit({ run: 'model', step: 'pace', detail: `${lane}: waited ${Math.round(ms / 1000)} s for a turn (${modelRpm()} a minute shared${queued ? `, ${queued} still queued` : ''})`, status: 'start' });
      } catch { /* tracing is best effort */ }
    },
  });
  return shared;
}

// ---------------------------------------------------------------- the pass-through

/** Which session a request belongs to: Tack names the session in every goal it writes. */
export function laneOf(body: string): string {
  const m = body.match(/\b(tack-[a-z0-9_-]{3,40})\b/i);
  return m ? m[1].toLowerCase() : 'engine';
}

/** How long the provider asked to wait, from its header or Gemini's body. */
export function retryDelayMs(headers: Headers, body: string, fallback = 5000): number {
  const h = Number(headers.get('retry-after'));
  if (h > 0) return h * 1000;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) + 250 : fallback;
}

export interface ModelProxy { url: string; token: string; port: number; close(): Promise<void> }

export interface ProxyOpts {
  /** The provider's OpenAI-compatible base, without /chat/completions. */
  upstream: string;
  key: string;
  budget?: Budget;
  fetchImpl?: typeof fetch;
  /** A request the provider turned away for load is tried again once if it can wait this long. */
  retryWithinMs?: number;
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/**
 * Starts the pass-through on 127.0.0.1. The engine is given its address and a key of its own; the
 * provider's key never leaves this process.
 */
export async function startModelProxy(o: ProxyOpts): Promise<ModelProxy> {
  const token = randomBytes(18).toString('hex');
  const budget = o.budget ?? sharedBudget();
  const doFetch = o.fetchImpl ?? fetch;
  const base = o.upstream.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '');
  const retryWithin = o.retryWithinMs ?? 30_000;
  const server: Server = createServer(async (req, res) => {
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown key' } }));
        return;
      }
      const path = (req.url ?? '/').replace(/^\/v1(?=\/)/, '');
      const body = req.method === 'POST' ? await readAll(req) : undefined;
      const paced = req.method === 'POST' && /\/chat\/completions$/.test(path);
      const lane = paced && body ? laneOf(body) : 'engine';
      for (let attempt = 0; ; attempt++) {
        if (paced) await budget.acquire(lane, gone.signal);
        const up = await doFetch(`${base}${path}`, {
          method: req.method, body, signal: gone.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${o.key}` },
        });
        const text = await up.text();
        if (up.status === 429 && paced) {
          const wait = Math.min(MAX_PAUSE_MS, retryDelayMs(up.headers, text));
          budget.pause(wait);
          const again = attempt === 0 && wait <= retryWithin;
          try {
            emit({ run: 'model', step: 'pace', detail: `${lane}: the provider is out of requests for now; ${again ? `every session waits ${Math.ceil(wait / 1000)} s` : 'passed back to the engine'}`, status: again ? 'start' : 'fail' });
          } catch { /* best effort */ }
          if (again) continue;
        }
        res.writeHead(up.status, {
          'content-type': up.headers.get('content-type') ?? 'application/json',
          ...(up.headers.get('retry-after') ? { 'retry-after': up.headers.get('retry-after')! } : {}),
        });
        res.end(text);
        return;
      }
    } catch (e) {
      if (gone.signal.aborted || res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `the model pass-through could not reach the provider: ${(e as Error).message}` } }));
    }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => ok()); });
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`, token, port,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
