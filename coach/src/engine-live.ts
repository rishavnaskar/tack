// Live paths into the Fanfold engine. Every export answers with a value or
// { ok: false, reason } and never throws.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fetchPosting, fetchPostings, htmlText } from '../../engine/src/jobs/ats.ts';
import { countriesIn } from '../../engine/src/jobs/countries.ts';
import { extractText } from '../../engine/src/memory/import.ts';
import { BOARDS, boardFor, type Board } from './boards.ts';
import { stateDir } from './store.ts';
import type { Application, Posting } from './types.ts';

export interface Unavailable { ok: false; reason: string }
const unavailable = (reason: string): Unavailable => ({ ok: false, reason });
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------ isolation

export const tackStateDir = stateDir;

/**
 * Points the engine at Tack's own state so nothing touches a real Fanfold
 * install: its state dir, its extension port and its sign-in.
 */
export function isolateEngine(root = tackStateDir()): string {
  const dir = join(root, 'engine');
  process.env.BROWSER_AGENT_STATE_DIR = dir;
  process.env.FANFOLD_EXTENSION_PORT = process.env.TACK_EXTENSION_PORT || '47611';
  process.env.FANFOLD_AUTH = 'off';
  return dir;
}
isolateEngine();

// ------------------------------------------------------------ status

let probe: { at: number; value: { available: boolean; note: string } } | null = null;

/** Whether the live paths can run: job boards reachable, plus which opt-in sources are on. */
export async function status(fetchImpl: typeof fetch = fetch): Promise<{ available: boolean; note: string }> {
  if (process.env.TACK_ENGINE === 'off') return { available: false, note: 'live engine turned off by TACK_ENGINE=off' };
  if (probe && Date.now() - probe.at < 5 * 60_000) return probe.value;
  let value: { available: boolean; note: string };
  try {
    const res = await fetchImpl('https://boards-api.greenhouse.io/v1/boards/gitlab', { signal: AbortSignal.timeout(4000) });
    await res.body?.cancel().catch(() => {});
    const extras = [
      process.env.TACK_FANFOLD_DB ? 'Fanfold applications' : '',
      process.env.TACK_GMAIL === '1' ? 'Gmail replies' : '',
    ].filter(Boolean);
    value = res.ok
      ? { available: true, note: `reads ${BOARDS.length} public job boards live${extras.length ? `; ${extras.join(', ')} on` : ''}` }
      : { available: false, note: `job boards answered HTTP ${res.status}` };
  } catch (err) {
    value = { available: false, note: `job boards unreachable: ${messageOf(err)}` };
  }
  probe = { at: Date.now(), value };
  return value;
}

// ------------------------------------------------------------ title and place matching

const SYNONYMS: Array<[RegExp, string]> = [
  [/\bartificial intelligence\b/g, ' ai '],
  [/\bgen(?:erative)?[\s-]*ai\b/g, ' ai '],
  [/\b(?:machine learning|deep learning|computer vision|ml|llms?|genai|nlp|agents?|agentic|copilots?)\b/g, ' ai '],
  [/\b(?:product managers?|product management|product owners?|product leads?|head of product|apm|gpm|pm)\b/g, ' product_manager '],
  [/\b(?:technical program managers?|program managers?|tpm)\b/g, ' program_manager '],
  [/\b(?:engineering managers?)\b/g, ' engineering_manager '],
  [/\b(?:data scientists?|data science)\b/g, ' data_scientist '],
  [/\b(?:software engineers?|software developers?|swe|sde|engineers?|developers?|engineering)\b/g, ' engineer '],
  [/\b(?:designers?|design|ux|ui)\b/g, ' designer '],
  [/\b(?:analysts?|analytics)\b/g, ' analyst '],
  [/\b(?:scientists?)\b/g, ' scientist '],
];

