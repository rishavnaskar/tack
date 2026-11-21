/**
 * What every worker knows about the user, and where each piece came from.
 *
 * A fact may go in a form when the user typed or answered it, or when it is
 * copied word for word from a document the owner gave (name, email, phone,
 * location, links). What a model read out of a document, or an agent saved,
 * is a proposal until the user confirms it. Saved answers serve every
 * wording of the same question; what Fanfold works out itself (total years
 * from dated jobs, where it found a job) is kept apart, with what it rests
 * on, and a value the user removes is not worked out again. Anything none of
 * these settles goes to the user rather than being guessed, and the
 * provenance on every answer is how they can check that held.
 */

import type { DatabaseSync } from 'node:sqlite';
import { classifyLocal, fieldAsked, intentKey, placeWords, SENSITIVE_FIELDS, type FieldAsked } from './intents.ts';
import { json } from './json.ts';
import { normaliseQuestion, overlap } from './wording.ts';
import { entryWords, readRights, readSponsorship, sponsorshipWords, defaultSponsorship, WorkRights, COPY as RIGHTS_COPY, type RightsState } from './work-rights.ts';

export { normaliseQuestion } from './wording.ts';

/** The fields a form asks for, in the order a person would list them. */
export const PROFILE_FIELDS = [
  'name', 'email', 'phone', 'location', 'alsoOpenTo', 'workAuthorisation', 'sponsorship',
  'noticePeriod', 'earliestStart', 'currentSalary', 'salaryExpectation', 'yearsExperience', 'linkedin', 'github', 'portfolio',
  'eeoPreference',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** What the user reads on screen. */
const COPY = {
  noticeIsStart: '{value} is when you can start, not your notice period. Put it under Earliest start, and enter your notice as a number and a unit, like 30 days.',
  notNotice: '{value} isn’t a notice period. Use a number and a unit, like 30 days or 2 months, or Immediate.',
  notEmail: '{value} isn’t an email address.',
  notLink: '{value} isn’t a link.',
  notLinkOf: '{value} isn’t a {site} address.',
  notPhone: '{value} isn’t a phone number. Use 7 to 15 digits, with a + and spaces, dashes or brackets if you like.',
  notYears: '{value} isn’t a number of years. Use a number from 0 to 60, like 4 or 4+.',
  notAmount: '{value} isn’t an amount. Include a number, like 18 LPA or 1,200,000.',
  inThePast: '{value} has already passed. Give the first day you could start, or Immediately.',
  tooLong: 'That’s too long. Keep it under {max} characters.',
  noticeClash: 'Your notice period is {notice}, but your earliest start says {start}. Check which one is right.',
  answerUnused: 'Saved, but it isn’t used as your {label}: {why}',
  answerNoUnit: 'say the unit too, like {answer} days.',
  fromAnswer: 'your answer to “{question}”',
  fromAgentAnswer: 'an agent’s answer to “{question}”, which you haven’t checked',
  fromAgent: 'an agent, not checked by you',
  authorisedIn: 'Authorised to work in {place}',
  authorised: 'Authorised to work',
  toConfirm: 'what you wrote before, waiting for you to pick a status',
};

/** The longest a fact may be: forms take a line, not an essay. */
const MAX_FACT = 300;

/** How a notice period's length is written: "30", "2-3", "one". */
const NOTICE_NUMBER = String.raw`(?:\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|sixty|ninety)`;
const NOTICE_UNIT = String.raw`(?:days?|d|weeks?|wks?|w|months?|mos?|mths?|m|years?|yrs?|y)\.?`;
/** What may follow a notice period: a remark after a comma, or a word about buying it out. */
const NOTICE_REMARK = String.raw`(?:\s*[,;(–—-].*|\s+(?:buy-?\s?out|bought|negotiable|flexible|can|but|and|with|plus|notice|period|serving)\b.*)?`;
/** A notice period as a number and a unit, or none at all. */
const NOTICE = new RegExp(String.raw`^(?:${NOTICE_NUMBER}\s*${NOTICE_UNIT}|immediate(?:ly)?|none|nil|0|no notice(?: period)?)${NOTICE_REMARK}$`, 'i');
/** Words that say when someone can start rather than how long their notice is. */
const STARTS = /\b(?:join|joining|start|starting|available|availability)\b/i;
/** Characters that turn text around or hide in it, which no form should be sent. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

/** Text the user gave, without the invisible characters that reverse or hide what it shows. */
export function plainText(value: string): string {
  return value.replace(BIDI, '');
}

/**
 * Years of experience as a number, from the way people write them: "4",
 * "4+", "about 4", "4.5 years". Null when there is no such number, or it is
 * outside 0 to 60. `loose` reads the number a longer value starts with ("8
 * total, 6 backend"), for a value saved before values were checked.
 */
export function yearsIn(value: string, loose = false): number | null {
  const m = /^(?:about|around|approx(?:imately)?\.?|roughly|nearly|almost|over|more than|at least|~|≈|>)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:\+|plus)?\s*(?:years?|yrs?\.?)?(?:\s+(?:of\s+)?(?:experience|exp|total|overall|professional|work))*\s*$/i.exec(value.trim())
    ?? (loose ? /^\s*(?:about|around|~)?\s*(\d{1,2}(?:\.\d+)?)(?![\d.]|e\d)/i.exec(value) : null);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 60 ? n : null;
}

