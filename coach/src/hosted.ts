// Hosted mode (TACK_HOSTED=1): the coach as a public web preview. Each visitor gets an anonymous
// session; the store, the trace and the model budget follow it through AsyncLocalStorage, so the
// domain modules keep calling store.get/put as they do on the desktop.
//
// This module imports nothing from the rest of the coach. store.ts and trace.ts hook into it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

export function isHosted(): boolean {
  return process.env.TACK_HOSTED === '1';
}

const MB = 1024 * 1024;

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function limits() {
  return {
    maxSessions: envNum('TACK_MAX_SESSIONS', 500),
    sessionTtlMs: envNum('TACK_SESSION_TTL_HOURS', 24) * 3_600_000,
    idleCloseMs: envNum('TACK_SESSION_IDLE_MINUTES', 10) * 60_000,
    newSessionsPerIpHour: envNum('TACK_NEW_SESSIONS_PER_IP_HOUR', 60),
    ipPerMinute: envNum('TACK_RATE_IP_PER_MINUTE', 240),
    sessionPerMinute: envNum('TACK_RATE_SESSION_PER_MINUTE', 120),
    sessionInflight: envNum('TACK_SESSION_INFLIGHT', 4),
    streamsPerSession: envNum('TACK_STREAMS_PER_SESSION', 4),
    streamsPerIp: envNum('TACK_STREAMS_PER_IP', 16),
    jsonBytes: envNum('TACK_MAX_JSON_MB', 1) * MB,
    resumeBytes: envNum('TACK_MAX_RESUME_MB', 5) * MB,
    budget: {
      sessionHour: envNum('TACK_BUDGET_SESSION_HOUR', 30),
      sessionDay: envNum('TACK_BUDGET_SESSION_DAY', 80),
      globalHour: envNum('TACK_BUDGET_GLOBAL_HOUR', 600),
      globalDay: envNum('TACK_BUDGET_GLOBAL_DAY', 3000),
    },
    drainMs: envNum('TACK_DRAIN_SECONDS', 25) * 1000,
  };
}

export function downloadUrl(): string | null {
  const u = process.env.TACK_DOWNLOAD_URL?.trim();
  return u && /^https?:\/\//.test(u) ? u : null;
}

// ---------------------------------------------------------------- visitors

export interface Visitor {
  /** sha256 of the session id: the file name and the log id. The id itself never leaves the cookie. */
  key: string;
  createdAt: number;
  lastSeen: number;
  cookieAt: number;
  inflight: number;
  streams: number;
  hasData: boolean;
  dropped: boolean;
  calls: number[];
  bucket: Bucket;
}

interface Scope { visitor: Visitor; budget?: BudgetError }

const als = new AsyncLocalStorage<Scope>();
const visitors = new Map<string, Visitor>();

export function currentVisitor(): Visitor | undefined {
  return als.getStore()?.visitor;
}

export function runAs<T>(visitor: Visitor, fn: () => T): T {
  return als.run({ visitor }, fn);
}

/** The budget error a model call hit during this request, if any. */
export function budgetHit(): BudgetError | undefined {
  return als.getStore()?.budget;
}

type DropHook = (key: string) => void;
type TickHook = (now: number) => void;
const dropHooks: DropHook[] = [];
const tickHooks: TickHook[] = [];
export function onDrop(fn: DropHook): void { dropHooks.push(fn); }
export function onTick(fn: TickHook): void { tickHooks.push(fn); }

function newVisitor(key: string, now: number): Visitor {
  const l = limits();
  return {
    key, createdAt: now, lastSeen: now, cookieAt: 0, inflight: 0, streams: 0, hasData: false, dropped: false, calls: [],
    bucket: new Bucket(l.sessionPerMinute, l.sessionPerMinute / 60),
  };
}

function drop(v: Visitor): void {
  v.dropped = true;
  visitors.delete(v.key);
  for (const fn of dropHooks) {
    try { fn(v.key); } catch (err) { log({ level: 'error', msg: 'session cleanup failed', err: errText(err) }); }
  }
}

/** Sessions found on disk at start, so the cap and the 24 h expiry cover them too. */
export function adopt(key: string, lastSeen: number): void {
  if (visitors.has(key)) return;
  const v = newVisitor(key, lastSeen);
  v.hasData = true;
  visitors.set(key, v);
}