const HEADS = new Set([
  'product_manager', 'program_manager', 'engineering_manager', 'data_scientist', 'engineer', 'designer', 'analyst',
  'scientist', 'researcher', 'architect', 'consultant', 'manager', 'marketer', 'recruiter', 'writer', 'counsel',
  'executive', 'representative', 'specialist', 'strategist', 'lead', 'director',
]);
const SENIORITY = new Set(['senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'associate', 'mid', 'level', 'i', 'ii', 'iii', 'iv']);
const STOP = new Set(['of', 'and', 'the', 'a', 'an', 'for', 'in', 'at', 'to', 'with', 'on', 'or']);

export function tokens(text: string): string[] {
  // "5:30 PM" is a shift, not a product manager.
  const plain = text.toLowerCase().replace(/\b\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m\b\.?/g, ' ');
  let t = ` ${plain.replace(/[^a-z0-9+#]+/g, ' ')} `;
  for (const [re, to] of SYNONYMS) t = t.replace(re, to);
  return t.split(/\s+/).filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

function roleParts(role: string): { head: string; mods: string[] } {
  const words = tokens(role).filter((w) => !SENIORITY.has(w));
  const heads = words.filter((w) => HEADS.has(w));
  const head = heads.at(-1) ?? words.at(-1) ?? '';
  return { head, mods: [...new Set(words.filter((w) => w !== head))] };
}

/** 0-100: how well a posting title fits the target role. The role's head noun counts three times a modifier. */
export function titleScore(role: string, title: string, department = ''): number {
  const { head, mods } = roleParts(role);
  if (!head) return 0;
  const have = new Set(tokens(title));
  if (!have.has(head)) return 0;
  const dept = new Set(tokens(department));
  let got = 3;
  for (const m of mods) got += have.has(m) ? 1 : dept.has(m) ? 0.5 : 0;
  let score = (100 * got) / (3 + mods.length);
  if (!/\bintern/i.test(role) && /\bintern(ship)?\b/i.test(title)) score -= 15;
  if (!/\b(director|head|vp|vice president|chief)\b/i.test(role) && /\b(director|head of|vp|vice president|chief)\b/i.test(title)) score -= 10;
  return Math.max(0, Math.round(score));
}

/** 0-15: the role's modifiers ("AI") that the title lacks but the posting's text keeps returning to. */
export function textBonus(role: string, title: string, text: string): number {
  const { mods } = roleParts(role);
  const inTitle = new Set(tokens(title));
  const counts = new Map<string, number>();
  for (const w of tokens(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  let bonus = 0;
  for (const m of mods) {
    if (inTitle.has(m)) continue;
    const n = counts.get(m) ?? 0;
    bonus += n >= 3 ? 8 : n >= 1 ? 3 : 0;
  }
  return Math.min(15, bonus);
}

const CITIES: Array<[RegExp, string, string]> = [
  [/\b(bengaluru|bangalore|blr)\b/, 'bengaluru', 'India'],
  [/\b(mumbai|bombay)\b/, 'mumbai', 'India'],
  [/\b(new delhi|delhi|ncr)\b/, 'delhi', 'India'],
  [/\b(gurugram|gurgaon)\b/, 'gurugram', 'India'],
  [/\bnoida\b/, 'noida', 'India'],
  [/\bhyderabad\b/, 'hyderabad', 'India'],
  [/\bpune\b/, 'pune', 'India'],
  [/\b(chennai|madras)\b/, 'chennai', 'India'],
  [/\b(kolkata|calcutta)\b/, 'kolkata', 'India'],
  [/\bahmedabad\b/, 'ahmedabad', 'India'],
  [/\bjaipur\b/, 'jaipur', 'India'],
  [/\b(kochi|cochin)\b/, 'kochi', 'India'],
  [/\b(san francisco|bay area|sf)\b/, 'san francisco', 'United States'],
  [/\b(new york|nyc)\b/, 'new york', 'United States'],
  [/\bseattle\b/, 'seattle', 'United States'],
  [/\b(mountain view|palo alto|san mateo|sunnyvale|redwood city|san jose)\b/, 'bay area', 'United States'],
  [/\baustin\b/, 'austin', 'United States'],
  [/\bboston\b/, 'boston', 'United States'],
  [/\blondon\b/, 'london', 'United Kingdom'],
  [/\bdublin\b/, 'dublin', 'Ireland'],
  [/\bberlin\b/, 'berlin', 'Germany'],
  [/\bmunich\b/, 'munich', 'Germany'],
  [/\bparis\b/, 'paris', 'France'],
  [/\bamsterdam\b/, 'amsterdam', 'Netherlands'],
  [/\btoronto\b/, 'toronto', 'Canada'],
  [/\bvancouver\b/, 'vancouver', 'Canada'],
  [/\bsingapore\b/, 'singapore', 'Singapore'],
  [/\bsydney\b/, 'sydney', 'Australia'],
  [/\btokyo\b/, 'tokyo', 'Japan'],
  [/\btel aviv\b/, 'tel aviv', 'Israel'],
];

const REGIONS: Array<[RegExp, string]> = [
  [/\b(apac|asia[\s-]?pacific|asia|south asia)\b/, 'apac'],
  [/\b(emea|europe|middle east)\b/, 'emea'],
  [/\b(amer|americas|north america|latam|latin america)\b/, 'americas'],
];

const COUNTRY_REGION: Record<string, string> = {
  India: 'apac', Singapore: 'apac', Japan: 'apac', Australia: 'apac', 'New Zealand': 'apac', Indonesia: 'apac',
  Philippines: 'apac', Malaysia: 'apac', Vietnam: 'apac', Thailand: 'apac', 'Sri Lanka': 'apac', Bangladesh: 'apac',
  'United Kingdom': 'emea', Ireland: 'emea', Germany: 'emea', France: 'emea', Netherlands: 'emea', Spain: 'emea',
  Israel: 'emea', 'United Arab Emirates': 'emea', 'European Union': 'emea', Poland: 'emea', Portugal: 'emea',
  'United States': 'americas', Canada: 'americas', Mexico: 'americas', Brazil: 'americas',
};

export function placeOf(text: string): { cities: Set<string>; countries: Set<string>; regions: Set<string>; remote: boolean } {
  const low = text.toLowerCase();
  const cities = new Set<string>();
  const countries = new Set<string>(countriesIn(text));
  for (const [re, city, country] of CITIES) if (re.test(low)) { cities.add(city); countries.add(country); }
  const regions = new Set(REGIONS.filter(([re]) => re.test(low)).map(([, r]) => r));
  return { cities, countries, regions, remote: /\b(remote|anywhere|worldwide|distributed)\b/.test(low) };
}

/**
 * 0-40: the requested city first, then its country, then remote roles open to it.
 * A remote role tied to other countries ("Remote - USA") is not open to someone in India, so it scores 0.
 */
export function locationScore(want: string, location: string): number {
  if (!want.trim()) return 0;
  const w = placeOf(want);
  const p = placeOf(location);
  if ([...w.cities].some((c) => p.cities.has(c))) return 40;
  if ([...w.countries].some((c) => p.countries.has(c))) return p.remote ? 35 : 30;
  const wRegions = new Set([...w.countries].map((c) => COUNTRY_REGION[c]).filter(Boolean));
  if (p.remote && p.countries.size === 0 && [...p.regions].some((r) => wRegions.has(r))) return 30;
  if (p.remote && p.countries.size === 0 && p.regions.size === 0) return 25;
  if (w.remote && p.remote && w.countries.size === 0) return 10;
  return 0;
}

/** Postings placed only somewhere the person did not ask for sink below every posting that is open to them. */
export const AWAY_PENALTY = 100;

function recencyScore(postedAt: string | null, now: number): number {
  const t = postedAt ? Date.parse(postedAt) : NaN;
  if (!Number.isFinite(t)) return 0;
  const days = (now - t) / 86_400_000;
  return days <= 30 ? 5 : days <= 90 ? 2 : 0;
}

export function seniorityOf(title: string): string {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return 'intern';
  if (/\b(director|head of|vp|vice president|chief)\b/.test(t)) return 'director';
  if (/\bprincipal\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(lead|group product manager|gpm)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|associate|apm|entry|graduate|new grad)\b/.test(t)) return 'junior';
  return 'mid';
}

export function roleFamilyOf(title: string): string {
  const t = ` ${tokens(title).join(' ')} `;
  if (/ ai /.test(t)) return 'ai';
  if (/ growth | monetization | monetisation /.test(t)) return 'growth';
  if (/ platform | infrastructure | infra | developer | api /.test(t)) return 'platform';
  if (/ data | analyst | data_scientist /.test(t)) return 'data';
  if (/ payment | fintech | risk | fraud | lending | banking /.test(t)) return 'fintech';
  if (/ consumer | mobile | app /.test(t)) return 'consumer';
  if (/ enterprise | b2b | saas /.test(t)) return 'enterprise';
  return 'core';
}

const SALARY = /(?:[$€£₹]|\b(?:USD|INR|EUR|GBP)\s?)\s?\d[\d,.]*\s?[kKmM]?(?:\s?(?:-|–|—|to)\s?(?:[$€£₹]|(?:USD|INR|EUR|GBP)\s?)?\s?\d[\d,.]*\s?[kKmM]?)(?:\s?(?:USD|INR|EUR|GBP))?/;

export function salaryIn(text: string): string | undefined {
  return text.match(SALARY)?.[0].replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim();
}

const BULLET = /^[-•*·▪◦]\s+/;

/**
 * Plain text as paragraphs. Lever's plain text keeps one line per paragraph and
 * its list HTML puts each bullet mark on a line of its own, which a reader shows
 * as one block. Every prose line becomes its own paragraph; bullets stay
 * together, under the short heading line that leads them.
 */
export function paragraphs(text: string): string {
  const lines = text.replace(/^[-•*·▪◦][ \t]*\n+(?=\S)/gm, '- ').split('\n').map((l) => l.trim());
  const blocks: string[][] = [];
  let cur: string[] = [];
  let gap = false;
  const flush = (): void => { if (cur.length) blocks.push(cur); cur = []; };
  const isHead = (l: string): boolean => l.length <= 80 && !/[.!?;,]$/.test(l);
  for (const raw of lines) {
    if (!raw) { gap = true; continue; }
    const bullet = BULLET.test(raw);
    const line = bullet ? raw.replace(BULLET, '- ') : raw;
    const last = cur.at(-1);
    if (bullet && last && (BULLET.test(last) || (!gap && cur.length === 1 && isHead(last)))) cur.push(line);
    else { flush(); cur.push(line); }
    gap = false;
  }
  flush();
  return blocks.map((b) => b.join('\n')).join('\n\n');
}

/** Board text as clean prose, cut near `cap` characters at a line or sentence end. */
export function cleanText(raw: string, cap = 6000): string {
  let t = /<\/?[a-z][^>]*>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(raw) ? htmlText(raw) : raw;
  t = t.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  t = paragraphs(t);
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const end = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (end > cap * 0.8 ? cut.slice(0, end + 1) : cut).trim();
}

export const postingId = (url: string): string => `live-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;

// ------------------------------------------------------------ fetching

/**
 * One download per address for a whole harvest. Ashby serves a posting from
 * the same document as its board, so both calls share it.
 */
export function memoFetch(base: typeof fetch): typeof fetch {
  const memo = new Map<string, Promise<{ status: number; body: unknown }>>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = /api\.ashbyhq\.com/.test(url) ? url.replace(/\?includeCompensation=false$/, '').toLowerCase() : url;
    let hit = memo.get(key);
    if (!hit) {
      hit = (async () => {
        const res = await base(url, init);
        return { status: res.status, body: res.ok ? await res.json() : null };
      })();
      memo.set(key, hit);
      hit.catch(() => memo.delete(key));
    }
    const { status, body } = await hit;
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as typeof fetch;
}

function withSignal(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch;
}

async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, onTimeout: () => T): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((done) => { timer = setTimeout(() => { ctl.abort(); done(onTimeout()); }, ms); });
  try {
    return await Promise.race([work(ctl.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function eachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A small JSON cache on disk; a read past its age or a broken file is a miss. */
export class DiskCache {
  readonly dir: string;
  readonly ttlMs: number;
  readonly now: () => number;
  constructor(dir: string, ttlMs = 30 * 60_000, now: () => number = Date.now) {
    this.dir = dir; this.ttlMs = ttlMs; this.now = now;
  }
  #file(key: string): string { return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`); }
  get<T>(key: string): T | null {
    try {
      const raw = JSON.parse(readFileSync(this.#file(key), 'utf8')) as { at: number; key: string; value: T };
      return raw.key === key && this.now() - raw.at < this.ttlMs ? raw.value : null;
    } catch {
      return null;
    }
  }
  set(key: string, value: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.#file(key);
      writeFileSync(`${file}.tmp`, JSON.stringify({ at: this.now(), key, value }));
      renameSync(`${file}.tmp`, file);
    } catch { /* a cache that cannot write is only slower */ }
  }
}

interface Listing { title: string; location: string; department: string; url: string; postedAt: string | null }
interface Read { title: string; location: string; text: string }

async function listBoard(board: Board, fetchImpl: typeof fetch): Promise<{ ok: true; postings: Listing[] } | { ok: false; error: string }> {
  const all: Listing[] = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const r = await fetchPostings(board.ats, board.board, '', fetchImpl, offset);
    if (!r.ok) return page === 0 ? r : { ok: true, postings: all };
    for (const p of r.postings) all.push({ title: p.title, location: p.location, department: p.department, url: p.url, postedAt: p.postedAt });
    offset = r.offset + r.postings.length;
    if (!r.postings.length || offset >= r.total) break;
  }
  return { ok: true, postings: all };
}

/** Greenhouse boards often link to the company's own careers page; the API needs the board's address. */
export function apiUrlOf(board: Board, url: string): string {
  if (board.ats !== 'greenhouse' || /greenhouse\.io\//.test(url)) return url;
  let id: string | null = null;
  try { id = new URL(url).searchParams.get('gh_jid'); } catch { /* not a URL */ }
  id ??= url.match(/(\d{6,})/)?.[1] ?? null;
  return id ? `https://job-boards.greenhouse.io/${board.board}/jobs/${id}` : url;
}

// ------------------------------------------------------------ harvest

export interface Tracer { step(step: string, detail: string): void }

export interface HarvestOptions {
  fetch?: typeof fetch;
  trace?: Tracer;
  boards?: readonly Board[];
  /** null turns the disk cache off. */
  cacheDir?: string | null;
  now?: () => number;
  concurrency?: number;
  boardTimeoutMs?: number;
}

export interface HarvestResult {
  ok: true;
  postings: Posting[];
  boards: { tried: number; answered: number; failed: { board: string; error: string }[] };
  scanned: number;
  matched: number;
  ms: number;
}

interface Candidate { board: Board; listing: Listing; score: number }

/** The best `count` candidates, at most `perCompany` from one company, one of each title in each place. */
export function rank(candidates: Candidate[], count: number, perCompany: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.listing.title.localeCompare(b.listing.title));
  const taken = new Map<string, number>();
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of sorted) {
    const n = taken.get(c.board.name) ?? 0;
    const same = `${c.board.name}|${c.listing.title.toLowerCase()}|${c.listing.location.toLowerCase()}`;
    if (n >= perCompany || seen.has(same)) continue;
    taken.set(c.board.name, n + 1);
    seen.add(same);
    out.push(c);
    if (out.length >= count) break;
  }
  return out;
}

