/**
 * Jobs and applications: the central object of the product.
 *
 * A job is one posting, identified canonically so the same role seen on
 * Indeed and on the company's Greenhouse page is one row. An application is
 * what a worker did about it. The partial unique index is the rule "a job is
 * applied to once, by whichever worker finds it first": it is enforced by the
 * database, after policy, and no grant can override it.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { whenSaid } from '../policy/recipient.ts';
import { json } from './json.ts';
import { jobFromTitle, looksLikeHost, looksLikePlace, UNNAMED_COMPANY } from './page-title.ts';

export type ApplicationStatus =
  | 'found' | 'skipped' | 'queued' | 'needs_review' | 'prepared'
  | 'applying' | 'applied' | 'unconfirmed' | 'failed';

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'found', 'skipped', 'queued', 'needs_review', 'prepared', 'applying', 'applied', 'unconfirmed', 'failed',
];

/** Statuses that count as "live": a second one for the same job is refused. */
const LIVE_STATUSES: readonly ApplicationStatus[] = ['prepared', 'applying', 'applied', 'unconfirmed'];

/** Statuses that mean "this worker is taking this job". */
const CLAIMING: readonly ApplicationStatus[] = ['needs_review', 'queued', ...LIVE_STATUSES];

/**
 * A job claimed through MCP belongs to the connection that claimed it. Every
 * host records under the same (empty) worker, so the worker cannot tell two
 * sessions apart; this can.
 */
export interface Claim {
  /** Which connection is recording. */
  by: string;
  /** The connection holding a claim is gone for good, e.g. Fanfold restarted since it claimed. */
  gone?(holder: string): boolean;
  /** Whether the holder of a quiet claim is still at it, e.g. its Submit waits on the user. */
  busy?(held: Application): boolean;
}

/** A queued claim nobody has moved on for this long, and whose holder is not waiting on the user, can be taken over. */
export const CLAIM_LAPSES_MS = 30 * 60_000;

const DAY_MS = 86_400_000;

export interface JobInput {
  company: string;
  title: string;
  location?: string | null;
  remote?: boolean | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  postedAt?: string | null;
  /** Which ATS or board the posting lives on, e.g. "greenhouse". */
  ats?: string | null;
  url?: string | null;
  description?: string | null;
}

export interface Job extends JobInput {
  canonicalId: string;
  sourceUrls: string[];
  firstSeenAt: string;
}

export interface Answer {
  question: string;
  answer: string;
  /** Where it came from: PROFILE, BANK, FANFOLD (worked out by Fanfold and kept), WORKER, DRAFT or PREFERENCE. */
  source: string;
  /** For a FANFOLD answer, what it was worked out from when it was recorded, so the form can be checked later even if that changes. */
  workedOutFrom?: { from: string; statement?: string; quotes?: Array<{ quote: string; documentId?: string; title?: string }>; at: string };
}

/**
 * Whether a job fits the user, as screening found it (fit.ts), kept on the
 * application. `unknown`: not judged, since Fanfold held too little about the
 * user; it never holds a job back and is never a weak match.
 */
export interface FitVerdict {
  verdict: 'fit' | 'stretch' | 'no' | 'unknown';
  reasons: string[];
  at: string;
  /** How the posting was read. */
  from?: 'model' | 'patterns';
  /** Why it was queued anyway, when the verdict was no. */
  override?: string;
  /** The built-in agent's own 0..1 match, kept beside the verdict. */
  score?: number;
}