function idle(v: Visitor): boolean {
  return v.inflight === 0 && v.streams === 0;
}

// Frees one slot: an idle session without data first, then the least recently seen idle one.
function evictOne(): boolean {
  let pick: Visitor | undefined;
  for (const v of visitors.values()) {
    if (!idle(v)) continue;
    if (!pick || (v.hasData === pick.hasData ? v.lastSeen < pick.lastSeen : !v.hasData)) pick = v;
  }
  if (!pick) return false;
  log({ level: 'info', msg: 'session evicted', sess: pick.key.slice(0, 8), hadData: pick.hasData });
  drop(pick);
  return true;
}

export function sweep(now = Date.now()): void {
  const l = limits();
  for (const v of [...visitors.values()]) {
    if (idle(v) && now - v.lastSeen > l.sessionTtlMs) drop(v);
  }
  for (const [ip, b] of ipBuckets) if (b.full(now)) ipBuckets.delete(ip);
  for (const [ip, times] of newByIp) {
    const kept = times.filter((t) => now - t < 3_600_000);
    if (kept.length) newByIp.set(ip, kept); else newByIp.delete(ip);
  }
  for (const fn of tickHooks) {
    try { fn(now); } catch (err) { log({ level: 'error', msg: 'session sweep failed', err: errText(err) }); }
  }
}

let sweeper: ReturnType<typeof setInterval> | undefined;
export function startSweeper(everyMs = 60_000): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweep(), everyMs);
  sweeper.unref();
}
export function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}

export function sessionCount(): number {
  return visitors.size;
}

// ---------------------------------------------------------------- cookie

let secretDir = '';
let secretValue: Buffer | undefined;

/** Where the signing key lives when TACK_SESSION_SECRET is not set, so cookies survive a restart. */
export function configure(opts: { stateDir: string }): void {
  secretDir = opts.stateDir;
  secretValue = undefined;
}

function secret(): Buffer {
  if (secretValue) return secretValue;
  const env = process.env.TACK_SESSION_SECRET;
  if (env && env.length >= 32) return (secretValue = Buffer.from(env, 'utf8'));
  if (secretDir) {
    const file = join(secretDir, 'session.key');
    try {
      if (existsSync(file)) {
        const hex = readFileSync(file, 'utf8').trim();
        if (/^[0-9a-f]{64}$/.test(hex)) return (secretValue = Buffer.from(hex, 'hex'));
      }
      const fresh = randomBytes(32);
      mkdirSync(secretDir, { recursive: true });
      writeFileSync(file, fresh.toString('hex'), { mode: 0o600 });
      chmodSync(file, 0o600);
      return (secretValue = fresh);
    } catch { /* fall through to a key for this process only */ }
  }
  return (secretValue = randomBytes(32));
}

const sign = (id: string) => createHmac('sha256', secret()).update(id).digest('base64url');
const keyOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);

const COOKIE_SECURE = '__Host-tack_sid';
const COOKIE_PLAIN = 'tack_sid';

function readCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name === COOKIE_SECURE || name === COOKIE_PLAIN) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The session id in a cookie this server signed, or undefined for anything else. */
export function verifyCookie(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = value.match(/^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/);
  if (!m) return undefined;
  const want = Buffer.from(sign(m[1]));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : undefined;
}