export async function harvest(role: string, location: string, count: number, opts: HarvestOptions = {}): Promise<HarvestResult | Unavailable> {
  const started = Date.now();
  try {
    if (!role?.trim()) return unavailable('no target role to search for');
    const want = Math.max(1, Math.min(100, Math.round(count) || 20));
    const boards = opts.boards ?? BOARDS;
    const now = opts.now ?? Date.now;
    const limit = opts.concurrency ?? 6;
    const timeoutMs = opts.boardTimeoutMs ?? 8000;
    const cache = opts.cacheDir === null ? null : new DiskCache(opts.cacheDir ?? join(tackStateDir(), 'engine-cache'), 30 * 60_000, now);
    const fetchImpl = memoFetch(opts.fetch ?? fetch);
    const step = (s: string, d: string): void => { try { opts.trace?.step(s, d); } catch { /* tracing never breaks a harvest */ } };

    const failed: { board: string; error: string }[] = [];
    const candidates: Candidate[] = [];
    let answered = 0;
    let scanned = 0;

    await eachLimit(boards, limit, async (board) => {
      const t0 = Date.now();
      const key = `board:${board.ats}:${board.board}`;
      const hit = cache?.get<Listing[]>(key);
      const r = hit ? { ok: true as const, postings: hit } : await withTimeout(
        timeoutMs,
        (signal) => listBoard(board, withSignal(fetchImpl, signal)),
        () => ({ ok: false as const, error: `timed out after ${timeoutMs / 1000} s` }),
      ).catch((err: unknown) => ({ ok: false as const, error: messageOf(err) }));
      if (!r.ok) {
        failed.push({ board: board.name, error: r.error });
        step('board', `${board.name} (${board.ats}) not read: ${r.error}`);
        return;
      }
      if (!hit) cache?.set(key, r.postings);
      answered++;
      scanned += r.postings.length;
      let fits = 0;
      for (const listing of r.postings) {
        const t = titleScore(role, listing.title, listing.department);
        if (t <= 0) continue;
        fits++;
        const place = locationScore(location, listing.location);
        const away = location.trim() && listing.location.trim() && place === 0 ? AWAY_PENALTY : 0;
        candidates.push({ board, listing, score: t + place + recencyScore(listing.postedAt, now()) - away });
      }
      step('board', `${board.name} (${board.ats}): ${r.postings.length} open roles, ${fits} fit${hit ? ', cached' : ''}, ${Date.now() - t0} ms`);
    });

    if (!answered) return unavailable(`no job board answered${failed[0] ? ` (${failed[0].error})` : ''}`);
    if (!candidates.length) return unavailable(`no open roles fit "${role}" on ${answered} job boards`);

    const picked = rank(candidates, want + Math.min(want, 20), Math.max(2, Math.ceil(want / 10)));
    const reads = new Map<Candidate, Read>();
    await eachLimit(picked, limit, async (c) => {
      const key = `posting:${c.listing.url}`;
      const hit = cache?.get<Read>(key);
      const readLine = (r: Read, cached: boolean): void =>
        step('posting', `${r.title || c.listing.title} at ${c.board.name}, ${r.location || c.listing.location || 'location not stated'}, ${r.text.length} chars${cached ? ', cached' : ''}`);
      if (hit) { reads.set(c, hit); readLine(hit, true); return; }
      const r = await withTimeout(
        timeoutMs,
        (signal) => fetchPosting(apiUrlOf(c.board, c.listing.url), withSignal(fetchImpl, signal)),
        () => ({ ok: false as const, error: `timed out after ${timeoutMs / 1000} s` }),
      ).catch((err: unknown) => ({ ok: false as const, error: messageOf(err) }));
      if (!r.ok) { step('posting', `${c.listing.title} at ${c.board.name} not read: ${r.error}`); return; }
      const read = { title: r.posting.title, location: r.posting.location, text: cleanText(r.posting.text) };
      if (!read.text) { step('posting', `${c.listing.title} at ${c.board.name} has no text`); return; }
      cache?.set(key, read);
      reads.set(c, read);
      readLine(read, false);
    });

    // Read postings get a second look: an "AI" the title leaves out may fill the text.
    const final = picked.filter((c) => reads.has(c))
      .map((c) => ({ c, read: reads.get(c)!, score: c.score + textBonus(role, c.listing.title, reads.get(c)!.text) }))
      .sort((a, b) => b.score - a.score);
    const harvestedAt = new Date(now()).toISOString();
    const postings: Posting[] = [];
    for (const { c, read } of final) {
      postings.push(toPosting(c.board, c.listing, read, harvestedAt));
      if (postings.length >= want) break;
    }
    if (!postings.length) return unavailable('matching roles were found but none of their pages could be read');
    return {
      ok: true, postings, scanned, matched: candidates.length, ms: Date.now() - started,
      boards: { tried: boards.length, answered, failed },
    };
  } catch (err) {
    return unavailable(`harvest failed: ${messageOf(err)}`);
  }
}