/** A date written as one, read for checking it is not past; null when it is not a plain date. */
function dateOf(v: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  if (!/\b(?:19|20)\d{2}\b/.test(v) || !/\p{L}/u.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  // "March 2020" is all of March: it has passed only once the month is over.
  const d = new Date(at);
  return /\b\d{1,2}\b(?!\d)/.test(v.replace(/\b(?:19|20)\d{2}\b/, '')) ? d : new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * Why a value cannot be this fact, or null. Only checks that are certain,
 * because a worker types these into forms as stated: an email address has to
 * be one, a link has to be one, a phone number is digits, years and amounts
 * are numbers, and a start date has not passed.
 */
export function factProblem(field: string, value: string, now = new Date()): string | null {
  const v = plainText(value).trim();
  if (!v) return null;
  const said = (copy: string): string => copy.replace('{value}', `“${v.length > 60 ? `${v.slice(0, 57)}…` : v}”`);
  if (v.length > MAX_FACT) return COPY.tooLong.replace('{max}', String(MAX_FACT));
  if (field === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return said(COPY.notEmail);
  if ((field === 'linkedin' || field === 'github' || field === 'portfolio') && !/^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v)) return said(COPY.notLink);
  if (field === 'linkedin' && !/(^|[/.])linkedin\.com(\/|$)/i.test(v)) return said(COPY.notLinkOf).replace('{site}', 'LinkedIn');
  if (field === 'github' && !/(^|[/.])github\.com(\/|$)/i.test(v)) return said(COPY.notLinkOf).replace('{site}', 'GitHub');
  if (field === 'phone') {
    const digits = v.replace(/\D/g, '').length;
    if (!/^\(?\+?[\d\s()-]+$/.test(v) || digits < 7 || digits > 15) return said(COPY.notPhone);
  }
  if (field === 'yearsExperience' && yearsIn(v) === null) return said(COPY.notYears);
  if ((field === 'currentSalary' || field === 'salaryExpectation') && (!/\d/.test(v) || /^-/.test(v))) return said(COPY.notAmount);
  if (field === 'noticePeriod' && !NOTICE.test(v)) {
    return said(STARTS.test(v) ? COPY.noticeIsStart : COPY.notNotice);
  }
  if (field === 'earliestStart') {
    const day = dateOf(v);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (/\b(?:yesterday|ago|last (?:week|month|year))\b/i.test(v) || (day && day < today)) return said(COPY.inThePast);
  }
  // Where they may work is a country and a status, and sponsorship is said for a country: a sentence is taken only when it reads plainly as those.
  if (field === 'workAuthorisation') {
    const read = readRights(v);
    if (read.unread.length || (!read.entries.length && !read.elsewhere)) return said(RIGHTS_COPY.notRights);
  }
  if (field === 'sponsorship') {
    const read = readSponsorship(v);
    if (read.unread.length || (!read.bare && !read.countries.length && !read.elsewhere)) return said(RIGHTS_COPY.notSponsorship);
  }
  return null;
}

/** Every value of these that cannot be its fact, each with why. */
export function factProblems(fields: Record<string, unknown>, now = new Date()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    const problem = factProblem(field, String(value ?? ''), now);
    if (problem) out[field] = problem;
  }
  return out;
}

/** A notice period that says the user cannot start yet, beside an earliest start that says they can: worth a word, not a refusal. */
export function factClash(notice: string | undefined, start: string | undefined): string | null {
  if (!notice?.trim() || !start?.trim()) return null;
  const none = /^(?:immediate(?:ly)?|none|nil|0|no notice(?: period)?)\b/i.test(notice.trim());
  const now = /^(?:immediate(?:ly)?|now|asap|right away|straight away)\b/i.test(start.trim());
  return !none && now ? COPY.noticeClash.replace('{notice}', notice.trim()).replace('{start}', start.trim()) : null;
}
export type ProfileFields = Partial<Record<ProfileField, string>>;

/**
 * Where a fact came from, most trusted first: the user typed it; the user
 * answered a question that asks it; it is copied word for word from a
 * document the owner gave; an agent or a reading of a document proposed it.
 */
type FactSource = 'you' | 'answer' | 'document' | 'agent' | 'extract';

const RANK: Record<FactSource, number> = { you: 5, answer: 4, document: 3, agent: 1, extract: 1 };

interface FactBasis {
  documentId?: string;
  title?: string;
  answerId?: number;
  question?: string;
}

export interface ProfileFact {
  field: ProfileField;
  value: string;
  /** True once the user gave it: saved it on Profile, or answered a question that asks it. */
  confirmed: boolean;
  /** May go in a form: confirmed, or copied word for word from a document the owner gave. Workers read only these. */
  usable: boolean;
  source: FactSource;
  /** Where it came from, for a person to read; null when they typed it themselves. */
  from: string | null;
  basis: FactBasis;
  updatedAt: string;
}

export interface BankAnswer {
  id: number;
  question: string;
  /** How the question is known again: its normalised wording, and for a question about one job, that job. */
  questionNorm: string;
  answer: string;
  /** 'you' when typed by the user, 'review' when saved from an edited card, 'you, in <app>' when said in a host, 'agent' when an agent proposed it. */
  source: string;
  /** The job a question about one job was answered for; null when the answer holds for every job. */
  jobId: string | null;
  /** What the question asks, whatever its wording ("experience.skill_years:python"): every wording of it finds this answer. */
  intent: string | null;
  usedCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

/** What Fanfold worked out itself, such as where it found a job. Never the user's answer, and never shown as one. */
interface DerivedAnswer {
  id: number;
  question: string;
  questionNorm: string;
  jobId: string | null;
  answer: string;
  basis: Record<string, unknown>;
  createdAt: string;
}

/** The user gave this answer, in Fanfold or in a host's conversation. An agent's answer is a proposal. */
export function isUserSource(source: string): boolean {
  return source === 'you' || source === 'review' || source.startsWith('you, in ');
}

/** A saved answer, with what saving it said: why it could not set the fact it names, and the older answers it replaced. */
export type SavedAnswer = BankAnswer & { note?: string; replaced?: string[] };

/** Facts kept as choices, one entry per country, rather than as a line of text (work-rights.ts). */
export const RIGHTS_FIELDS: ReadonlySet<ProfileField> = new Set(['workAuthorisation', 'sponsorship']);

/** Facts that have one value for every job, so a newer answer to the same question in other words replaces the older one. */
const SINGLE: ReadonlySet<ProfileField> = new Set(['noticePeriod', 'earliestStart', 'currentSalary', 'salaryExpectation', 'yearsExperience']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_facts (
  field       TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  source      TEXT,
  basis       TEXT
);
CREATE TABLE IF NOT EXISTS answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question      TEXT NOT NULL,
  question_norm TEXT NOT NULL UNIQUE,
  answer        TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'you',
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL,
  job_id        TEXT,
  updated_at    TEXT,
  intent_key    TEXT
);
CREATE TABLE IF NOT EXISTS derived_answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question      TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  job_id        TEXT NOT NULL DEFAULT '',
  answer        TEXT NOT NULL,
  basis         TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  rejected      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (question_norm, job_id)
);
`;

/** How alike two wordings must be for a saved answer to be offered as a draft. */
const NEAR = 0.6;
/** How much later than a fact the user's answer must be to count as their later word on it. */
const LATER_MS = 60_000;
/** The settings key that says the one-time pass of the user's answers over the facts they answer has run. */
const REPAIR_NEWER = 'profile.repair.newerAnswers';
/** The settings key that holds which document is the résumé. */
const RESUME_SETTING = 'profile.resumeDocumentId';
/** The settings key that says the one-time move of work authorisation and sponsorship sentences into entries has run. */
const REPAIR_RIGHTS = 'profile.repair.workRights';

export class Profile {
  #db: DatabaseSync;
  readonly #listeners = new Set<() => void>();
  /** The facts the one-time pass of the user's answers changed on this start, for the caller to log. Empty on every later start. */
  readonly repaired: ProfileField[] = [];
  /** Where the user may work and whether they need sponsorship: one entry per country, picked from fixed lists. */
  readonly rights: WorkRights;

  constructor(db: DatabaseSync) {
    this.#db = db;
    const had = this.#columns('profile_facts');
    this.#db.exec(SCHEMA);
    const facts = this.#columns('profile_facts');
    for (const name of ['source', 'basis']) if (!facts.has(name)) this.#db.exec(`ALTER TABLE profile_facts ADD COLUMN ${name} TEXT`);
    const answers = this.#columns('answers');
    for (const name of ['job_id', 'updated_at', 'intent_key']) if (!answers.has(name)) this.#db.exec(`ALTER TABLE answers ADD COLUMN ${name} TEXT`);
    this.#db.exec('CREATE INDEX IF NOT EXISTS answers_intent ON answers(intent_key)');
    if (!this.#columns('derived_answers').has('rejected')) this.#db.exec('ALTER TABLE derived_answers ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0');
    this.#db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.rights = new WorkRights(db, () => this.#changed());
    if (!this.#db.prepare('SELECT 1 FROM settings WHERE key = ?').get(REPAIR_RIGHTS)) {
      this.#moveRights();
      this.#db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
        .run(REPAIR_RIGHTS, JSON.stringify({ at: new Date().toISOString(), moved: this.rights.migrated }));
    }
    if (had.size && !had.has('source')) this.#firstSourcedStart();
    if (!this.#db.prepare('SELECT 1 FROM settings WHERE key = ?').get(REPAIR_NEWER)) {
      this.repaired.push(...this.#newerAnswers());
      this.#db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
        .run(REPAIR_NEWER, JSON.stringify({ at: new Date().toISOString(), changed: this.repaired }));
    }
  }

  /**
   * Once: work authorisation and sponsorship written as sentences, from
   * before they were choices, become entries where they read plainly and
   * stay, to confirm, where they do not. The sentences leave the facts table.
   */
  #moveRights(): void {
    const rows = this.#db.prepare("SELECT field, value, confirmed, source, basis FROM profile_facts WHERE field IN ('workAuthorisation', 'sponsorship')").all() as Array<Record<string, unknown>>;
    if (!rows.length) return;
    const old: Parameters<WorkRights['migrate']>[0] = {};
    for (const r of rows) {
      const f = toFact(String(r.field) as ProfileField, r);
      old[f.field as 'workAuthorisation' | 'sponsorship'] = { value: f.value, confirmed: f.confirmed, source: f.source, ...(f.basis.documentId ? { documentId: f.basis.documentId } : {}) };
    }
    this.rights.migrate(old);
    this.#db.prepare("DELETE FROM profile_facts WHERE field IN ('workAuthorisation', 'sponsorship')").run();
  }

  /** The document that is the user's résumé; null when none is, `undefined` when none was ever chosen (a profile from before this was kept). */
  resumeId(): string | null | undefined {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(RESUME_SETTING) as { value: string } | undefined;
    if (!row) return undefined;
    try { return (JSON.parse(row.value) as string | null) ?? null; } catch { return null; }
  }

  /** One résumé at a time: this one is it, or none is. */
  setResume(documentId: string | null): void {
    this.#db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(RESUME_SETTING, JSON.stringify(documentId));
  }

  /** Be told when a fact or a saved answer changes, so questions waiting can be answered again. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* a listener's failure is its own */ }
    }
  }

  #columns(table: string): Set<string> {
    return new Set((this.#db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name));
  }

  /**
   * Once, on the first start that records where facts came from: a start
   * phrase kept as the notice period moves to the earliest start, and every
   * saved answer fills the fact it answers, as later answers will.
   */
  #firstSourcedStart(): void {
    const notice = this.fact('noticePeriod');
    if (notice && !NOTICE.test(notice.value) && STARTS.test(notice.value) && !this.fact('earliestStart')) {
      this.#db.prepare("UPDATE profile_facts SET field = 'earliestStart' WHERE field = 'noticePeriod'").run();
    }
    const old = (this.#db.prepare('SELECT * FROM answers WHERE job_id IS NULL ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(toAnswer);
    for (const a of old) this.#factFromAnswer(a);
  }

  /**
   * Once: every answer the user gave goes over the fact it answers again,
   * oldest first, so an answer later than what they typed on Profile
   * replaces it. A field they left blank stays blank. The fields whose fact changed.
   */
  #newerAnswers(): ProfileField[] {
    const said = (f: ProfileFact): string => JSON.stringify([f.value, f.confirmed, f.source, f.basis]);
    const before = new Map(this.facts().map((f) => [f.field, said(f)]));
    const answers = (this.#db.prepare('SELECT * FROM answers WHERE job_id IS NULL ORDER BY COALESCE(updated_at, created_at), id').all() as Array<Record<string, unknown>>).map(toAnswer);
    const held = new Set(before.keys());
    for (const a of answers) if (isUserSource(a.source)) this.#factFromAnswer(a, held);
    return this.facts().filter((f) => before.get(f.field) !== said(f)).map((f) => f.field);
  }

  // ----------------------------------------------------------------- facts

  facts(): ProfileFact[] {
    const rows = this.#db.prepare('SELECT * FROM profile_facts').all() as Array<Record<string, unknown>>;
    const byField = new Map<string, ProfileFact>(rows.filter((r) => !RIGHTS_FIELDS.has(String(r.field) as ProfileField)).map((r) => [String(r.field), toFact(String(r.field) as ProfileField, r)]));
    for (const f of rightsFacts(this.rights.state())) byField.set(f.field, f);
    return PROFILE_FIELDS.filter((f) => byField.has(f)).map((f) => byField.get(f)!);
  }

  fact(field: ProfileField): ProfileFact | null {
    return this.facts().find((f) => f.field === field) ?? null;
  }

  /**
   * Write facts. The user saving them confirms; anything else proposes, or
   * for a value copied from the owner's own document, makes it usable. A
   * fact is never replaced by one from a less trusted source, except by the
   * user's own later word (`later`).
   */
  set(fields: ProfileFields, opts: { confirmed: boolean; source?: FactSource; basis?: FactBasis; at?: string; later?: boolean }): void {
    const source: FactSource = opts.source ?? (opts.confirmed ? 'you' : 'agent');
    const rank = RANK[source];
    const now = opts.at ?? new Date().toISOString();
    const upsert = this.#db.prepare(`
      INSERT INTO profile_facts (field, value, confirmed, updated_at, source, basis) VALUES (?,?,?,?,?,?)
      ON CONFLICT(field) DO UPDATE SET value = excluded.value, confirmed = excluded.confirmed, updated_at = excluded.updated_at,
        source = excluded.source, basis = excluded.basis
    `);
    const del = this.#db.prepare('DELETE FROM profile_facts WHERE field = ?');
    const row = this.#db.prepare('SELECT value, confirmed, source, basis FROM profile_facts WHERE field = ?');
    let changed = false;
    for (const [field, value] of Object.entries(fields)) {
      if (!(PROFILE_FIELDS as readonly string[]).includes(field)) continue;
      // Kept as entries: a sentence is read into them, the user's as theirs, anyone else's to confirm.
      if (RIGHTS_FIELDS.has(field as ProfileField)) {
        const v = plainText(value ?? '').trim();
        if (!v) { if (rank >= RANK.answer) this.rights.clear(field as 'workAuthorisation' | 'sponsorship'); continue; }
        this.rights.fromText(field as 'workAuthorisation' | 'sponsorship', v, { confirmed: rank >= RANK.answer, source: rank >= RANK.answer ? 'you' : source, ...(opts.basis?.documentId ? { documentId: opts.basis.documentId } : {}) });
        continue;
      }
      const before = this.fact(field as ProfileField);
      if (before && RANK[before.source] > rank && !opts.later) continue;
      const v = plainText(value ?? '').trim();
      if (!v) { changed = Number(del.run(field).changes) > 0 || changed; continue; }
      const basis = opts.basis ? JSON.stringify(opts.basis) : null;
      const confirmed = rank >= RANK.answer ? 1 : 0;
      // The same value from the same place again is not a change: reading a document twice leaves its facts as they were.
      const had = row.get(field) as { value: string; confirmed: number; source: string | null; basis: string | null } | undefined;
      if (had && had.value === v.slice(0, MAX_FACT) && Number(had.confirmed) === confirmed && (had.source ?? '') === source && (had.basis ?? null) === basis) continue;
      upsert.run(field, v.slice(0, MAX_FACT), confirmed, now, source, basis);
      changed = true;
    }
    if (changed) this.#changed();
  }

  /**
   * A document is gone. A fact copied from it that another of the user's
   * documents states word for word is credited to that one and stays usable;
   * the rest is only a proposal now. `statedIn` finds such a document.
   */
  forgetDocument(documentId: string, statedIn?: (field: ProfileField, value: string) => { documentId: string; title: string } | null): void {
    const move = this.#db.prepare('UPDATE profile_facts SET basis = ? WHERE field = ?');
    for (const f of this.facts()) {
      if (f.source !== 'document' || f.basis.documentId !== documentId) continue;
      const other = statedIn?.(f.field, f.value);
      if (other) move.run(JSON.stringify({ documentId: other.documentId, title: other.title }), f.field);
    }
    this.#db.prepare("UPDATE profile_facts SET source = 'extract' WHERE source = 'document' AND json_extract(basis, '$.documentId') = ?").run(documentId);
    // The user's own refusals stay: the same answer is not worked out again if the document comes back.
    this.#db.prepare("DELETE FROM derived_answers WHERE rejected = 0 AND (json_extract(basis, '$.documentId') = ? OR json_extract(basis, '$.documentIds') LIKE ?)")
      .run(documentId, `%${JSON.stringify(documentId)}%`);
    this.#changed();
  }

  /** What was read from a document that turned out to be somebody else's: none of it is the user's. */
  dropDocumentFacts(documentId: string): number {
    const n = Number(this.#db.prepare("DELETE FROM profile_facts WHERE source IN ('document', 'extract') AND json_extract(basis, '$.documentId') = ?").run(documentId).changes)
      + this.rights.dropFrom(documentId, true);
    this.#db.prepare("DELETE FROM derived_answers WHERE rejected = 0 AND (json_extract(basis, '$.documentId') = ? OR json_extract(basis, '$.documentIds') LIKE ?)")
      .run(documentId, `%${JSON.stringify(documentId)}%`);
    if (n) this.#changed();
    return n;
  }

  /** Proposals read from documents the owner has not said are theirs: such a document proposes nothing. */
  dropProposalsFrom(documentIds: string[]): number {
    let n = 0;
    const del = this.#db.prepare("DELETE FROM profile_facts WHERE source = 'extract' AND json_extract(basis, '$.documentId') = ?");
    for (const id of documentIds) n += Number(del.run(id).changes) + this.rights.dropFrom(id, true);
    if (n) this.#changed();
    return n;
  }

  /**
   * How complete the profile is, counted as the Profile page counts it:
   * facts forms may use, over the fields it shows. The EEO choice is how to
   * answer, not a fact, so it is in neither.
   */
  completeness(): { filled: number; total: number } {
    const shown = PROFILE_FIELDS.filter((f) => f !== 'eeoPreference');
    return { filled: this.facts().filter((f) => f.usable && f.field !== 'eeoPreference').length, total: shown.length };
  }

  /**
   * The facts a worker may assert, rendered for the prompt: confirmed, or
   * copied from the owner's own document. A proposal is shown to the user to
   * confirm, never to a form, and so is an answer an agent saved.
   */
  renderForPrompt(): string {
    // A sensitive fact reaches a model only once the user confirmed it: a document's or an agent's word for it is not theirs (D4).
    const facts = this.facts().filter((f) => f.usable && (f.confirmed || !SENSITIVE_FIELDS.has(f.field)));
    const answers = this.userAnswersBesideFacts(40);
    if (!facts.length && !answers.length) return '';
    const lines: string[] = [];
    if (facts.length) {
      lines.push('Facts you may state as true about the user (nothing else is):');
      for (const f of facts) lines.push(`- ${LABELS[f.field]}: ${f.value}${f.source === 'document' && f.from ? ` (from ${f.from})` : ''}`);
    }
    if (answers.length) {
      lines.push('Screening questions the user has already answered. Reuse the answer verbatim when the question matches:');
      for (const a of answers) lines.push(`- Q: ${a.question} → A: ${a.answer}`);
    }
    return lines.join('\n');
  }

  /** What the user's answers say for fields still blank: a suggestion each, with where it came from. */
  suggestions(): Partial<Record<ProfileField, { value: string; from: string }>> {
    const have = new Set(this.facts().map((f) => f.field));
    const places = placeWords(this.fact('location')?.value);
    const out: Partial<Record<ProfileField, { value: string; from: string }>> = {};
    const answers = this.answers(500).filter((a) => !a.jobId)
      .sort((a, b) => Number(isUserSource(b.source)) - Number(isUserSource(a.source)) || b.updatedAt.localeCompare(a.updatedAt));
    for (const a of answers) {
      const asked = fieldAsked(a.question, places);
      // Where they may work is picked from choices, never suggested from an answer to one form.
      if (!asked || asked.draft || have.has(asked.field) || out[asked.field] || RIGHTS_FIELDS.has(asked.field)) continue;
      const value = valueFromAnswer(asked, a.question, a.answer);
      if (!value || factProblem(asked.field, value)) continue;
      out[asked.field] = { value, from: (isUserSource(a.source) ? COPY.fromAnswer : COPY.fromAgentAnswer).replace('{question}', a.question) };
    }
    return out;
  }

  /**
   * A saved answer to a question that asks for a profile field fills that
   * field: confirmed when the user gave it, proposed when an agent did, and
   * dated when it was said. The user's answer more than a minute later than
   * what they typed on Profile replaces it; an earlier one, or an agent's,
   * never does, and an earlier answer does not replace a later one.
   */
  #factFromAnswer(a: BankAnswer, only?: ReadonlySet<ProfileField>): void {
    if (a.jobId) return;
    const asked = fieldAsked(a.question, placeWords(this.fact('location')?.value));
    if (!asked || asked.draft || (only && !only.has(asked.field))) return;
    if (RIGHTS_FIELDS.has(asked.field)) return this.#rightsFromAnswer(a, asked);
    const value = valueFromAnswer(asked, a.question, a.answer);
    if (!value || factProblem(asked.field, value)) return;
    const user = isUserSource(a.source);
    const before = this.fact(asked.field);
    const after = before ? Date.parse(a.updatedAt) - Date.parse(before.updatedAt) : 0;
    if (user && before?.source === 'answer' && after < 0) return;
    this.set({ [asked.field]: value }, {
      confirmed: user, source: user ? 'answer' : 'agent', basis: { answerId: a.id, question: a.question }, at: a.updatedAt, later: user && after > LATER_MS,
    });
  }

  /**
   * An answer that says where the user may work, or whether they need
   * sponsorship, for every country it names ("India: Citizen", "Anywhere
   * else: I would need sponsorship"): read into the entries, theirs when they
   * said it. A yes or no to a question about one country, or for no country,
   * stays an answer to that question and changes no entry.
   */
  #rightsFromAnswer(a: BankAnswer, asked: FieldAsked): void {
    if (asked.places.length) return;
    const field = asked.field as 'workAuthorisation' | 'sponsorship';
    if (field === 'workAuthorisation') {
      const read = readRights(a.answer);
      if (read.unread.length || (!read.entries.length && !read.elsewhere)) return;
    } else {
      const read = readSponsorship(a.answer);
      if (read.unread.length || read.bare || (!read.countries.length && !read.elsewhere)) return;
    }
    const user = isUserSource(a.source);
    this.rights.fromText(field, a.answer, { confirmed: user, source: user ? (a.source === 'review' ? 'you' : a.source) : 'agent' });
  }

  // --------------------------------------------------------------- answers

  /**
   * Save an answer. `key` is how the question is known again when that is
   * more than its wording: a question about one job carries that job, in
   * `jobId` too, and is never reused for another.
   */
  addAnswer(question: string, answer: string, source = 'you', opts: { key?: string; jobId?: string | null; intentKey?: string | null } = {}): SavedAnswer {
    const q = plainText(question).trim();
    const a = plainText(answer).trim();
    if (!q || !a) throw new Error('an answer needs both a question and an answer');
    const key = opts.key ?? normaliseQuestion(q);
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO answers (question, question_norm, answer, source, created_at, updated_at, job_id, intent_key) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(question_norm) DO UPDATE SET answer = excluded.answer, source = excluded.source, question = excluded.question,
        updated_at = excluded.updated_at, job_id = excluded.job_id, intent_key = COALESCE(excluded.intent_key, intent_key)
    `).run(q, key, a, source, now, now, opts.jobId ?? null, opts.intentKey ?? null);
    const saved = this.answerByKey(key)!;
    this.#factFromAnswer(saved);
    const out: SavedAnswer = { ...saved };
    const asked = saved.jobId ? null : fieldAsked(saved.question, placeWords(this.fact('location')?.value));
    if (asked && !asked.draft && !RIGHTS_FIELDS.has(asked.field)) {
      // An answer that names a fact and cannot be it is said, never kept quietly beside the fact it failed to change.
      const value = valueFromAnswer(asked, saved.question, saved.answer);
      const problem = value ? factProblem(asked.field, value)
        : asked.field === 'noticePeriod' && /^\d+(\.\d+)?$/.test(saved.answer) ? COPY.answerNoUnit.replace('{answer}', saved.answer) : null;
      if (problem) out.note = COPY.answerUnused.replace('{label}', LABELS[asked.field].toLowerCase()).replace('{why}', problem);
      // The user's newer answer to what an older one answered in other words replaces it, as the same words would.
      if (!problem && isUserSource(source) && SINGLE.has(asked.field) && this.fact(asked.field)?.basis.answerId === saved.id) {
        const replaced = this.#answersFor(asked.field).filter((x) => x.id !== saved.id);
        const del = this.#db.prepare('DELETE FROM answers WHERE id = ?');
        for (const x of replaced) del.run(x.id);
        if (replaced.length) out.replaced = replaced.map((x) => x.question);
      }
    }
    this.#changed();
    return out;
  }

  /** The saved answers, for every job, whose question asks for this fact. */
  #answersFor(field: ProfileField): BankAnswer[] {
    const places = placeWords(this.fact('location')?.value);
    return (this.#db.prepare('SELECT * FROM answers WHERE job_id IS NULL ORDER BY COALESCE(updated_at, created_at), id').all() as Array<Record<string, unknown>>)
      .map(toAnswer).filter((a) => {
        const asked = fieldAsked(a.question, places);
        return !!asked && !asked.draft && asked.field === field;
      });
  }

  /** The user's own answer to what this intent asks, under any wording; the newest when there are several. */
  answerByIntent(intentKey: string): BankAnswer | null {
    const rows = (this.#db.prepare('SELECT * FROM answers WHERE intent_key = ? ORDER BY updated_at DESC, id DESC').all(intentKey) as Array<Record<string, unknown>>).map(toAnswer);
    return rows.find((a) => isUserSource(a.source)) ?? null;
  }

  /** The user's own answers filed under intent keys starting so, newest first: "referral.know_anyone:" gives one per company. */
  userAnswersUnder(prefix: string): BankAnswer[] {
    return (this.#db.prepare("SELECT * FROM answers WHERE intent_key LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id DESC")
      .all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as Array<Record<string, unknown>>).map(toAnswer).filter((a) => isUserSource(a.source));
  }

  /** What a saved answer's question asks, found out after it was saved. */
  setAnswerIntent(id: number, intentKey: string | null): void {
    this.#db.prepare('UPDATE answers SET intent_key = ? WHERE id = ?').run(intentKey, id);
  }

  /** Saved answers whose question has not been classified yet. */
  answersWithoutIntent(limit = 200): BankAnswer[] {
    return (this.#db.prepare('SELECT * FROM answers WHERE intent_key IS NULL ORDER BY id LIMIT ?').all(limit) as Array<Record<string, unknown>>).map(toAnswer);
  }

  /** Exact match on the normalised question. Near matches are drafts, never answers. */
  matchAnswer(question: string): BankAnswer | null {
    return this.answerByKey(normaliseQuestion(question));
  }

  /** The answer saved under this key, whoever gave it. */
  answerByKey(key: string): BankAnswer | null {
    const row = this.#db.prepare('SELECT * FROM answers WHERE question_norm = ?').get(key) as Record<string, unknown> | undefined;
    return row ? toAnswer(row) : null;
  }

  /** The user's own answer under this key; an agent's is not theirs. */
  userAnswer(key: string): BankAnswer | null {
    const a = this.answerByKey(key);
    return a && isUserSource(a.source) ? a : null;
  }

  /** The user's answer to the most alike question, when one is alike enough to suggest. */
  nearAnswer(key: string): { answer: BankAnswer; score: number } | null {
    let best: { answer: BankAnswer; score: number } | null = null;
    for (const a of this.userAnswers(500)) {
      if (a.questionNorm === key) continue;
      const score = overlap(key, a.questionNorm);
      if (score >= NEAR && (!best || score > best.score)) best = { answer: a, score };
    }
    return best;
  }

  useAnswer(id: number): void {
    this.#db.prepare('UPDATE answers SET used_count = used_count + 1, last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /**
   * Delete a saved answer, and the fact it set with it: another saved answer
   * to the same question fills that fact again, or it is left blank. The
   * fields that changed.
   */
  deleteAnswer(id: number): ProfileField[] {
    this.#db.prepare('DELETE FROM answers WHERE id = ?').run(id);
    const cleared: ProfileField[] = [];
    const del = this.#db.prepare('DELETE FROM profile_facts WHERE field = ?');
    for (const f of this.facts()) {
      if ((f.source === 'answer' || f.source === 'agent') && f.basis.answerId === id) {
        del.run(f.field);
        cleared.push(f.field);
      }
    }
    // Oldest first, so the newest of the rest has the last word.
    for (const field of cleared) for (const a of this.#answersFor(field)) this.#factFromAnswer(a);
    this.#changed();
    return cleared;
  }

  /** Every saved answer, including ones about a single job and ones an agent proposed. */
  answers(limit = 200): BankAnswer[] {
    return (this.#db.prepare('SELECT * FROM answers ORDER BY used_count DESC, created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>).map(toAnswer);
  }

  /** The user's own answers that hold for every job: what a worker or a host may reuse. */
  userAnswers(limit = 200): BankAnswer[] {
    return (this.#db.prepare('SELECT * FROM answers WHERE job_id IS NULL ORDER BY used_count DESC, created_at DESC')
      .all() as Array<Record<string, unknown>>).map(toAnswer).filter((a) => isUserSource(a.source)).slice(0, limit);
  }

  /**
   * The user's answers as an agent should read them beside the facts: one
   * that asks for a fact the profile holds is left out, since the fact is
   * their latest word on it, and an older answer would contradict it.
   */
  userAnswersBesideFacts(limit = 200): BankAnswer[] {
    const places = placeWords(this.fact('location')?.value);
    const held = new Set(this.facts().filter((f) => f.usable).map((f) => f.field));
    return this.userAnswers(500).filter((a) => {
      const asked = fieldAsked(a.question, places);
      return !asked || !!asked.draft || !held.has(asked.field);
    }).slice(0, limit);
  }

  // ------------------------------------------------------- derived answers

  /** Keep what Fanfold worked out, so a record that reports it can be checked. The same answer the user took back stays taken back. */
  derive(d: { question: string; jobId: string | null; answer: string; basis: Record<string, unknown> }): void {
    this.#db.prepare(`
      INSERT INTO derived_answers (question, question_norm, job_id, answer, basis, created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(question_norm, job_id) DO UPDATE SET question = excluded.question, answer = excluded.answer,
        basis = excluded.basis, created_at = excluded.created_at, rejected = 0
      WHERE derived_answers.rejected = 0 OR lower(trim(derived_answers.answer)) != lower(trim(excluded.answer))
    `).run(d.question, normaliseQuestion(d.question), d.jobId ?? '', d.answer, JSON.stringify(d.basis), new Date().toISOString());
  }

  /** What Fanfold worked out for this question, for this job or for any, and still stands by. */
  derivedAnswer(question: string, jobId: string | null): DerivedAnswer | null {
    const row = this.#db.prepare(
      "SELECT * FROM derived_answers WHERE question_norm = ? AND job_id IN (?, '') AND rejected = 0 ORDER BY job_id = '' LIMIT 1",
    ).get(normaliseQuestion(question), jobId ?? '') as Record<string, unknown> | undefined;
    return row ? toDerived(row) : null;
  }

  /** Whether the user took back this very answer to this question, for this job or for every job. */
  derivedRejected(question: string, jobId: string | null, answer: string): boolean {
    return !!this.#db.prepare(
      "SELECT 1 FROM derived_answers WHERE question_norm = ? AND job_id IN (?, '') AND rejected = 1 AND lower(trim(answer)) = lower(trim(?)) LIMIT 1",
    ).get(normaliseQuestion(question), jobId ?? '', answer);
  }

  /**
   * A worked-out answer taken back. When its basis no longer holds it goes;
   * when the user removes it, the row stays as their refusal, so the same
   * answer is not worked out again for that question. False when there was none.
   */
  forgetDerived(id: number, by: 'basis' | 'user' = 'basis'): boolean {
    if (by === 'user') {
      // The refusal is of what the question asks, so every wording of it waits for the user: kept by its intent key.
      const row = this.#db.prepare('SELECT question, basis FROM derived_answers WHERE id = ?').get(id) as { question: string; basis: string } | undefined;
      const basis = row ? JSON.parse(row.basis || '{}') as Record<string, unknown> : null;
      if (row && basis && typeof basis.intentKey !== 'string') {
        const c = classifyLocal(row.question, 'text', null, { places: placeWords(this.fact('location')?.value) });
        const key = c ? intentKey(c, null) : null;
        if (key) this.#db.prepare('UPDATE derived_answers SET basis = ? WHERE id = ?').run(JSON.stringify({ ...basis, intentKey: key }), id);
      }
    }
    const changes = by === 'user'
      ? this.#db.prepare('UPDATE derived_answers SET rejected = 1 WHERE id = ? AND rejected = 0').run(id).changes
      : this.#db.prepare('DELETE FROM derived_answers WHERE id = ? AND rejected = 0').run(id).changes;
    if (by === 'user' && Number(changes) > 0) this.#changed();
    return Number(changes) > 0;
  }

  /** Whether the user removed an answer Fanfold worked out for what this intent key asks, under any wording. */
  intentRejected(key: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM derived_answers WHERE rejected = 1 AND json_extract(basis, '$.intentKey') = ? LIMIT 1").get(key);
  }

  /** What Fanfold worked out and still stands by, newest first. One the user removed takes every other wording of the same question with it. */
  derivedAnswers(limit = 200): DerivedAnswer[] {
    const rows = (this.#db.prepare('SELECT * FROM derived_answers WHERE rejected = 0 ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map(toDerived);
    const refused = new Set((this.#db.prepare("SELECT json_extract(basis, '$.intentKey') AS k FROM derived_answers WHERE rejected = 1").all() as Array<{ k: unknown }>)
      .map((r) => r.k).filter((k): k is string => typeof k === 'string' && !!k));
    if (!refused.size) return rows;
    const places = placeWords(this.fact('location')?.value);
    const keyOf = (d: DerivedAnswer): string | null => {
      if (typeof d.basis.intentKey === 'string') return d.basis.intentKey;
      const c = classifyLocal(d.question, 'text', null, { places });
      return c ? intentKey(c, null) : null;
    };
    return rows.filter((d) => {
      const key = keyOf(d);
      return !key || !refused.has(key);
    });
  }

}

export const LABELS: Record<ProfileField, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  location: 'Current location',
  alsoOpenTo: 'Also open to',
  workAuthorisation: 'Work authorisation',
  sponsorship: 'Sponsorship needed now or later',
  noticePeriod: 'Notice period',
  earliestStart: 'Earliest start',
  currentSalary: 'Current salary',
  salaryExpectation: 'Salary expectation (base)',
  yearsExperience: 'Years of experience',
  linkedin: 'LinkedIn',
  github: 'GitHub',
  portfolio: 'Portfolio URL',
  eeoPreference: 'Voluntary EEO questions',
};

function toAnswer(r: Record<string, unknown>): BankAnswer {
  return {
    id: Number(r.id), question: String(r.question), questionNorm: String(r.question_norm),
    answer: String(r.answer), source: String(r.source), jobId: (r.job_id as string) || null, intent: (r.intent_key as string) || null, usedCount: Number(r.used_count),
    lastUsedAt: (r.last_used_at as string) ?? null, updatedAt: String(r.updated_at ?? r.created_at),
  };
}

function toFact(field: ProfileField, r: Record<string, unknown>): ProfileFact {
  const confirmed = Number(r.confirmed) === 1;
  const source = (r.source as FactSource | null) ?? (confirmed ? 'you' : 'extract');
  const basis = json<FactBasis>(r.basis, {});
  const from = source === 'you' ? null
    : source === 'answer' ? COPY.fromAnswer.replace('{question}', basis.question ?? '')
    : source === 'agent' ? (basis.question ? COPY.fromAgentAnswer.replace('{question}', basis.question) : COPY.fromAgent)
    : basis.title ?? null;
  return {
    field, value: String(r.value), confirmed, usable: RANK[source] >= RANK.document,
    source, from, basis, updatedAt: String(r.updated_at),
  };
}

/**
 * Work authorisation and sponsorship as facts, read from the entries, for
 * whatever lists facts (the prompt, setup, the counts): usable once the user
 * set at least one entry; to confirm while only proposals or old sentences
 * wait. Answering reads the entries themselves (work-rights.ts).
 */
function rightsFacts(state: RightsState): ProfileFact[] {
  const place = (c: string): string => (c === 'European Union' ? RIGHTS_COPY.freeMovementArea : c || '?');
  const latest = (list: Array<{ updatedAt: string }>): string => list.map((e) => e.updatedAt).sort().at(-1) ?? new Date(0).toISOString();
  const mine = state.entries.filter((e) => e.confirmed && e.country);
  const waiting = state.entries.filter((e) => !e.confirmed);
  const fact = (field: ProfileField, value: string, confirmed: boolean, updatedAt: string, source: FactSource = 'you'): ProfileFact => ({
    field, value: value.slice(0, MAX_FACT), confirmed, usable: confirmed, source, from: confirmed ? null : COPY.toConfirm, basis: {}, updatedAt,
  });
  const out: ProfileFact[] = [];
  if (mine.length) {
    out.push(fact('workAuthorisation', mine.map((e) => `${place(e.country)}: ${entryWords(e)}`).join('; '), true, latest(mine)));
    const s = mine.map((e) => {
      const v = e.sponsorship ?? defaultSponsorship(e.status);
      return `${place(e.country)}: ${v ? sponsorshipWords(v, e.status) : RIGHTS_COPY.notSaid}`;
    });
    if (state.elsewhere) s.push(RIGHTS_COPY.elsewhere[state.elsewhere.value]);
    out.push(fact('sponsorship', s.join('; '), true, latest([...mine, ...(state.elsewhere ? [state.elsewhere] : [])])));
  } else {
    if (waiting.length) out.push(fact('workAuthorisation', [...new Set(waiting.map((e) => e.was ?? `${place(e.country)}: ${entryWords(e)}`))].join('; '), false, latest(waiting), waiting.some((e) => e.source === 'agent') ? 'agent' : 'extract'));
    if (state.earlierSponsorship) out.push(fact('sponsorship', state.earlierSponsorship, false, latest(waiting), 'extract'));
  }
  return out;
}

function toDerived(r: Record<string, unknown>): DerivedAnswer {
  return {
    id: Number(r.id), question: String(r.question), questionNorm: String(r.question_norm), jobId: (r.job_id as string) || null,
    answer: String(r.answer), basis: json<Record<string, unknown>>(r.basis, {}), createdAt: String(r.created_at),
  };
}

/**
 * The fact an answer gives, as the profile keeps it: "30" to "Notice period
 * (in days)" is "30 days", and "Yes" to "Are you authorised to work in
 * India?" is "Authorised to work in India". Null when it gives none.
 */
export function valueFromAnswer(asked: FieldAsked, question: string, answer: string): string | null {
  const a = answer.trim();
  if (!a) return null;
  if (asked.field === 'workAuthorisation' && /^(yes|no)\.?$/i.test(a)) {
    if (/^no/i.test(a)) return null;
    const place = asked.places.map((w) => new RegExp(`\\b${w}\\b`, 'i').exec(question)?.[0] ?? w).join(' ');
    return place ? COPY.authorisedIn.replace('{place}', place) : COPY.authorised;
  }
  if (asked.field === 'noticePeriod' && /^\d+(\.\d+)?$/.test(a)) {
    const unit = /\b(day|week|month)s?\b/i.exec(question)?.[1]?.toLowerCase();
    return unit ? `${a} ${unit}${a === '1' ? '' : 's'}` : null;
  }
  if (asked.field === 'yearsExperience' && yearsIn(a) === null) return null;
  return a.slice(0, MAX_FACT);
}