function setCookie(res: ServerResponse, id: string, secure: boolean): void {
  const ttl = Math.round(limits().sessionTtlMs / 1000);
  const name = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  res.appendHeader('set-cookie', `${name}=${id}.${sign(id)}; Path=/; Max-Age=${ttl}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

export class Refusal extends Error {
  status: number;
  retryAfter?: number;
  code: string;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const newByIp = new Map<string, number[]>();

/** The visitor behind a request: from its signed cookie, or a new anonymous session. */
export function visitorFor(req: IncomingMessage, res: ServerResponse, ip: string, secure: boolean, now = Date.now()): Visitor {
  const l = limits();
  let id = verifyCookie(readCookie(req));
  let fresh = false;
  if (!id) {
    const times = (newByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= l.newSessionsPerIpHour) {
      throw new Refusal(429, 'sessions', 'Too many new sessions from your network in the last hour. Try again later.', 600);
    }
    times.push(now);
    newByIp.set(ip, times);
    id = randomBytes(32).toString('base64url');
    fresh = true;
  }
  const key = keyOf(id);
  let v = visitors.get(key);
  if (!v) {
    while (visitors.size >= l.maxSessions) {
      if (!evictOne()) throw new Refusal(503, 'full', 'The web preview is full right now. Try again in a few minutes.', 120);
    }
    v = newVisitor(key, now);
    visitors.set(key, v);
  }
  v.lastSeen = now;
  // A sliding cookie: refreshed at most once an hour.
  if (fresh || now - v.cookieAt > 3_600_000) {
    setCookie(res, id, secure);
    v.cookieAt = now;
  }
  return v;
}

// ---------------------------------------------------------------- rate limits

export class Bucket {
  tokens: number;
  at: number;
  readonly capacity: number;
  readonly perSecond: number;
  constructor(capacity: number, perSecond: number, now = Date.now()) {
    this.capacity = capacity; this.perSecond = perSecond; this.tokens = capacity; this.at = now;
  }
  #refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
  }
  take(now = Date.now()): boolean {
    this.#refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  /** Seconds until one token is back. */
  wait(): number {
    return this.perSecond > 0 ? Math.max(1, Math.ceil((1 - this.tokens) / this.perSecond)) : 60;
  }
  full(now = Date.now()): boolean {
    this.#refill(now);
    return this.tokens >= this.capacity;
  }
}

const ipBuckets = new Map<string, Bucket>();
const ipStreams = new Map<string, number>();

export function limitIp(ip: string, now = Date.now()): void {
  const l = limits();
  let b = ipBuckets.get(ip);
  if (!b) { b = new Bucket(l.ipPerMinute, l.ipPerMinute / 60, now); ipBuckets.set(ip, b); }
  if (!b.take(now)) throw new Refusal(429, 'rate', 'Too many requests from your network. Wait a minute and try again.', b.wait());
}

export function limitVisitor(v: Visitor, stream: boolean, now = Date.now()): void {
  const l = limits();
  if (!v.bucket.take(now)) throw new Refusal(429, 'rate', 'Too many requests in a short time. Wait a moment and try again.', v.bucket.wait());
  if (stream && v.streams >= l.streamsPerSession) throw new Refusal(429, 'streams', 'Too many open Tack tabs for this session. Close one and reload.', 30);
  if (!stream && v.inflight >= l.sessionInflight) throw new Refusal(429, 'busy', 'Tack is still working on your earlier requests. Wait for them to finish.', 5);
}

/** Counts a request or an event stream against its visitor until the response closes. */
export function track(v: Visitor, res: ServerResponse, stream: boolean, ip: string): void {
  if (stream) {
    const open = ipStreams.get(ip) ?? 0;
    if (open >= limits().streamsPerIp) throw new Refusal(429, 'streams', 'Too many open Tack tabs from your network.', 30);
    ipStreams.set(ip, open + 1);
    v.streams++;
  } else {
    v.inflight++;
  }
  res.once('close', () => {
    v.lastSeen = Date.now();
    if (stream) {
      v.streams = Math.max(0, v.streams - 1);
      const left = (ipStreams.get(ip) ?? 1) - 1;
      if (left > 0) ipStreams.set(ip, left); else ipStreams.delete(ip);
    } else {
      v.inflight = Math.max(0, v.inflight - 1);
    }
  });
}

// ---------------------------------------------------------------- model budget

export class BudgetError extends Error {
  status = 429;
  scope: 'session' | 'preview';
  retryAfter: number;
  constructor(scope: 'session' | 'preview', message: string, retryAfter: number) {
    super(message);
    this.name = 'BudgetError';
    this.scope = scope;
    this.retryAfter = retryAfter;
  }
}

const globalCalls: number[] = [];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function prune(times: number[], now: number): void {
  while (times.length && now - times[0] >= DAY) times.shift();
}

function within(times: number[], now: number, span: number): number {
  let n = 0;
  for (let i = times.length - 1; i >= 0 && now - times[i] < span; i--) n++;
  return n;
}

// Seconds until the oldest call inside the window leaves it.
function refill(times: number[], now: number, span: number, limit: number): number {
  const inside = times.filter((t) => now - t < span);
  const oldest = inside[inside.length - limit] ?? inside[0] ?? now;
  return Math.max(60, Math.ceil((oldest + span - now) / 1000));
}

const calls = (n: number) => `${n} model call${n === 1 ? '' : 's'}`;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const inWords = (s: number) => (s < 3600 ? plural(Math.ceil(s / 60), 'minute') : plural(Math.ceil(s / 3600), 'hour'));

/**
 * Counts one model call (a cache miss) against the visitor's and the preview's allowance.
 * Throws BudgetError when either is used up. A no-op outside hosted mode.
 */
export function chargeModelCall(now = Date.now()): void {
  if (!isHosted()) return;
  const b = limits().budget;
  const scope = als.getStore();
  const v = scope?.visitor;
  prune(globalCalls, now);
  const fail = (err: BudgetError) => {
    if (scope) scope.budget = err;
    throw err;
  };
  if (v) {
    prune(v.calls, now);
    if (within(v.calls, now, HOUR) >= b.sessionHour) {
      const s = refill(v.calls, now, HOUR, b.sessionHour);
      fail(new BudgetError('session', `You have used this preview's model allowance for the hour (${calls(b.sessionHour)}). It refills in about ${inWords(s)}. Everything you have built stays here, and the desktop app has no such limit.`, s));
    }
    if (v.calls.length >= b.sessionDay) {
      const s = refill(v.calls, now, DAY, b.sessionDay);
      fail(new BudgetError('session', `You have used this preview's model allowance for the day (${calls(b.sessionDay)}). It refills in about ${inWords(s)}. Everything you have built stays here, and the desktop app has no such limit.`, s));
    }
  }
  if (within(globalCalls, now, HOUR) >= b.globalHour) {
    const s = refill(globalCalls, now, HOUR, b.globalHour);
    fail(new BudgetError('preview', `The web preview has used its shared model allowance for the hour. Try again in about ${inWords(s)}, or use the desktop app.`, s));
  }
  if (globalCalls.length >= b.globalDay) {
    const s = refill(globalCalls, now, DAY, b.globalDay);
    fail(new BudgetError('preview', `The web preview has used its shared model allowance for today. Try again in about ${inWords(s)}, or use the desktop app.`, s));
  }
  v?.calls.push(now);
  globalCalls.push(now);
}