function toPosting(board: Board, listing: Listing, read: Read, harvestedAt: string): Posting {
  const title = read.title || listing.title;
  const salary = salaryIn(read.text);
  return {
    id: postingId(listing.url),
    title,
    company: board.name,
    location: read.location || listing.location,
    url: listing.url,
    source: board.ats,
    ...(listing.postedAt ? { postedAt: listing.postedAt } : {}),
    ...(salary ? { salary } : {}),
    text: read.text,
    harvestedAt,
    live: true,
    roleFamily: roleFamilyOf(title),
    seniority: seniorityOf(title),
    companySize: board.size,
  };
}

// ------------------------------------------------------------ résumé text

/** A résumé file's text, read by the engine's PDF, Word, RTF and plain-text readers. */
export function resumeText(bytes: Uint8Array, mime?: string): { ok: true; text: string; warnings: string[] } | Unavailable {
  try {
    const r = extractText(Buffer.from(bytes), mime);
    if (!r.ok) return unavailable(r.error);
    const text = r.text.replace(/\r/g, '').replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text ? { ok: true, text, warnings: r.warnings } : unavailable('the file has no text in it');
  } catch (err) {
    return unavailable(`could not read the file: ${messageOf(err)}`);
  }
}

// ------------------------------------------------------------ link checks