export interface Application {
  id: string;
  jobId: string;
  workerId: string | null;
  runId: string | null;
  status: ApplicationStatus;
  skipReason: string | null;
  answers: Answer[];
  resumeDocumentId: string | null;
  /** The name of the résumé file it recorded, once that file is gone: what a sent one went with, or the one removed from a waiting one. */
  resumeTitle?: string | null;
  coverLetter: string | null;
  match: number | null;
  /** The fit screening's verdict, stored in the match column as JSON; null when the job was not screened. */
  fit: FitVerdict | null;
  fitNote: string | null;
  /** Where the filled form waits, for "you press Submit". */
  url: string | null;
  confirmation: string | null;
  effectKey: string | null;
  /** The MCP connection holding it, when one claimed it. */
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export interface ApplicationRow extends Application {
  job: Job;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  canonical_id  TEXT PRIMARY KEY,
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  location      TEXT,
  remote        INTEGER,
  salary_min    REAL,
  salary_max    REAL,
  posted_at     TEXT,
  ats           TEXT,
  url           TEXT,
  source_urls   TEXT NOT NULL,
  description_hash TEXT,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(canonical_id),
  worker_id     TEXT,
  run_id        TEXT,
  status        TEXT NOT NULL,
  skip_reason   TEXT,
  answers       TEXT NOT NULL DEFAULT '[]',
  resume_document_id TEXT,
  cover_letter  TEXT,
  match         REAL,
  fit_note      TEXT,
  url           TEXT,
  confirmation  TEXT,
  effect_key    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  submitted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_application ON applications(job_id)
  WHERE status IN ('prepared','applying','applied','unconfirmed');
CREATE INDEX IF NOT EXISTS applications_status ON applications(status, updated_at);
CREATE INDEX IF NOT EXISTS applications_worker ON applications(worker_id, created_at);
-- Every answer Fanfold gave a form while a run filled it, so the submit can keep them on the application whatever the host records.
CREATE TABLE IF NOT EXISTS given_answers (
  run_id        TEXT NOT NULL,
  job_id        TEXT,
  url           TEXT,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  source        TEXT NOT NULL,
  worked_out    TEXT,
  at            TEXT NOT NULL,
  PRIMARY KEY (run_id, question, url)
);
CREATE TABLE IF NOT EXISTS posting_requirements (
  posting_key   TEXT PRIMARY KEY,
  title         TEXT,
  requirements  TEXT NOT NULL,
  read_at       TEXT NOT NULL
);
`;

const ATS_ID: Array<[RegExp, string]> = [
  [/(?:^|\.)greenhouse\.io$/, 'greenhouse'],
  [/(?:^|\.)lever\.co$/, 'lever'],
  [/(?:^|\.)ashbyhq\.com$/, 'ashby'],
  [/(?:^|\.)workable\.com$/, 'workable'],
  [/myworkday(?:jobs|site)\.com$/, 'workday'],
  [/^ats\.rippling\.com$/, 'rippling'],
  [/(?:^|\.)smartrecruiters\.com$/, 'smartrecruiters'],
];

/**
 * A name standing in for one nobody has read yet: "Posting" or "Application"
 * for a title, a company the address does not name, or a host name. Such a
 * job is known by its address until its page names it.
 */
export function placeholderName(job: { company: string; title: string }): boolean {
  const title = job.title.trim();
  const company = job.company.trim();
  return !title || title === 'Posting' || title === 'Application' || !company || company === UNNAMED_COMPANY || looksLikeHost(company);
}

/**
 * Canonical identity: the ATS and its job id when the URL carries one, the
 * posting's address while the job has no name of its own, otherwise
 * normalised company, title and location plus a hash of the description.
 * Exact, never fuzzy: two different jobs must never collapse.
 */
export function canonicalJobId(job: JobInput): string {
  const fromUrl = atsIdentity(job.url);
  if (fromUrl) return fromUrl;
  // A board's own job id names the posting, but the same job may be known by
  // name already, so this one does not decide on its own; see #resolveIdentity.
  const board = boardKey(job.url);
  if (board) return `board:${board}`;
  // Two pages that name nobody are two jobs: "Company not named — Posting" would be one key for all of them.
  const address = placeholderName(job) ? postingKey(job.url) : null;
  if (address) return `url:${address}`;
  const parts = [norm(job.company), norm(job.title), norm(job.location ?? '')];
  const desc = job.description ? sha(job.description.trim()).slice(0, 8) : '';
  return `job:${parts.join('|')}${desc ? '|' + desc : ''}`;
}

export function atsIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const ats = ATS_ID.find(([re]) => re.test(host))?.[1];
  // A board embedded in the company's own careers page still names the posting by its ATS id.
  const embedded = u.searchParams.get('gh_jid') ?? null;
  if (!ats && embedded && /^\d+$/.test(embedded)) return `ats:greenhouse:${embedded}`;
  const ashby = u.searchParams.get('ashby_jid');
  if (!ats && ashby && /^[0-9a-f-]{20,}$/i.test(ashby)) return `ats:ashby:${ashby.toLowerCase()}`;
  if (!ats) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  switch (ats) {
    case 'greenhouse': {
      // boards.greenhouse.io/<board>/jobs/<id>  or  job-boards.greenhouse.io/<board>/jobs/<id>
      const i = segments.indexOf('jobs');
      const id = i >= 0 ? segments[i + 1] : u.searchParams.get('gh_jid');
      return id && /^\d+$/.test(id) ? `ats:greenhouse:${id}` : null;
    }
    case 'lever': {
      // jobs.lever.co/<company>/<uuid>
      const id = segments[1];
      return id && /^[0-9a-f-]{20,}$/i.test(id) ? `ats:lever:${id.toLowerCase()}` : null;
    }
    case 'ashby': {
      // jobs.ashbyhq.com/<company>/<uuid>
      const id = segments[1];
      return id && /^[0-9a-f-]{20,}$/i.test(id) ? `ats:ashby:${id.toLowerCase()}` : null;
    }
    case 'workable': {
      // apply.workable.com/<company>/j/<code>
      const i = segments.indexOf('j');
      const id = i >= 0 ? segments[i + 1] : null;
      return id ? `ats:workable:${id.toUpperCase()}` : null;
    }
    case 'workday': {
      // <tenant>.wd5.myworkdayjobs.com/<site>/job/<location>/<title>_<REQ-ID>
      const last = segments[segments.length - 1] ?? '';
      const m = last.match(/_([A-Z]*[-_]?\d[\w-]*)$/i);
      return m ? `ats:workday:${host.split('.')[0]}:${m[1]}` : null;
    }
    case 'rippling': {
      // ats.rippling.com/<board>/jobs/<uuid>
      const i = segments.indexOf('jobs');
      const id = i >= 0 ? segments[i + 1] : null;
      return id && /^[0-9a-f-]{20,}$/i.test(id) ? `ats:rippling:${id.toLowerCase()}` : null;
    }
    case 'smartrecruiters': {
      // jobs.smartrecruiters.com/<company>/<id>-<slug>
      const id = /^(\d{6,})/.exec(segments[1] ?? '')?.[1];
      return id ? `ats:smartrecruiters:${id}` : null;
    }
    default:
      return null;
  }
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

/** As names were normalised while an accent split a word in two ("société" was "socie te"): only to find rows kept apart by it. */
function splitAccentsNorm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const TRACKING = /^(utm_.*|trk.*|refid|trackingid|ebp|gh_src|lever-source.*|source|ref|src)$/i;

/**
 * One posting's address, however it was reached: tracking parameters and the
 * fragment left out, and a LinkedIn job known by its id from either of the
 * addresses LinkedIn shows it at. A LinkedIn address with no job id in it, a
 * results list with nothing chosen, is no one posting.
 */
export function postingKey(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const id = /\/jobs\/view\/(?:[^/]*-)?(\d+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('currentJobId');
    return id && /^\d+$/.test(id) ? `linkedin:${id}` : null;
  }
  const query = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  return `${host}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}${query.length ? `?${new URLSearchParams(query)}` : ''}`;
}

/**
 * A LIKE pattern every address of a posting matches: its host, or LinkedIn's
 * job id. It only narrows the rows read; postingKey decides.
 */
function likeTerm(key: string): string {
  const part = key.startsWith('linkedin:') ? key.slice('linkedin:'.length) : key.split(/[/:?]/)[0];
  return `%${part.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** A LinkedIn address with no job in it: a search or list page with nothing chosen, or the feed. */
function namesNoJob(url: string | null | undefined): boolean {
  try {
    return !!url && /(^|\.)linkedin\.com$/.test(new URL(url).hostname.toLowerCase().replace(/\.+$/, '')) && !postingKey(url);
  } catch {
    return false;
  }
}

/** A posting key that is a board's own job id, such as LinkedIn's. */
function boardKey(url: string | null | undefined): string | null {
  const key = postingKey(url);
  return key?.startsWith('linkedin:') ? key : null;
}

/**
 * The same place named more or less fully: "London, United Kingdom" and
 * "London, England, United Kingdom". One must name the same city first and
 * add nothing the other contradicts; Berlin and London never agree.
 */
export function samePlace(a: string, b: string): boolean {
  const ta = norm(a).split(' ').filter(Boolean);
  const tb = norm(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length || ta[0] !== tb[0]) return false;
  const [few, many] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return few.every((t) => many.has(t));
}

/** How far an application has gone. A worker moves its own forward, never back. */
const PROGRESS: Partial<Record<ApplicationStatus, number>> = { prepared: 0, applying: 1, unconfirmed: 2, applied: 3 };
const SENT: readonly ApplicationStatus[] = ['applying', 'unconfirmed', 'applied'];

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface ApplicationFilter {
  status?: ApplicationStatus | ApplicationStatus[];
  workerId?: string;
  /** Recorded during this run: the jobs a session or a run claimed. */
  runId?: string;
  jobId?: string;
  ats?: string;
  search?: string;
  limit?: number;
}

export class Jobs {
  #db: DatabaseSync;
  readonly #listeners = new Set<(a: Application) => void>();

  /** Be told when an application's status is written, so what waited on its job can be let go. */
  onChange(listener: (a: Application) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #changed(a: Application | null): Application | null {
    if (a) for (const listener of this.#listeners) { try { listener(a); } catch { /* a listener's failure is its own */ } }
    return a;
  }

  /** What the one-time repair merged on this start, for the caller to log. Empty on every later start. */
  readonly repaired: Merged[] = [];

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
    const have = (this.#db.prepare("PRAGMA table_info('applications')").all() as Array<{ name: string }>).map((c) => c.name);
    if (!have.includes('claimed_by')) this.#db.exec('ALTER TABLE applications ADD COLUMN claimed_by TEXT');
    if (!have.includes('resume_title')) this.#db.exec('ALTER TABLE applications ADD COLUMN resume_title TEXT');
    this.#db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.#repairOnce(REPAIR_SETTING, () => this.#mergeStraySubmits());
    this.#repairOnce(REPAIR_NAMES_SETTING, () => this.#mergeMisnamed());
    this.#repairOnce(REPAIR_TWINS_SETTING, () => this.#mergeTwins());
    this.#repairOnce(REPAIR_SAME_FORM_SETTING, () => [...this.#mergeTwins(), ...this.#mergeSameForm()]);
    this.#repairOnce(REPAIR_ACCENTS_SETTING, () => this.#mergeAccentTwins());
  }

  /** Run a one-time repair unless its settings key says it has run, and record that it has, with what it merged. */
  #repairOnce(setting: string, repair: () => Merged[]): void {
    if (this.#db.prepare('SELECT 1 FROM settings WHERE key = ?').get(setting)) return;
    const merged = repair();
    this.repaired.push(...merged);
    this.#db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run(setting, JSON.stringify({ at: new Date().toISOString(), merged }));
  }

  /**
   * Once: a row whose company is a host name ("ats.rippling.com") or a place
   * read off a page title ("India", "India — Cursor"), beside a row of the
   * same run for the real company, is the same job recorded twice. It goes
   * into the real one whatever either's status: the further status, both
   * rows' addresses and answers, and the résumé sent.
   */
  #mergeMisnamed(): Merged[] {
    const rows = this.list({ limit: 5000 }).filter((r) => r.runId);
    const out: Merged[] = [];
    const gone = new Set<string>();
    for (const stray of rows.filter((r) => misnamed(r.job.company))) {
      if (gone.has(stray.id)) continue;
      const real = this.#realTwin(stray, rows.filter((r) => !gone.has(r.id)));
      if (!real) continue;
      const merged = this.#mergeInto(stray, real);
      if (merged) {
        gone.add(stray.id);
        out.push(merged);
      }
    }
    return out;
  }

  /** One row folded into another: the further status, both rows' addresses and answers, the résumé sent; the stray's job goes once nothing refers to it. */
  #mergeInto(stray: ApplicationRow, real: ApplicationRow): Merged | null {
    try {
      this.#db.exec('BEGIN');
      this.#db.prepare('DELETE FROM applications WHERE id = ?').run(stray.id);
      const further = (RANK[stray.status] ?? 0) > (RANK[real.status] ?? 0);
      const status = further ? stray.status : real.status;
      const [first, second] = further ? [stray, real] : [real, stray];
      const earliest = (a: string | null, b: string | null): string | null => (a && b ? (a < b ? a : b) : a ?? b);
      this.#db.prepare(`
        UPDATE applications SET status = ?, confirmation = ?, submitted_at = ?, skip_reason = ?, created_at = MIN(created_at, ?),
          updated_at = MAX(updated_at, ?), answers = ?, resume_document_id = COALESCE(resume_document_id, ?), url = COALESCE(url, ?) WHERE id = ?
      `).run(status, first.confirmation ?? second.confirmation, earliest(real.submittedAt, stray.submittedAt),
        status === 'skipped' ? first.skipReason ?? second.skipReason : null, stray.createdAt, stray.updatedAt,
        JSON.stringify(mergeAnswers(real.answers, stray.answers)), stray.resumeDocumentId, stray.url, real.id);
      for (const u of [stray.job.url, ...stray.job.sourceUrls, stray.url]) if (u && stray.jobId !== real.jobId) this.#addSource(real.jobId, u);
      const used = this.#db.prepare('SELECT 1 FROM applications WHERE job_id = ? LIMIT 1').get(stray.jobId);
      if (!used) this.#db.prepare('DELETE FROM jobs WHERE canonical_id = ?').run(stray.jobId);
      this.#db.exec('COMMIT');
      return { into: real.id, job: real.jobId, from: stray.id, strayJob: stray.jobId, strayName: `${stray.job.company} — ${stray.job.title}`, status, jobRemoved: !used };
    } catch {
      this.#db.exec('ROLLBACK');
      return null;
    }
  }

  /**
   * Once: rows left twice for one job. A row with no address beside the one
   * row of the same company and title that has one is that job; and a job
   * skipped once and sent later is the job sent, its status the latest.
   */
  #mergeTwins(): Merged[] {
    const out: Merged[] = [];
    const gone = new Set<string>();
    const rows = (): ApplicationRow[] => this.list({ limit: 5000 }).filter((r) => !gone.has(r.id));
    const addressed = (r: ApplicationRow): boolean => !!(r.url || r.job.url || r.job.sourceUrls.length);
    const named = (r: ApplicationRow): string => `${norm(r.job.company)}|${norm(r.job.title)}`;
    for (const stray of rows().filter((r) => !addressed(r))) {
      const twins = rows().filter((r) => r.id !== stray.id && addressed(r) && named(r) === named(stray));
      if (twins.length !== 1) continue;
      const merged = this.#mergeInto(stray, twins[0]);
      if (merged) { gone.add(stray.id); out.push(merged); }
    }
    for (const sent of rows().filter((r) => SENT.includes(r.status))) {
      for (const old of rows().filter((r) => r.jobId === sent.jobId && r.id !== sent.id && r.status === 'skipped' && r.updatedAt <= sent.updatedAt)) {
        const merged = this.#mergeInto(old, sent);
        if (merged) { gone.add(old.id); out.push(merged); }
      }
    }
    return out;
  }

  /**
   * Once: two jobs whose company and title differ only by accents ("Société
   * Générale", "Societe Generale") were kept as two while an accent split a
   * name's words. Where exactly one such twin names the same place, or neither
   * names one, their applications become one row, the further one kept. Two
   * postings a board knows by two ids stay two, and so do two live rows.
   */
  #mergeAccentTwins(): Merged[] {
    const out: Merged[] = [];
    const gone = new Set<string>();
    const rows = (): ApplicationRow[] => this.list({ limit: -1 }).filter((r) => !gone.has(r.id));
    const named = (j: Job): string => `${norm(j.company)}|${norm(j.title)}`;
    const was = (j: Job): string => `${splitAccentsNorm(j.company)}|${splitAccentsNorm(j.title)}`;
    const exact = (id: string): boolean => /^(?:ats|board):/.test(id);
    const twin = (a: Job, b: Job): boolean => a.canonicalId !== b.canonicalId && named(a) === named(b) && was(a) !== was(b)
      && !placeholderName(a) && !placeholderName(b) && !(exact(a.canonicalId) && exact(b.canonicalId))
      && (a.location && b.location ? samePlace(a.location, b.location) : !a.location && !b.location);
    for (const one of rows()) {
      if (gone.has(one.id)) continue;
      const twins = rows().filter((r) => r.id !== one.id && twin(r.job, one.job) && !(LIVE_STATUSES.includes(r.status) && LIVE_STATUSES.includes(one.status)));
      if (twins.length !== 1) continue;
      const other = twins[0];
      const ahead = (RANK[other.status] ?? 0) - (RANK[one.status] ?? 0) || (other.createdAt < one.createdAt ? 1 : -1);
      const [stray, real] = ahead > 0 ? [one, other] : [other, one];
      const merged = this.#mergeInto(stray, real);
      if (merged) { gone.add(stray.id); out.push(merged); }
    }
    // A twin no application is kept on would still make the name stand for two jobs.
    const jobs = (this.#db.prepare('SELECT * FROM jobs').all() as Array<Record<string, unknown>>).map(toJob);
    const used = new Set(this.list({ limit: -1 }).map((r) => r.jobId));
    for (const spare of jobs.filter((j) => !used.has(j.canonicalId))) {
      if (jobs.some((j) => used.has(j.canonicalId) && twin(j, spare))) this.#db.prepare('DELETE FROM jobs WHERE canonical_id = ?').run(spare.canonicalId);
    }
    return out;
  }

  /**
   * Once: a fill used to record its form as a second row beside the one it
   * was started for, named the same or still waiting for its name, at the
   * same address, often with the applicant's own city as the job's place.
   * Two rows of one form are one application: the one that got further, or
   * as far, the first, keeps both rows' addresses and answers. Rows that are
   * both live, or whose names say they are different jobs, are left alone.
   */
  #mergeSameForm(): Merged[] {
    const out: Merged[] = [];
    const gone = new Set<string>();
    const rows = (): ApplicationRow[] => this.list({ limit: -1 }).filter((r) => !gone.has(r.id));
    const named = (r: ApplicationRow): string => `${norm(r.job.company)}|${norm(r.job.title)}`;
    const keys = (r: ApplicationRow): Set<string> => new Set([r.url, r.job.url, ...r.job.sourceUrls].map((u) => postingKey(u)).filter((k): k is string => !!k));
    for (const one of rows()) {
      if (gone.has(one.id)) continue;
      const mine = keys(one);
      const twins = rows().filter((r) => r.id !== one.id && r.jobId !== one.jobId && [...keys(r)].some((k) => mine.has(k))
        && (named(r) === named(one) || placeholderName(r.job) || placeholderName(one.job))
        && !(LIVE_STATUSES.includes(r.status) && LIVE_STATUSES.includes(one.status)));
      if (twins.length !== 1) continue;
      const other = twins[0];
      // The row that got further is kept; as far, the first one, which the fill was started for, takes the other's answers.
      const ahead = (RANK[other.status] ?? 0) - (RANK[one.status] ?? 0)
        || (other.createdAt < one.createdAt ? 1 : other.createdAt > one.createdAt ? -1 : other.answers.length - one.answers.length);
      const [stray, real] = ahead > 0 ? [one, other] : [other, one];
      const merged = this.#mergeInto(stray, real);
      if (merged) { gone.add(stray.id); out.push(merged); }
    }
    return out;
  }

  /**
   * The row of the same run for the real company that a misnamed row
   * recorded again: the one whose addresses share its ATS id or host, else
   * the one its title names or matches, else the only one. None when two
   * fit equally.
   */
  #realTwin(stray: ApplicationRow, rows: ApplicationRow[]): ApplicationRow | null {
    const candidates = rows.filter((r) => r.runId === stray.runId && r.id !== stray.id && r.jobId !== stray.jobId && !misnamed(r.job.company));
    if (candidates.length <= 1) return candidates[0] ?? null;
    const urls = (r: ApplicationRow): string[] => [r.url, r.job.url, ...r.job.sourceUrls].filter((u): u is string => !!u);
    const mine = urls(stray);
    const score = (r: ApplicationRow): number => {
      const theirs = urls(r);
      const ats = mine.some((u) => { const id = atsIdentity(u); return !!id && theirs.some((t) => atsIdentity(t) === id); });
      const host = mine.some((u) => { const h = hostName(u); return !!h && theirs.some((t) => hostName(t) === h); });
      const title = norm(stray.job.title);
      const named = title.includes(norm(r.job.company)) || title === norm(r.job.title) || title.includes(norm(r.job.title));
      return (ats ? 4 : 0) + (host ? 2 : 0) + (named ? 1 : 0);
    };
    const scored = candidates.map((r) => ({ r, n: score(r) })).sort((a, b) => b.n - a.n);
    return scored[0].n > 0 && scored[0].n > scored[1].n ? scored[0].r : null;
  }

  /**
   * Once: a submit used to land on a second row named from the page's title
   * ("India — Cursor"), while the job the run had claimed stayed queued. Each
   * such row goes into the claimed job: the further status, every source
   * address, the earlier start. The stray job goes when nothing else refers to it.
   */
  #mergeStraySubmits(): Merged[] {
    const strays = (this.#db.prepare(`
      SELECT * FROM applications WHERE status IN ('applied','unconfirmed') AND run_id IS NOT NULL AND claimed_by IS NULL
        AND confirmation IS NOT NULL AND submitted_at IS NOT NULL AND created_at = submitted_at
    `).all() as Array<Record<string, unknown>>).map(toApplication);
    const out: Merged[] = [];
    for (const stray of strays) {
      const strayJob = this.job(stray.jobId);
      if (!strayJob) continue;
      const claimed = this.#claimedIn(stray.runId!, stray.url ?? strayJob.url ?? '', ['queued', 'prepared'], stray.jobId)?.row;
      if (!claimed) continue;
      try {
        this.#db.exec('BEGIN');
        this.#db.prepare('DELETE FROM applications WHERE id = ?').run(stray.id);
        const status = (PROGRESS[stray.status] ?? -1) > (PROGRESS[claimed.status] ?? -1) ? stray.status : claimed.status;
        // What the submit recorded, its answers and the résumé sent, goes with it onto the row kept.
        this.#db.prepare(`
          UPDATE applications SET status = ?, confirmation = COALESCE(confirmation, ?), submitted_at = COALESCE(submitted_at, ?),
            created_at = MIN(created_at, ?), updated_at = MAX(updated_at, ?), answers = ?, resume_document_id = COALESCE(resume_document_id, ?) WHERE id = ?
        `).run(status, stray.confirmation, stray.submittedAt, stray.createdAt, stray.updatedAt,
          JSON.stringify(mergeAnswers(claimed.answers, stray.answers)), stray.resumeDocumentId, claimed.id);
        for (const u of [strayJob.url, ...strayJob.sourceUrls, stray.url]) if (u) this.#addSource(claimed.jobId, u);
        const used = this.#db.prepare('SELECT 1 FROM applications WHERE job_id = ? LIMIT 1').get(stray.jobId);
        if (!used) this.#db.prepare('DELETE FROM jobs WHERE canonical_id = ?').run(stray.jobId);
        this.#db.exec('COMMIT');
        out.push({ into: claimed.id, job: claimed.jobId, from: stray.id, strayJob: stray.jobId, strayName: `${strayJob.company} — ${strayJob.title}`, status, jobRemoved: !used });
      } catch {
        this.#db.exec('ROLLBACK');
      }
    }
    return out;
  }

  /**
   * The job a run claimed and is still working on, for a submit at this
   * address: the only one, or the one whose addresses share the submit page's
   * host or ATS id, else the one it touched last.
   */
  #claimedIn(runId: string, url: string, statuses: ApplicationStatus[], except?: string): { row: ApplicationRow; near: boolean } | null {
    const rows = this.list({ runId, status: statuses, limit: 50 }).filter((r) => r.jobId !== except);
    const host = hostName(url);
    const ats = atsIdentity(url);
    const near = rows.find((r) => [r.url, r.job.url, ...r.job.sourceUrls].some((u) => (!!ats && (atsIdentity(u) === ats)) || (!!host && hostName(u) === host))
      || (!!ats && r.jobId === ats));
    return near ? { row: near, near: true } : rows[0] ? { row: rows[0], near: false } : null;
  }

  /** Another address this job is known by, unless one already names the same posting. */
  #addSource(jobId: string, url: string): void {
    const job = this.job(jobId);
    const key = postingKey(url);
    if (!job || !key || [job.url, ...job.sourceUrls].some((u) => postingKey(u) === key)) return;
    this.#db.prepare('UPDATE jobs SET source_urls = ? WHERE canonical_id = ?').run(JSON.stringify([...job.sourceUrls, url]), jobId);
  }

  /** Insert or merge a posting. A second sighting adds its URL, nothing else changes. */
  upsertJob(given: JobInput): Job {
    // A results list names no one job, so it is not where this one is.
    const input = namesNoJob(given.url) ? { ...given, url: null } : given;
    const id = this.#resolveIdentity(input);
    const existing = this.job(id);
    const now = new Date().toISOString();
    if (existing) return this.#update(existing, input);
    this.#db.prepare(`
      INSERT INTO jobs (canonical_id, company, title, location, remote, salary_min, salary_max, posted_at, ats, url,
                        source_urls, description_hash, first_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, input.company.trim(), input.title.trim(), input.location ?? null, bool(input.remote),
      input.salaryMin ?? null, input.salaryMax ?? null, input.postedAt ?? null,
      input.ats ?? atsOf(input.url), input.url ?? null,
      JSON.stringify(input.url ? [input.url] : []),
      input.description ? sha(input.description) : null, now);
    return this.job(id)!;
  }

  /**
   * A known job seen again: its new address is kept, what it lacked is filled
   * in, and a stand-in name gives way to the one its page gives. Nothing else
   * changes, and its key stays: what refers to the job keeps finding it.
   */
  #update(existing: Job, input: JobInput): Job {
    const urls = new Set(existing.sourceUrls);
    if (input.url) urls.add(input.url);
    const rename = placeholderName(existing) && !placeholderName(input);
    this.#db.prepare(`
      UPDATE jobs SET source_urls = ?, location = COALESCE(location, ?), remote = COALESCE(remote, ?),
        salary_min = COALESCE(salary_min, ?), salary_max = COALESCE(salary_max, ?),
        posted_at = COALESCE(posted_at, ?), ats = COALESCE(ats, ?), url = COALESCE(url, ?),
        company = CASE WHEN ? THEN ? ELSE company END, title = CASE WHEN ? THEN ? ELSE title END
      WHERE canonical_id = ?
    `).run([...urls].length ? JSON.stringify([...urls]) : '[]', input.location ?? null, bool(input.remote),
      input.salaryMin ?? null, input.salaryMax ?? null, input.postedAt ?? null,
      input.ats ?? atsOf(input.url), input.url ?? null,
      rename ? 1 : 0, input.company.trim(), rename ? 1 : 0, input.title.trim(), existing.canonicalId);
    return this.job(existing.canonicalId)!;
  }

  /** Jobs one of whose addresses is this posting, the one first seen at it first. */
  #jobsAt(key: string): Job[] {
    const term = likeTerm(key);
    const rows = this.#db.prepare("SELECT * FROM jobs WHERE url LIKE ? ESCAPE '\\' OR source_urls LIKE ? ESCAPE '\\' ORDER BY first_seen_at")
      .all(term, term) as Array<Record<string, unknown>>;
    const jobs = rows.map(toJob).filter((j) => [j.url, ...j.sourceUrls].some((u) => postingKey(u) === key));
    return [...jobs.filter((j) => postingKey(j.url) === key), ...jobs.filter((j) => postingKey(j.url) !== key)];
  }

  /**
   * The same posting is often met twice: on a job board, then on the
   * company's own page after following its Apply link. The second has an
   * exact id from the applicant-tracking system and the first only a name.
   * When exactly one known job has the same company and title, and their
   * locations agree, they are one job. Anything less certain stays two rows:
   * merging two different jobs would hide one of them.
   */
  #resolveIdentity(input: JobInput): string {
    const id = canonicalJobId(input);
    if (this.job(id)) return id;
    const exact = id.startsWith('ats:');
    const company = norm(input.company);
    const title = norm(input.title);
    const location = input.location?.trim() ?? '';
    const posting = postingKey(input.url);
    const board = boardKey(input.url);
    // The job already known at this address: whatever it is called, when this
    // names nobody; when it does, the one called that, or one still waiting for
    // its name. A page listing several jobs is never all of them.
    if (posting && !exact && !board) {
      const here = this.#jobsAt(posting);
      const at = placeholderName(input) ? here[0]
        : here.find((j) => norm(j.company) === company && norm(j.title) === title) ?? here.find((j) => placeholderName(j));
      if (at) return at.canonicalId;
    }
    // A stand-in name says nothing about which job it is: two pages that name nobody are two jobs.
    if (placeholderName(input)) return id;
    const known = (this.#db.prepare('SELECT * FROM jobs').all() as Array<Record<string, unknown>>).map(toJob);
    const boards = (j: Job): Array<string | null> => [j.url, ...j.sourceUrls].map(boardKey).filter(Boolean);
    // The board's own id is the posting, whatever it was called when first recorded.
    const listed = board ? known.find((j) => boards(j).includes(board)) : undefined;
    if (listed) return listed.canonicalId;
    const candidates = known
      // An exact id only adopts a name-only row.
      .filter((j) => !exact || !j.canonicalId.startsWith('ats:'))
      // Two board ids are two postings, however alike they are named.
      .filter((j) => !board || !boards(j).length)
      .filter((j) => norm(j.company) === company && norm(j.title) === title)
      .filter((j) => {
        if (location && j.location) return samePlace(location, j.location);
        if (!location && !j.location) return true;
        // One names a place and the other does not. Followed from a board to
        // the company's own page, it is the same job, and so is the one job a
        // board or an ATS already knows by its id; otherwise only the same
        // posting is, or two jobs in two cities would fold into one.
        return exact || !posting || /^(?:ats|board):/.test(j.canonicalId) || [j.url, ...j.sourceUrls].some((u) => postingKey(u) === posting);
      });
    if (candidates.length !== 1) return id;
    const twin = candidates[0];
    if (!exact) return twin.canonicalId;

    // The board row takes the exact id. Its applications move with it, unless
    // that would put two live applications on one job.
    try {
      this.#db.exec('BEGIN');
      // Copied under the new id, then the old row removed: applications
      // refer to the job by id, so the id cannot be changed in place.
      this.#db.prepare(`
        INSERT INTO jobs (canonical_id, company, title, location, remote, salary_min, salary_max, posted_at, ats, url,
                          source_urls, description_hash, first_seen_at)
        SELECT ?, company, title, location, remote, salary_min, salary_max, posted_at, COALESCE(ats, ?), url,
               source_urls, description_hash, first_seen_at
        FROM jobs WHERE canonical_id = ?
      `).run(id, atsOf(input.url), twin.canonicalId);
      this.#db.prepare('UPDATE applications SET job_id = ? WHERE job_id = ?').run(id, twin.canonicalId);
      this.#db.prepare('DELETE FROM jobs WHERE canonical_id = ?').run(twin.canonicalId);
      this.#db.exec('COMMIT');
    } catch {
      this.#db.exec('ROLLBACK');
    }
    return id;
  }

  /** Give a job the name its page shows, once; a job already named is left alone. */
  retitle(canonicalId: string, name: { company: string; title: string }): void {
    this.#db.prepare('UPDATE jobs SET company = ?, title = ? WHERE canonical_id = ?')
      .run(name.company.trim(), name.title.trim(), canonicalId);
  }

  job(canonicalId: string): Job | null {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE canonical_id = ?').get(canonicalId) as Record<string, unknown> | undefined;
    return row ? toJob(row) : null;
  }

  /** The job an address is one of: the posting it is, or another address of the same posting by its ATS id. */
  jobIdForUrl(url: string): string | null {
    const posted = this.forPosting(url);
    if (posted) return posted.jobId;
    const ats = atsIdentity(url);
    if (!ats) return null;
    // A job with an application first: that is the ledger's job, whatever other rows name the posting.
    const term = `%${ats.split(':').pop()!.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.#rows(["(j.url LIKE ? ESCAPE '\\' OR j.source_urls LIKE ? ESCAPE '\\' OR a.url LIKE ? ESCAPE '\\')"], [term, term, term]);
    const row = rows.find((r) => [r.url, r.job.url, ...r.job.sourceUrls].some((u) => atsIdentity(u) === ats));
    if (row) return row.jobId;
    return this.job(ats) ? ats : null;
  }

  /** Which job this would be filed under, without writing anything. */
  identityOf(given: JobInput): string {
    return this.#resolveIdentity(namesNoJob(given.url) ? { ...given, url: null } : given);
  }

  /** A record that was refused leaves the job as it found it: a row it made goes, a row it changed is put back. */
  restoreJob(canonicalId: string, before: Job | null): void {
    if (!before) {
      this.#db.prepare('DELETE FROM jobs WHERE canonical_id = ? AND NOT EXISTS (SELECT 1 FROM applications WHERE job_id = ?)').run(canonicalId, canonicalId);
      return;
    }
    this.#db.prepare(`UPDATE jobs SET company = ?, title = ?, location = ?, remote = ?, salary_min = ?, salary_max = ?, posted_at = ?, ats = ?, url = ?, source_urls = ?
      WHERE canonical_id = ?`).run(before.company, before.title, before.location ?? null, bool(before.remote), before.salaryMin ?? null, before.salaryMax ?? null,
      before.postedAt ?? null, before.ats ?? null, before.url ?? null, JSON.stringify(before.sourceUrls), canonicalId);
  }

  /** The live application for a job, if one exists. */
  liveApplication(jobId: string): Application | null {
    const row = this.#db.prepare(
      `SELECT * FROM applications WHERE job_id = ? AND status IN (${LIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
    ).get(jobId, ...LIVE_STATUSES) as Record<string, unknown> | undefined;
    return row ? toApplication(row) : null;
  }

  /**
   * Record what happened with a job.
   *
   * Returns the row, or a refusal when the job already has a live application.
   * The refusal is the rule, not an error: the caller records a skip with the
   * reason, so the worker can say "already applied" rather than silently
   * doing nothing.
   */
  record(a: {
    job: JobInput; status: ApplicationStatus; workerId?: string | null; runId?: string | null;
    skipReason?: string | null; answers?: Answer[]; resumeDocumentId?: string | null; coverLetter?: string | null;
    match?: number | null; fitNote?: string | null; url?: string | null; confirmation?: string | null;
    effectKey?: string | null; claim?: Claim | null; fit?: FitVerdict | null;
    /** The application this record is about, when the caller knows it: a fill of that row, which updates it whatever the run calls the job. */
    into?: string | null;
  }): { ok: true; application: Application; job: Job } | { ok: false; why: string; existing: Application; job: Job } {
    const target = a.into ? this.application(a.into) : null;
    const known = target ? this.job(target.jobId) : null;
    const job = known ? this.#update(known, a.job) : this.upsertJob(a.job);
    // One row per (job, worker) outside the live set too: a worker re-reading
    // a page yesterday skipped should not add a second skip.
    const priorRow = known ? undefined : this.#db.prepare(
      'SELECT * FROM applications WHERE job_id = ? AND COALESCE(worker_id, \'\') = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(job.canonicalId, a.workerId ?? '') as Record<string, unknown> | undefined;
    const prior = known ? target : priorRow ? toApplication(priorRow) : null;
    const held = a.claim ? heldByAnother(prior, a.claim) : null;
    if (held) {
      // What another session saw of a job it does not hold is not written over the holder's row.
      if (!CLAIMING.includes(a.status)) return { ok: true, application: held, job };
      return { ok: false, why: claimedWhy(held), existing: held, job };
    }
    const live = this.liveApplication(job.canonicalId);
    const own = live && (live.workerId ?? '') === (a.workerId ?? '');
    if (live && LIVE_STATUSES.includes(a.status)) {
      // The worker that holds it takes its own application on, prepared to
      // applied; a second application, or one going back, is refused.
      if (!own || !(PROGRESS[a.status]! > PROGRESS[live.status]!)) {
        return { ok: false, why: `already ${live.status} on ${whenSaid(live.updatedAt)}`, existing: live, job };
      }
    }
    // The holder of a submit nobody saw confirmed may say, with its reason, that it did not go through:
    // it waits for the user, or is given up. Applied stays applied.
    const reason = (a.skipReason ?? a.fitNote ?? '').trim();
    const holder = live && ((!!a.claim && live.claimedBy === a.claim.by) || (!!a.runId && live.runId === a.runId));
    const takenBack = !!live && own && holder && live.status === 'unconfirmed' && (a.status === 'needs_review' || a.status === 'skipped') && !!reason;
    // Something that was sent stays sent: recording it again as found or
    // skipped would hide it, and let it be applied to a second time.
    if (live && own && SENT.includes(live.status) && !LIVE_STATUSES.includes(a.status) && !takenBack) return { ok: true, application: live, job };
    // Waiting in Review for one worker is a claim too: a second worker
    // queueing the same job would put it in front of the user twice.
    if (CLAIMING.includes(a.status)) {
      const claimed = this.#db.prepare(
        "SELECT * FROM applications WHERE job_id = ? AND COALESCE(worker_id, '') != ? AND status IN ('needs_review','queued') LIMIT 1",
      ).get(job.canonicalId, a.workerId ?? '') as Record<string, unknown> | undefined;
      if (claimed) {
        const existing = toApplication(claimed);
        return { ok: false, why: `already waiting for review (${existing.status}) for another worker`, existing, job };
      }
    }
    const now = new Date().toISOString();
    // The match column holds the fit verdict as JSON, with the agent's own score inside it; a bare score only when there is no verdict.
    const verdict = a.fit ?? prior?.fit ?? null;
    const score = a.match ?? prior?.match ?? null;
    const match = verdict ? JSON.stringify({ ...verdict, ...(score !== null ? { score } : {}) }) : a.match ?? null;
    if (prior) {
      const id = prior.id;
      // A lapsed claim passes to whoever records next; anyone else's record leaves the holder as it was.
      // A note from before a move ("Not submitted: …" on a row now applied) does not stay on it.
      this.#db.prepare(`
        UPDATE applications SET status = ?, skip_reason = ?, answers = ?, resume_document_id = COALESCE(?, resume_document_id),
          cover_letter = COALESCE(?, cover_letter), match = COALESCE(?, match), fit_note = COALESCE(?, fit_note),
          url = COALESCE(?, url), confirmation = CASE WHEN status = ? THEN COALESCE(?, confirmation) ELSE ? END, effect_key = COALESCE(?, effect_key),
          run_id = COALESCE(?, run_id), claimed_by = COALESCE(?, claimed_by), updated_at = ?,
          submitted_at = CASE WHEN ? IN ('applied','unconfirmed') THEN COALESCE(submitted_at, ?) ELSE submitted_at END
        WHERE id = ?
      `).run(a.status, a.skipReason ?? null, JSON.stringify(a.answers ?? prior.answers),
        a.resumeDocumentId ?? null, a.coverLetter ?? null, match, a.fitNote ?? null, a.url ?? null,
        a.status, a.confirmation ?? null, a.confirmation ?? null, a.effectKey ?? null, a.runId ?? null, a.claim?.by ?? null, now, a.status, now, id);
      return { ok: true, application: this.#changed(this.application(id))!, job };
    }
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO applications (id, job_id, worker_id, run_id, status, skip_reason, answers, resume_document_id,
        cover_letter, match, fit_note, url, confirmation, effect_key, claimed_by, created_at, updated_at, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, job.canonicalId, a.workerId ?? null, a.runId ?? null, a.status, a.skipReason ?? null,
      JSON.stringify(a.answers ?? []), a.resumeDocumentId ?? null, a.coverLetter ?? null, match,
      a.fitNote ?? null, a.url ?? null, a.confirmation ?? null, a.effectKey ?? null, a.claim?.by ?? null, now, now,
      a.status === 'applied' || a.status === 'unconfirmed' ? now : null);
    return { ok: true, application: this.#changed(this.application(id))!, job };
  }

  application(id: string): Application | null {
    const row = this.#db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toApplication(row) : null;
  }

  /** Keep a screening verdict on an application, beside any score it had. Its status is not touched. */
  setFit(id: string, fit: FitVerdict): Application | null {
    const current = this.application(id);
    if (!current) return null;
    const score = current.match ?? fit.score;
    this.#db.prepare('UPDATE applications SET match = ? WHERE id = ?').run(JSON.stringify({ ...fit, ...(score !== undefined && score !== null ? { score } : {}) }), id);
    return this.application(id);
  }

  /** What a posting requires, as it was read once (fit.ts); null when it has not been. */
  requirements(postingKey: string): unknown {
    const row = this.#db.prepare('SELECT requirements FROM posting_requirements WHERE posting_key = ?').get(postingKey) as { requirements: string } | undefined;
    return json<unknown>(row?.requirements, null);
  }

  setRequirements(postingKey: string, title: string, requirements: unknown): void {
    this.#db.prepare(`
      INSERT INTO posting_requirements (posting_key, title, requirements, read_at) VALUES (?,?,?,?)
      ON CONFLICT(posting_key) DO UPDATE SET title = excluded.title, requirements = excluded.requirements, read_at = excluded.read_at
    `).run(postingKey, title, JSON.stringify(requirements), new Date().toISOString());
  }

  /** The application for the posting at this address, the live one first. */
  forPosting(url: string): ApplicationRow | null {
    const key = postingKey(url);
    if (!key) return null;
    // Read straight from the ledger, however old: a posting applied to long ago is still applied to.
    const term = likeTerm(key);
    const rows = this.#rows(["(j.url LIKE ? ESCAPE '\\' OR j.source_urls LIKE ? ESCAPE '\\' OR a.url LIKE ? ESCAPE '\\')"], [term, term, term])
      .filter((r) => [r.url, r.job.url, ...r.job.sourceUrls].some((u) => postingKey(u) === key));
    return rows.find((r) => LIVE_STATUSES.includes(r.status)) ?? rows[0] ?? null;
  }

  /**
   * An application went out from this page after the person approved it. Its
   * row moves to applied, or unconfirmed when the page showed no
   * confirmation; a page nobody recorded gets a row, named from its title, so
   * it is not filled and sent again.
   */
  markSubmitted(a: {
    url: string; pageTitle: string | null; runId?: string | null; status: 'applied' | 'unconfirmed';
    confirmation: string | null; isApplication: boolean;
    /** The application this press finished, when its page is not the posting's: the code step at /verify. */
    applicationId?: string | null;
  }): Application | null {
    const own = a.applicationId ? this.application(a.applicationId) : null;
    // The job this run claimed is the one it submitted, wherever the form was: a careers page, an ATS, a code step.
    // A press on another host counts only when its page says it is an application, not a message sent in the same run;
    // and a posting known as another job, on a host none of the run's claims share, outranks the claim.
    const found = own || !a.runId ? null : this.#claimedIn(a.runId, a.url, ['queued', 'prepared', 'applying']);
    const claim = found && (found.near || a.isApplication) ? found : null;
    const posted = own || claim?.near ? null : this.forPosting(a.url);
    const claimed = claim && !(posted && posted.jobId !== claim.row.jobId) ? claim.row : null;
    const row = own ?? claimed ?? posted;
    if (row) {
      // The page it went from is one more address of the job, so the next look-up by it finds the same job.
      if (!own) this.#addSource(row.jobId, a.url);
      // What Fanfold gave the form in this run goes on the application now, whether or not the host records it.
      const given = a.runId ? this.#givenFor(a.runId, row, a.url) : [];
      const answers = given.length ? mergeAnswers(given, row.answers) : undefined;
      if (row.status === 'applied' || row.status === a.status) return answers ? this.keepAnswers(row.id, { answers }) ?? row : row;
      try {
        // The application keeps the posting's address, not the code page's or the form's.
        return this.transition(row.id, a.status, { confirmation: a.confirmation, url: own || claimed ? null : a.url, answers });
      } catch {
        return null;
      }
    }
    if (!a.isApplication) return null;
    // Named as the run named it when it claimed the job; the page's title is the last resort, never a place or a host.
    const named = a.runId ? this.list({ runId: a.runId, limit: 1 })[0]?.job : undefined;
    const r = this.record({
      job: { ...(named ? { company: named.company, title: named.title, location: named.location } : jobFromTitle(a.pageTitle, a.url)), url: a.url },
      status: a.status, runId: a.runId ?? null, url: a.url, confirmation: a.confirmation,
    });
    if (!r.ok) return null;
    const given = a.runId ? this.#givenFor(a.runId, r.application, a.url) : [];
    return given.length ? this.keepAnswers(r.application.id, { answers: given }) ?? r.application : r.application;
  }

  /** Runs in which Fanfold's own agent pressed a control that sends (a Submit), as the policy judged it. */
  readonly #submitted = new Map<string, number>();

  /** This run pressed a Submit and the press went through: it may record the application as applied. */
  noteSubmitted(runId: string): void {
    if (!runId) return;
    const dayAgo = Date.now() - DAY_MS;
    for (const [id, at] of this.#submitted) if (at < dayAgo) this.#submitted.delete(id);
    this.#submitted.set(runId, Date.now());
  }

  submittedIn(runId: string | null | undefined): boolean {
    return !!runId && this.#submitted.has(runId);
  }

  /** Runs started for one application ("Fill it now", a submit approved in Review), by run id. */
  readonly #bound = new Map<string, { id: string; at: number }>();

  /** This run fills that application: what it records about the job goes on that row, whatever it calls the job. */
  bindRun(runId: string, applicationId: string): void {
    if (!runId) return;
    const dayAgo = Date.now() - DAY_MS;
    for (const [id, b] of this.#bound) if (b.at < dayAgo) this.#bound.delete(id);
    this.#bound.set(runId, { id: applicationId, at: Date.now() });
    // The row knows the run at work on it, so a Submit it presses and what it waits on are found by it.
    this.#db.prepare('UPDATE applications SET run_id = ? WHERE id = ?').run(runId, applicationId);
  }

  /** The application a run was started for, when it was started for one. */
  boundTo(runId: string | null | undefined): string | null {
    return runId ? this.#bound.get(runId)?.id ?? null : null;
  }

  /**
   * Answers Fanfold gave a form in this run, kept until the form is sent: the
   * submit puts them on the application, so the record does not depend on the
   * host reporting them. The newest answer to a question wins.
   */
  noteGiven(runId: string, where: { jobId?: string | null; url?: string | null }, answers: Answer[]): void {
    if (!runId || !answers.length) return;
    const put = this.#db.prepare(`
      INSERT INTO given_answers (run_id, job_id, url, question, answer, source, worked_out, at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id, question, url) DO UPDATE SET job_id = COALESCE(excluded.job_id, job_id), answer = excluded.answer,
        source = excluded.source, worked_out = excluded.worked_out, at = excluded.at
    `);
    const now = new Date().toISOString();
    for (const a of answers) {
      put.run(runId, where.jobId ?? null, where.url ?? '', a.question.slice(0, 300), a.answer.slice(0, 2000), a.source, a.workedOutFrom ? JSON.stringify(a.workedOutFrom) : null, now);
    }
    // Nothing waits on a form for days; what was never sent is let go.
    this.#db.prepare('DELETE FROM given_answers WHERE at < ?').run(new Date(Date.now() - 3 * DAY_MS).toISOString());
  }

  /**
   * What Fanfold's own agent typed into this job's form in this run, taken
   * once: the application keeps it, and the next job the run fills starts
   * with none. A field typed on a page of the same site counts, since a form
   * often sits at an address of its own.
   */
  takeTyped(runId: string, app: Application, also: string | null): Answer[] {
    const job = this.job(app.jobId);
    const urls = [app.url, job?.url, ...(job?.sourceUrls ?? []), also];
    const keys = new Set(urls.map((u) => postingKey(u ?? '')).filter(Boolean));
    const hosts = new Set(urls.map((u) => hostName(u)).filter(Boolean));
    const rows = this.#db.prepare("SELECT * FROM given_answers WHERE run_id = ? AND source = 'TYPED' ORDER BY at, rowid").all(runId) as Array<Record<string, unknown>>;
    const out = new Map<string, Answer>();
    const del = this.#db.prepare('DELETE FROM given_answers WHERE run_id = ? AND question = ? AND url = ?');
    for (const r of rows) {
      const url = String(r.url ?? '');
      if (r.job_id !== app.jobId && !keys.has(postingKey(url)) && !hosts.has(hostName(url))) continue;
      out.set(normQuestion(String(r.question)), { question: String(r.question), answer: String(r.answer), source: 'TYPED' });
      del.run(runId, r.question as string, url);
    }
    return [...out.values()];
  }

  /** Answers an application does not have yet, added after the ones it has; one it has for a question stays as it is. */
  addAnswers(id: string, answers: Answer[]): Application | null {
    const current = this.application(id);
    if (!current || !answers.length) return current;
    const have = new Set(current.answers.map((a) => normQuestion(a.question)));
    const merged = [...current.answers, ...answers.filter((a) => !have.has(normQuestion(a.question)))];
    if (merged.length === current.answers.length) return current;
    this.#db.prepare('UPDATE applications SET answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), new Date().toISOString(), id);
    return this.application(id);
  }

  /** What Fanfold gave this run's forms for this job from what it holds, typed answers aside. */
  givenIn(runId: string, app: Application, also: string | null): Answer[] {
    return this.#givenFor(runId, app, also);
  }

  /** What Fanfold gave this run's forms for this job, by its id or one of its addresses. */
  #givenFor(runId: string, app: Application, also: string | null): Answer[] {
    const job = this.job(app.jobId);
    const keys = new Set([app.url, job?.url, ...(job?.sourceUrls ?? []), also].map((u) => postingKey(u ?? '')).filter(Boolean));
    // What was typed waits for the record, which labels it by where it came from (takeTyped).
    const rows = this.#db.prepare("SELECT * FROM given_answers WHERE run_id = ? AND source != 'TYPED' ORDER BY at").all(runId) as Array<Record<string, unknown>>;
    const out = new Map<string, Answer>();
    for (const r of rows) {
      if (r.job_id !== app.jobId && !keys.has(postingKey(String(r.url ?? '')))) continue;
      const worked = r.worked_out ? JSON.parse(String(r.worked_out)) as Answer['workedOutFrom'] : undefined;
      out.set(normQuestion(String(r.question)), { question: String(r.question), answer: String(r.answer), source: String(r.source), ...(worked ? { workedOutFrom: worked } : {}) });
    }
    return [...out.values()];
  }

  /**
   * A document applications recorded as their résumé is gone. One not sent
   * yet follows the résumé that replaced it, or holds none and keeps the
   * removed file's name to say so; one already sent keeps the name of the
   * file it went with, as text, never an id that leads nowhere. How many changed.
   */
  documentGone(documentId: string, title: string, replacement: { id: string } | null = null): number {
    const sent = SENT.map(() => '?').join(', ');
    const went = this.#db.prepare(`UPDATE applications SET resume_document_id = NULL, resume_title = COALESCE(resume_title, ?)
      WHERE resume_document_id = ? AND status IN (${sent})`).run(title, documentId, ...SENT).changes;
    const waiting = this.#db.prepare(`UPDATE applications SET resume_document_id = ?, resume_title = ?
      WHERE resume_document_id = ? AND status NOT IN (${sent})`).run(replacement?.id ?? null, replacement ? null : title, documentId, ...SENT).changes;
    return Number(went) + Number(waiting);
  }

  /**
   * Answers and the résumé reported for an application already sent, kept on
   * it without changing its status: a host often records after the submit.
   * What it reports for a question replaces what was kept for that question.
   * Null when there was nothing new to keep.
   */
  keepAnswers(id: string, given: { answers?: Answer[]; resumeDocumentId?: string | null }): Application | null {
    const current = this.application(id);
    if (!current) return null;
    const answers = mergeAnswers(current.answers, given.answers ?? []);
    const resume = given.resumeDocumentId && given.resumeDocumentId !== current.resumeDocumentId ? given.resumeDocumentId : null;
    if (JSON.stringify(answers) === JSON.stringify(current.answers) && !resume) return null;
    this.#db.prepare('UPDATE applications SET answers = ?, resume_document_id = COALESCE(?, resume_document_id), updated_at = ? WHERE id = ?')
      .run(JSON.stringify(answers), resume, new Date().toISOString(), id);
    return this.application(id);
  }

  /** Move an application. Only the user moves one backwards; the caller decides that. */
  transition(id: string, status: ApplicationStatus, patch: {
    skipReason?: string | null; answers?: Answer[]; confirmation?: string | null; url?: string | null;
  } = {}): Application | null {
    const current = this.application(id);
    if (!current) return null;
    if (LIVE_STATUSES.includes(status) && !LIVE_STATUSES.includes(current.status)) {
      const live = this.liveApplication(current.jobId);
      if (live && live.id !== id) throw new Error(`this job already has a live application (${live.status})`);
    }
    const now = new Date().toISOString();
    // A note says how the row came to stand where it does: one from before a move ("Not submitted: …" on a row now applied) is not kept.
    const moved = status !== current.status;
    // Why it was skipped stays with a skip, and goes once the job is taken up again.
    const keepReason = !moved || status === 'skipped' || status === 'failed';
    this.#db.prepare(`
      UPDATE applications SET status = ?, skip_reason = CASE WHEN ? THEN COALESCE(?, skip_reason) ELSE ? END, answers = ?,
        confirmation = CASE WHEN ? THEN ? ELSE COALESCE(?, confirmation) END, url = COALESCE(?, url), updated_at = ?,
        submitted_at = CASE WHEN ? IN ('applied','unconfirmed') THEN COALESCE(submitted_at, ?) ELSE submitted_at END
      WHERE id = ?
    `).run(status, keepReason ? 1 : 0, patch.skipReason ?? null, patch.skipReason ?? null, JSON.stringify(patch.answers ?? current.answers),
      moved ? 1 : 0, patch.confirmation ?? null, patch.confirmation ?? null, patch.url ?? null, now, status, now, id);
    return this.#changed(this.application(id));
  }

  /**
   * Take an application out of the ledger at the owner's word: its row, the
   * older skips of the same job that the list shows as this one, and, once no
   * other row refers to the job, the job and what Fanfold gave its forms, so
   * the job found again is a new one. One transaction: `also` runs inside it,
   * so whatever goes with the row goes with it or not at all. Null when there
   * is no such application.
   */
  remove(id: string, also?: (rows: ApplicationRow[], jobRemoved: boolean) => void): { rows: ApplicationRow[]; jobRemoved: boolean } | null {
    const row = this.row(id);
    if (!row) return null;
    const rows = [row, ...this.list({ jobId: row.jobId, status: 'skipped', limit: -1 }).filter((r) => r.id !== id && r.updatedAt <= row.updatedAt)];
    this.#db.exec('BEGIN');
    try {
      const drop = this.#db.prepare('DELETE FROM applications WHERE id = ?');
      for (const r of rows) drop.run(r.id);
      const jobRemoved = !this.#db.prepare('SELECT 1 FROM applications WHERE job_id = ? LIMIT 1').get(row.jobId);
      if (jobRemoved) {
        this.#db.prepare('DELETE FROM jobs WHERE canonical_id = ?').run(row.jobId);
        this.#db.prepare('DELETE FROM given_answers WHERE job_id = ?').run(row.jobId);
      }
      also?.(rows, jobRemoved);
      this.#db.exec('COMMIT');
      const ids = new Set(rows.map((r) => r.id));
      for (const [runId, b] of this.#bound) if (ids.has(b.id)) this.#bound.delete(runId);
      return { rows, jobRemoved };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  list(filter: ApplicationFilter = {}): ApplicationRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
    if (filter.workerId) { where.push('a.worker_id = ?'); args.push(filter.workerId); }
    if (filter.runId) { where.push('a.run_id = ?'); args.push(filter.runId); }
    if (filter.jobId) { where.push('a.job_id = ?'); args.push(filter.jobId); }
    if (filter.ats) { where.push('j.ats = ?'); args.push(filter.ats); }
    if (filter.search) {
      where.push('(j.company LIKE ? OR j.title LIKE ?)');
      args.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    return this.#rows(where, args, filter.limit ?? 200);
  }

  /** Applications with their jobs, newest first; every one that matches when no limit is given. */
  #rows(where: string[], args: SQLInputValue[], limit = -1): ApplicationRow[] {
    const rows = this.#db.prepare(`
      SELECT a.*, j.company, j.title, j.location, j.remote, j.salary_min, j.salary_max, j.posted_at, j.ats,
             j.url AS job_url, j.source_urls, j.first_seen_at
      FROM applications a JOIN jobs j ON j.canonical_id = a.job_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.updated_at DESC LIMIT ?
    `).all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...toApplication(r), job: toJob({ ...r, canonical_id: r.job_id, url: r.job_url }) }));
  }

  /** One application with its job, looked up by its id. */
  row(id: string): ApplicationRow | null {
    return this.#rows(['a.id = ?'], [id], 1)[0] ?? null;
  }

  /**
   * Queued claims a previous start held: the connections that made them are
   * gone, so the claims lapse and any session may take the job. The rows stay
   * queued, for the owner to resume or drop. Returns how many lapsed.
   */
  lapseClaimsFrom(before: string): number {
    return Number(this.#db.prepare("UPDATE applications SET claimed_by = NULL WHERE status = 'queued' AND claimed_by IS NOT NULL AND updated_at < ?")
      .run(before).changes);
  }

  /** Counts by status, for the funnel. */
  funnel(workerId?: string): Record<ApplicationStatus, number> & { total: number } {
    const rows = (workerId
      ? this.#db.prepare('SELECT status, COUNT(*) AS n FROM applications WHERE worker_id = ? GROUP BY status').all(workerId)
      : this.#db.prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status').all()
    ) as Array<{ status: string; n: number }>;
    const out = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])) as Record<ApplicationStatus, number> & { total: number };
    let total = 0;
    for (const r of rows) { out[r.status as ApplicationStatus] = r.n; total += r.n; }
    out.total = total;
    return out;
  }

  /** Applications a worker submitted since a point in time, for its daily cap. */
  submittedSince(workerId: string, since: Date): number {
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM applications WHERE worker_id = ? AND status IN ('applied','unconfirmed','applying') AND submitted_at >= ?",
    ).get(workerId, since.toISOString()) as { n: number };
    return row.n;
  }

  /** How many were applied today across all workers, and how many wait. */
  today(now = new Date()): { applied: number; review: number; skipped: number; unconfirmed: number } {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const count = (sql: string, ...a: SQLInputValue[]): number =>
      (this.#db.prepare(sql).get(...a) as { n: number }).n;
    return {
      applied: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'applied' AND submitted_at >= ?", start),
      review: count("SELECT COUNT(*) AS n FROM applications WHERE status IN ('needs_review','prepared','queued')"),
      skipped: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'skipped' AND updated_at >= ?", start),
      unconfirmed: count("SELECT COUNT(*) AS n FROM applications WHERE status = 'unconfirmed'"),
    };
  }
}

/** The settings key that says the one-time merge of stray submit rows has run. */
const REPAIR_SETTING = 'jobs.repair.straySubmits';
/** The settings key that says the one-time merge of rows named after a host or a place has run. */
const REPAIR_NAMES_SETTING = 'jobs.repair.misnamedRows';
const REPAIR_TWINS_SETTING = 'jobs.repair.twinRows';
/** The settings key that says the one-time merge of a form recorded on two rows has run. */
const REPAIR_SAME_FORM_SETTING = 'jobs.repair.sameFormRows';
/** The settings key that says the one-time merge of jobs named apart only by accents has run. */
const REPAIR_ACCENTS_SETTING = 'jobs.repair.accentTwins';

/** How far each status has gone, for keeping the further of two rows of one job. */
const RANK: Record<ApplicationStatus, number> = { found: 0, failed: 0, skipped: 1, queued: 2, needs_review: 3, prepared: 4, applying: 5, unconfirmed: 6, applied: 7 };

/** A company name that is a host or a place read off a page title ("ats.rippling.com", "India", "India — Cursor"), not a company. */
function misnamed(company: string): boolean {
  const c = company.trim();
  if (!c || looksLikeHost(c) || looksLikePlace(c)) return true;
  const first = c.split(/\s+[–—-]\s+/)[0];
  return first !== c && looksLikePlace(first);
}

/** One stray submit row merged into the job its run had claimed. */
interface Merged { into: string; job: string; from: string; strayJob: string; strayName: string; status: ApplicationStatus; jobRemoved: boolean }

function hostName(url: string | null | undefined): string | null {
  try { return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : null; } catch { return null; }
}

/** The row, when a session other than this caller holds the job and its claim has not lapsed. */
function heldByAnother(row: Application | null, claim: Claim): Application | null {
  if (!row?.claimedBy || row.claimedBy === claim.by || !CLAIMING.includes(row.status)) return null;
  // Whatever its status, a claim whose connection is gone passes to whoever records next: the job stays where it was.
  if (claim.gone?.(row.claimedBy)) return null;
  if (row.status !== 'queued') return row;
  const quiet = Date.now() - Date.parse(row.updatedAt) > CLAIM_LAPSES_MS;
  return quiet && !claim.busy?.(row) ? null : row;
}

function claimedWhy(held: Application): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(held.updatedAt)) / 60_000));
  if (held.status === 'queued') return `another session claimed it ${minutes} minute${minutes === 1 ? '' : 's'} ago and is working on it, so leave it to that session`;
  if (held.status === 'needs_review') return 'another session left it waiting for the user\'s review, so leave it to that session';
  return `already ${held.status} on ${whenSaid(held.updatedAt)} by another session`;
}

function bool(v: boolean | null | undefined): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

function atsOf(url: string | null | undefined): string | null {
  const id = atsIdentity(url);
  return id ? id.split(':')[1] : null;
}

function toJob(r: Record<string, unknown>): Job {
  return {
    canonicalId: String(r.canonical_id),
    company: String(r.company),
    title: String(r.title),
    location: (r.location as string) ?? null,
    remote: r.remote === null || r.remote === undefined ? null : Number(r.remote) === 1,
    salaryMin: r.salary_min === null || r.salary_min === undefined ? null : Number(r.salary_min),
    salaryMax: r.salary_max === null || r.salary_max === undefined ? null : Number(r.salary_max),
    postedAt: (r.posted_at as string) ?? null,
    ats: (r.ats as string) ?? null,
    url: (r.url as string) ?? null,
    sourceUrls: JSON.parse(String(r.source_urls ?? '[]')) as string[],
    firstSeenAt: String(r.first_seen_at),
  };
}

/** The match column: a bare score, or a fit verdict as JSON with the score inside it. */
function matchOf(v: unknown): { match: number | null; fit: FitVerdict | null } {
  if (typeof v === 'number') return { match: v, fit: null };
  if (typeof v !== 'string' || !v.startsWith('{')) return { match: v === null || v === undefined || v === '' ? null : Number(v), fit: null };
  try {
    const fit = JSON.parse(v) as FitVerdict;
    return { match: typeof fit.score === 'number' ? fit.score : null, fit };
  } catch {
    return { match: null, fit: null };
  }
}

function toApplication(r: Record<string, unknown>): Application {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    workerId: (r.worker_id as string) ?? null,
    runId: (r.run_id as string) ?? null,
    status: String(r.status) as ApplicationStatus,
    skipReason: (r.skip_reason as string) ?? null,
    answers: JSON.parse(String(r.answers ?? '[]')) as Answer[],
    resumeDocumentId: (r.resume_document_id as string) ?? null,
    resumeTitle: (r.resume_title as string) ?? null,
    coverLetter: (r.cover_letter as string) ?? null,
    ...matchOf(r.match),
    fitNote: (r.fit_note as string) ?? null,
    url: (r.url as string) ?? null,
    confirmation: (r.confirmation as string) ?? null,
    effectKey: (r.effect_key as string) ?? null,
    claimedBy: (r.claimed_by as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    submittedAt: (r.submitted_at as string) ?? null,
  };
}

const normQuestion = (q: string): string => q.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Two lists of answers as one: a question in `over` replaces the same
 * question in `base`, unless it says the same thing from the same source;
 * the rest keep their order.
 */
function mergeAnswers(base: Answer[], over: Answer[]): Answer[] {
  const by = new Map(base.map((a) => [normQuestion(a.question), a]));
  for (const a of over) {
    const had = by.get(normQuestion(a.question));
    if (had && had.answer.trim() === a.answer.trim() && had.source === a.source) continue;
    by.set(normQuestion(a.question), a);
  }
  return [...by.values()];
}