// ---------------------------------------------------------------- capabilities

const DESKTOP = 'run in the Tack desktop app';

export function capabilities(): { apply: boolean; mail: boolean; autopilot: boolean; reason: string } {
  if (!isHosted()) return { apply: true, mail: true, autopilot: true, reason: '' };
  return { apply: false, mail: false, autopilot: false, reason: `This is the web preview. Automated applying, mail reading and autopilot ${DESKTOP}.` };
}

// `part` marks a piece of automated applying rather than a feature of its own.
const BLOCKED: { prefix: string; what: string; capability: 'apply' | 'mail' | 'autopilot'; part?: boolean }[] = [
  { prefix: '/api/apply', what: 'Automated applying', capability: 'apply' },
  { prefix: '/api/queue', what: 'The apply queue', capability: 'apply' },
  { prefix: '/api/answers', what: 'Remembering answers for forms', capability: 'apply', part: true },
  { prefix: '/api/consent', what: 'Standing consent to submit', capability: 'apply', part: true },
  { prefix: '/api/practice', what: 'The practice application form', capability: 'apply', part: true },
  { prefix: '/practice', what: 'The practice application form', capability: 'apply', part: true },
  { prefix: '/api/mail', what: 'Reading replies from your mail', capability: 'mail' },
  { prefix: '/api/applications/sync', what: 'Reading replies from your mail', capability: 'mail' },
  { prefix: '/api/autopilot', what: 'Autopilot', capability: 'autopilot' },
  { prefix: '/api/engine', what: 'The browser engine', capability: 'autopilot' },
];