/** An IP address on this machine, a private network or a link-local range: never fetched for a model's suggestion. */
export function privateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]);
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (!v.includes(':')) return false;
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
}

/** An https address on a public host name and the default port, or null. */
export function publicHttps(url: string): URL | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return null;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  return u;
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const dnsLookup: Lookup = async (host) => (await import('node:dns/promises')).lookup(host, { all: true, verbatim: true });

/**
 * True only when a public https address answers 2xx: HEAD first, GET when HEAD is refused. The host
 * must resolve to public addresses only, and each redirect is checked the same way.
 */
export async function verifyUrl(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 4000, lookup: Lookup = dnsLookup): Promise<boolean> {
  const safe = async (u: string): Promise<boolean> => {
    const parsed = publicHttps(u);
    if (!parsed) return false;
    try {
      const addrs = await lookup(parsed.hostname);
      return addrs.length > 0 && !addrs.some((a) => privateAddress(a.address));
    } catch {
      return false;
    }
  };
  const attempt = async (method: 'HEAD' | 'GET'): Promise<number> => {
    let at = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!(await safe(at))) return 0;
      try {
        const res = await fetchImpl(at, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Tack/0.1' } });
        await res.body?.cancel().catch(() => {});
        const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!next) return res.status;
        at = new URL(next, at).toString();
      } catch {
        return 0;
      }
    }
    return 0;
  };
  const head = await attempt('HEAD');
  if (head >= 200 && head < 300) return true;
  const get = await attempt('GET');
  return get >= 200 && get < 300;
}