/** Browser-driven and scheduled features are off in hosted mode; returns the 409 body for those paths. */
export function blocked(pathname: string): { error: string; capability: string; download: string | null } | null {
  if (!isHosted()) return null;
  const hit = BLOCKED.find((b) => pathname === b.prefix || pathname.startsWith(`${b.prefix}/`));
  if (!hit) return null;
  return {
    error: `${hit.what} ${hit.part ? 'is part of automated applying, which runs' : 'runs'} in the Tack desktop app. This web preview covers the market, gap map, plan, portfolio, interviews and the tracker.`,
    capability: hit.capability,
    download: downloadUrl(),
  };
}

// ---------------------------------------------------------------- requests

export function trustProxy(): number {
  const raw = process.env.TACK_TRUST_PROXY;
  if (!raw || raw === '0') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** The client address: the socket, or with TACK_TRUST_PROXY=N the address N hops from the right of X-Forwarded-For. */
export function clientIp(req: IncomingMessage): string {
  const hops = trustProxy();
  if (hops) {
    const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const hit = chain[chain.length - hops];
    if (hit) return hit;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function isSecure(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return trustProxy() > 0 && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

export function requestId(req: IncomingMessage): string {
  const given = req.headers['x-request-id'];
  if (trustProxy() && typeof given === 'string' && /^[A-Za-z0-9._-]{8,80}$/.test(given)) return given;
  return randomBytes(9).toString('base64url');
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // The UI build inlines its smallest font files as data: URLs.
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

/** Writes from another site are refused: the Origin (or Fetch Metadata) must say this one. */
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin !== 'null';
  const host = (trustProxy() && typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'] : req.headers.host) ?? '';
  try {
    return new URL(origin).host === host.split(',')[0].trim();
  } catch {
    return false;
  }
}

export function log(entry: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
}

/** An error for the log: its name and the first line of its message, cut short. No stack. */
export function errText(err: unknown): string {
  const e = err as Error;
  return `${e?.name ?? 'Error'}: ${String(e?.message ?? err).split('\n')[0].slice(0, 200)}`;
}

// ---------------------------------------------------------------- input checks

export class InvalidInput extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Check = (body: any, params: Record<string, string>) => void;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, field: string, max: number, required = false): void {
  if (v === undefined || v === null) {
    if (required) throw new InvalidInput(`${field} is required`);
    return;
  }
  if (typeof v !== 'string') throw new InvalidInput(`${field} must be a string`);
  if (required && !v.trim()) throw new InvalidInput(`${field} is required`);
  if (v.length > max) throw new InvalidInput(`${field} is too long (${max} characters at most)`);
}

function numIn(v: unknown, field: string, min: number, max: number): void {
  if (v === undefined || v === null || v === '') return;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new InvalidInput(`${field} must be a number from ${min} to ${max}`);
}

function oneOf(v: unknown, field: string, values: readonly unknown[], required = false): void {
  if (v === undefined) {
    if (required) throw new InvalidInput(`${field} is required`);
    return;
  }
  if (!values.includes(v)) throw new InvalidInput(`${field} must be one of ${values.map(String).join(', ')}`);
}

function strList(v: unknown, field: string, maxItems: number, maxLen: number): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) throw new InvalidInput(`${field} must be an array`);
  if (v.length > maxItems) throw new InvalidInput(`${field} has too many items (${maxItems} at most)`);
  v.forEach((x, i) => str(x, `${field}[${i}]`, maxLen, true));
}

function list(v: unknown, field: string, maxItems: number, each: (x: unknown, at: string) => void): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) throw new InvalidInput(`${field} must be an array`);
  if (v.length > maxItems) throw new InvalidInput(`${field} has too many items (${maxItems} at most)`);
  v.forEach((x, i) => each(x, `${field}[${i}]`));
}

function object(body: unknown, what = 'body'): Record<string, unknown> {
  if (!isObj(body)) throw new InvalidInput(`${what} must be a JSON object`);
  return body;
}

function empty(body: unknown): void {
  if (body === undefined || body === null) return;
  if (!isObj(body) || Object.keys(body).length) throw new InvalidInput('this request takes no body');
}

const param = (name: string, max = 120): Check => (_b, p) => {
  if (!p[name] || p[name].length > max || /[\u0000-\u001f]/.test(p[name])) throw new InvalidInput(`${name} is not valid`);
};

const both = (...checks: Check[]): Check => (b, p) => { for (const c of checks) c(b, p); };

// Base64 of n bytes is 4 * ceil(n / 3) characters.
const base64Len = (bytes: number) => 4 * Math.ceil(bytes / 3);

const APP_STATUS = ['applied', 'viewed', 'reply', 'interview', 'offer', 'rejected', 'ghosted'] as const;

function resume(body: unknown): void {
  const b = object(body);
  const hasText = typeof b.text === 'string' && b.text.trim() !== '';
  const hasPdf = typeof b.pdfBase64 === 'string' && b.pdfBase64 !== '';
  if (hasText === hasPdf) throw new InvalidInput('send either {text} or {pdfBase64, filename}');
  str(b.text, 'text', 100_000);
  str(b.filename, 'filename', 200);
  if (hasPdf) {
    const data = (b.pdfBase64 as string).replace(/^data:[^,]*,/, '');
    if (data.length > base64Len(limits().resumeBytes)) throw new InvalidInput(tooLarge('/api/profile/resume'), 413);
    if (!/^[A-Za-z0-9+/=\s]*$/.test(data.slice(0, 4096))) throw new InvalidInput('pdfBase64 must be base64');
  }
}

function profile(body: unknown): void {
  const b = object(body, 'profile');
  str(b.name, 'name', 200, true);
  str(b.headline, 'headline', 300);
  str(b.currentRole, 'currentRole', 200);
  str(b.summary, 'summary', 4000);
  numIn(b.yearsExperience, 'yearsExperience', 0, 60);
  oneOf(b.source, 'source', ['pdf', 'text', 'demo']);
  list(b.skills, 'skills', 150, (s, at) => {
    const o = object(s, at);
    str(o.id, `${at}.id`, 80);
    str(o.name, `${at}.name`, 120, true);
    numIn(o.level, `${at}.level`, 0, 5);
    strList(o.evidence, `${at}.evidence`, 10, 600);
  });
  list(b.experience, 'experience', 40, (r, at) => {
    const o = object(r, at);
    for (const f of ['title', 'company', 'start', 'end']) str(o[f], `${at}.${f}`, 200);
    strList(o.bullets, `${at}.bullets`, 40, 1000);
  });
  strList(b.education, 'education', 30, 400);
  strList(b.projects, 'projects', 40, 800);
}

function goal(body: unknown): void {
  const b = object(body, 'goal');
  str(b.targetRole, 'targetRole', 120, true);
  str(b.location, 'location', 120);
  if (b.remote !== undefined && typeof b.remote !== 'boolean') throw new InvalidInput('remote must be true or false');
  numIn(b.hoursPerWeek, 'hoursPerWeek', 1, 80);
  numIn(b.weeks, 'weeks', 1, 52);
  str(b.startDate, 'startDate', 10);
  str(b.notes, 'notes', 2000);
}