// ------------------------------------------------------------ Fanfold applications

const VERDICT_FIT: Record<string, number> = { fit: 75, stretch: 55, no: 30, unknown: 50 };

function fitOf(match: unknown): number {
  let score: number | null = null;
  let verdict = '';
  if (typeof match === 'number') score = match;
  else if (typeof match === 'string' && match.startsWith('{')) {
    try {
      const v = JSON.parse(match) as { score?: number; verdict?: string };
      score = typeof v.score === 'number' ? v.score : null;
      verdict = v.verdict ?? '';
    } catch { /* unreadable verdict */ }
  } else if (typeof match === 'string' && match) score = Number(match);
  if (score !== null && Number.isFinite(score)) return Math.round(score <= 1 ? score * 100 : Math.min(score, 100));
  return VERDICT_FIT[verdict] ?? 50;
}

function sourceOf(ats: string | null, url: string): string {
  if (ats) return ats;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.').slice(-2, -1)[0] || host;
  } catch {
    return 'web';
  }
}

export interface FanfoldRow {
  id: string; status: string; url: string | null; match: unknown; confirmation: string | null;
  created_at: string; updated_at: string; submitted_at: string | null;
  company: string; title: string; ats: string | null; job_url: string | null;
}

export function toApplication(r: FanfoldRow): Application {
  const url = r.url || r.job_url || '';
  const appliedAt = r.submitted_at || r.updated_at || r.created_at;
  const note = r.confirmation ? `Confirmation: ${r.confirmation.replace(/\s+/g, ' ').slice(0, 160)}`
    : r.status === 'unconfirmed' ? 'Submitted through Fanfold; the site showed no confirmation'
      : 'Submitted through Fanfold';
  return {
    id: `ff-${r.id}`,
    title: r.title,
    company: r.company,
    url,
    roleFamily: roleFamilyOf(r.title),
    seniority: seniorityOf(r.title),
    companySize: boardFor(r.company)?.size ?? 'unknown',
    source: sourceOf(r.ats, url),
    fit: fitOf(r.match),
    appliedAt,
    status: 'applied',
    lastEventAt: r.updated_at || appliedAt,
    events: [{ at: appliedAt, kind: 'applied', note }],
    origin: 'fanfold',
  };
}