function application(body: unknown): void {
  const b = object(body, 'application');
  str(b.title, 'title', 200);
  str(b.company, 'company', 200);
  str(b.postingId, 'postingId', 120);
  str(b.url, 'url', 2000);
  if (typeof b.url === 'string' && b.url && !/^https?:\/\//i.test(b.url)) throw new InvalidInput('url must start with http:// or https://');
  for (const f of ['roleFamily', 'seniority', 'companySize', 'source']) str(b[f], f, 60);
  numIn(b.fit, 'fit', 0, 100);
  str(b.appliedAt, 'appliedAt', 40);
  oneOf(b.status, 'status', APP_STATUS);
  oneOf(b.origin, 'origin', ['manual', 'fanfold', 'demo']);
  if (b.events !== undefined) throw new InvalidInput('events are written by Tack, not sent');
}

function details(body: unknown): void {
  const b = object(body, 'details');
  for (const f of ['fullName', 'email', 'phone', 'city', 'linkedin', 'workAuthorisation', 'noticePeriod']) str(b[f], f, 300);
}

/** One check per write route the hosted preview serves. Paths are the registered patterns. */
const CHECKS: Record<string, Check> = {
  'POST /api/demo/load': empty,
  'POST /api/reset': empty,
  'POST /api/profile/resume': resume,
  'PUT /api/profile': profile,
  'PUT /api/goal': goal,
  'POST /api/roles/suggest': empty,
  'POST /api/postings/harvest': (b) => { numIn(object(b).count, 'count', 1, 100); },
  'POST /api/gap/build': empty,
  'POST /api/plan/build': empty,
  'PATCH /api/plan/tasks/:id': both(param('id'), (b) => { oneOf(object(b).status, 'status', ['todo', 'done', 'skipped'], true); }),
  'POST /api/plan/checkpoint/:week': both(param('week', 3), (b, p) => {
    if (!/^\d{1,3}$/.test(p.week)) throw new InvalidInput('week must be a number');
    oneOf(object(b).passed, 'passed', [true, false, null], true);
  }),
  'POST /api/plan/replan': (b) => { str(object(b).reason, 'reason', 500); },
  'POST /api/portfolio/build': empty,
  'PATCH /api/portfolio/:id': both(param('id'), (b) => {
    const o = object(b);
    oneOf(o.status, 'status', ['idea', 'building', 'shipped']);
    strList(o.deliverablesDone, 'deliverablesDone', 50, 400);
  }),
  'POST /api/interviews': (b) => {
    const o = object(b);
    oneOf(o.kind, 'kind', ['behavioural', 'technical', 'case', 'mixed']);
    str(o.postingId, 'postingId', 120);
  },
  'POST /api/interviews/:id/answer': both(param('id'), (b) => {
    const o = object(b);
    str(o.questionId, 'questionId', 120, true);
    str(o.answer, 'answer', 8000, true);
  }),
  'POST /api/applications': application,
  'PATCH /api/applications/:id': both(param('id'), (b) => {
    const o = object(b);
    oneOf(o.status, 'status', APP_STATUS, true);
    str(o.note, 'note', 1000);
  }),
  'POST /api/kit/:postingId': both(param('postingId'), empty),
  'PUT /api/details': details,
};

// Any write without its own check still gets bounds: depth, keys, array and string sizes.
function bounded(v: unknown, depth = 0): void {
  if (depth > 8) throw new InvalidInput('body is nested too deeply');
  if (typeof v === 'string') {
    if (v.length > 100_000) throw new InvalidInput('a value in the body is too long');
  } else if (Array.isArray(v)) {
    if (v.length > 1000) throw new InvalidInput('an array in the body is too long');
    for (const x of v) bounded(x, depth + 1);
  } else if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length > 200) throw new InvalidInput('an object in the body has too many fields');
    for (const k of keys) bounded(v[k], depth + 1);
  }
}

export function checkWrite(method: string, pattern: string, body: unknown, params: Record<string, string>): void {
  const check = CHECKS[`${method} ${pattern}`];
  if (check) check(body, params);
  if (pattern !== '/api/profile/resume') bounded(body);
}

export function hasCheck(method: string, pattern: string): boolean {
  return `${method} ${pattern}` in CHECKS;
}

const mb = (bytes: number) => `${+(bytes / MB).toFixed(1)} MB`;

export function tooLarge(pattern: string): string {
  const l = limits();
  return pattern === '/api/profile/resume'
    ? `The résumé file is larger than ${mb(l.resumeBytes)}. Upload a smaller PDF or paste the text.`
    : `The request is larger than ${mb(l.jsonBytes)}.`;
}

/** The body limit for a route: the résumé route takes a file of up to TACK_MAX_RESUME_MB as base64 inside JSON. */
export function bodyLimit(pattern: string): number {
  const l = limits();
  return pattern === '/api/profile/resume' ? base64Len(l.resumeBytes) + 64 * 1024 : l.jsonBytes;
}

// ---------------------------------------------------------------- processes

/**
 * Turns off starting child processes for the life of this process, so nothing in hosted mode can
 * start the browser engine or a Chrome, whatever route or module asks.
 */
export function lockProcesses(): void {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as Record<string, unknown>;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[name] = () => { throw new Error(`${name} is turned off in hosted mode`); };
  }
  syncBuiltinESMExports();
}

/** Test helper: forget every visitor and counter. */
export function resetForTests(): void {
  visitors.clear();
  ipBuckets.clear();
  ipStreams.clear();
  newByIp.clear();
  globalCalls.length = 0;
}