/** Applications a real Fanfold sent, read from its database without writing to it. Opt-in with TACK_FANFOLD_DB. */
export function applications(dbPath = process.env.TACK_FANFOLD_DB): { ok: true; applications: Application[]; db: string } | Unavailable {
  if (!dbPath) return unavailable('set TACK_FANFOLD_DB to a Fanfold agent.db to import its applications');
  if (!existsSync(dbPath)) return unavailable(`no Fanfold database at ${dbPath}`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return unavailable(`could not open ${dbPath} read-only: ${messageOf(err)}`);
  }
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    if (!tables.has('applications') || !tables.has('jobs')) return unavailable(`${dbPath} is not a Fanfold database`);
    const rows = db.prepare(`
      SELECT a.id, a.status, a.url, a.match, a.confirmation, a.created_at, a.updated_at, a.submitted_at,
             j.company, j.title, j.ats, j.url AS job_url
      FROM applications a JOIN jobs j ON j.canonical_id = a.job_id
      WHERE a.status IN ('applied', 'unconfirmed')
      ORDER BY COALESCE(a.submitted_at, a.updated_at) DESC
      LIMIT 1000`).all() as unknown as FanfoldRow[];
    return { ok: true, applications: rows.map(toApplication), db: dbPath };
  } catch (err) {
    return unavailable(`could not read ${dbPath}: ${messageOf(err)}`);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------ Gmail replies

export type ReplyKind = 'reply' | 'interview' | 'rejection' | 'other';
export interface MailReply { company: string; at: string; subject: string; snippet: string; kind: ReplyKind }

/** What a recruiter's message says, by its wording. */
export function replyKind(subject: string, snippet: string): ReplyKind {
  const t = `${subject} ${snippet}`.toLowerCase();
  if (/\b(unfortunately|not (?:be )?moving forward|other candidates|decided not to|regret to|not selected|position has been filled|will not be progressing)\b/.test(t)) return 'rejection';
  if (/\b(interview|schedule a (?:call|chat|time)|your availability|next steps|phone screen|meet the team|calendly|book a time)\b/.test(t)) return 'interview';
  if (/\b(thank(?:s| you) for (?:applying|your application|your interest)|application (?:received|was received)|we(?:'ve| have) received your application)\b/.test(t)) return 'other';
  return 'reply';
}

/** Which company a message is about, by name in its sender, subject or snippet. */
export function companyOf(companies: string[], m: { from: string; subject: string; snippet: string }): string | null {
  const hay = `${m.from} ${m.subject} ${m.snippet}`.toLowerCase();
  const squashed = hay.replace(/[^a-z0-9]/g, '');
  for (const c of companies) {
    const name = c.toLowerCase().trim();
    if (!name) continue;
    if (hay.includes(name) || (name.length > 3 && squashed.includes(name.replace(/[^a-z0-9]/g, '')))) return c;
  }
  return null;
}

/**
 * Replies from these companies in a Google account connected in Tack's own
 * engine state. Opt-in with TACK_GMAIL=1; never starts a sign-in.
 */
export async function mailReplies(companies: string[], opts: { stateDir?: string; timeoutMs?: number } = {}): Promise<{ ok: true; replies: MailReply[] } | Unavailable> {
  try {
    if (process.env.TACK_GMAIL !== '1') return unavailable('mail is off; set TACK_GMAIL=1 to read replies from a Google account connected to Tack');
    const names = [...new Set(companies.map((c) => c.trim()).filter(Boolean))].slice(0, 30);
    if (!names.length) return { ok: true, replies: [] };
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return unavailable('GOOGLE_CLIENT_ID is not set, so no Google account can be used');
    const dir = isolateEngine(opts.stateDir);
    const dbPath = join(dir, 'agent.db');
    if (!existsSync(dbPath)) return unavailable(`no Google account is connected in Tack's engine state (${dir})`);
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    let connected = false;
    try {
      connected = !!ro.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'secrets'").get()
        && !!ro.prepare("SELECT 1 FROM secrets WHERE name = 'google:refresh'").get();
    } finally {
      ro.close();
    }
    if (!connected) return unavailable(`no Google account is connected in Tack's engine state (${dir})`);

    const [{ GoogleAuth, Gmail }, { SecretStore, Keychain }] = await Promise.all([
      import('../../engine/src/connectors/google.ts'),
      import('../../engine/src/connectors/keychain.ts'),
    ]);
    // A key file in Tack's state wins; otherwise the engine's own key, read but never created.
    const keyFile = join(dir, 'master.key');
    const chain = new Keychain('master');
    const keys = {
      get: async (account: string) => (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : chain.get(account)),
      set: async () => { throw new Error('Tack does not create keys'); },
      delete: async () => {},
    };
    const db = new DatabaseSync(dbPath);
    try {
      const gmail = new Gmail(new GoogleAuth({ clientId, clientSecret: process.env.GOOGLE_CLIENT_SECRET }, new SecretStore(db, keys)));
      const q = `newer_than:120d -from:me (${names.map((n) => `"${n.replace(/"/g, '')}"`).join(' OR ')})`;
      const found = await withTimeout(opts.timeoutMs ?? 20_000, () => gmail.search(q, 40), () => null);
      if (!found) return unavailable('Gmail did not answer in time');
      const replies: MailReply[] = [];
      for (const m of found) {
        const company = companyOf(names, m);
        if (!company) continue;
        const at = Date.parse(m.date);
        replies.push({
          company, at: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
          subject: m.subject, snippet: m.snippet, kind: replyKind(m.subject, m.snippet),
        });
      }
      return { ok: true, replies };
    } finally {
      db.close();
    }
  } catch (err) {
    return unavailable(`Gmail could not be read: ${messageOf(err)}`);
  }
}

// ------------------------------------------------------------ browser paths

/** Applying needs Fanfold's browser and its review queue; Tack hands the link over instead. */
export async function apply(_url: string): Promise<{ ok: true; started: boolean; note: string } | Unavailable> {
  return unavailable('applying runs in Fanfold itself: open the posting there, where every answer is checked and you approve the submit');
}
