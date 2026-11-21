/**
 * Questions an application asked that only the user can answer.
 *
 * Each is asked once, however many forms and sessions ask it. The answer goes
 * to the answer bank, where every later form finds it; a question the user
 * chose not to answer stays that way, and is not put to them again, until
 * they answer it themselves in Fanfold's window.
 */
import type { DatabaseSync } from 'node:sqlite';
import { LABELS, RIGHTS_FIELDS, type BankAnswer, type Profile, type ProfileFact, type ProfileField } from './profile.ts';
import { fieldAsked, placeWords, SENSITIVE_FIELDS, type FieldAsked } from './intents.ts';
import { questionKey, type JobAsking, type Scope } from './scope.ts';
import { atsIdentity, Jobs, postingKey } from './jobs.ts';
import { json } from './json.ts';
import { clean, normaliseQuestion } from './wording.ts';

export { clean };

export const QUESTION_KINDS = ['text', 'number', 'yes_no', 'choice'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
/** `closed`: every job that asked it has gone (sent, skipped), so nothing waits on it; asked again, it opens again. */
type QuestionStatus = 'open' | 'answered' | 'declined' | 'closed';

/** The job that asked. Any part may be unknown. */
export type Asker = JobAsking;

export interface Question {
  id: number;
  /** As it was first asked. */
  question: string;
  /** How it is known again: its wording, and the job for one about a single job. */
  norm: string;
  /** Whether its answer holds for every job, or only the one that asked. */
  scope: Scope;
  /** The job a question about one job belongs to. */
  jobId: string | null;
  /** What Fanfold suggests for the user to check, and why; null when it has nothing to go on. */
  draft: string | null;
  draftWhy: string | null;
  /** What it asks, whatever its wording, when that is known exactly ("experience.skill_years:python"). */
  intent: string | null;
  /** How it was settled without the user typing an answer to it: Fanfold worked it out, or another answer of theirs says it. */
  resolution: Resolution | null;
  kind: QuestionKind;
  choices: string[];
  status: QuestionStatus;
  /** The last few jobs that asked it, newest first. */
  askedBy: Array<Asker & { at: string }>;
  timesAsked: number;
  /** When the host showed it to the user. It is shown there once; after that it waits in Fanfold's window. */
  promptedAt: string | null;
  createdAt: string;
  answeredAt: string | null;
}

interface Resolution {
  answer: string;
  /** 'user' when it is the user's own word given elsewhere; 'fanfold' when Fanfold worked it out. */
  by: 'user' | 'fanfold';
  from: string;
  at: string;
}

const ASKERS_KEPT = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question      TEXT NOT NULL,
  question_norm TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'text',
  choices       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'open',
  asked_by      TEXT NOT NULL DEFAULT '[]',
  times_asked   INTEGER NOT NULL DEFAULT 0,
  prompted_at   TEXT,
  created_at    TEXT NOT NULL,
  answered_at   TEXT,
  scope         TEXT NOT NULL DEFAULT 'person',
  job_id        TEXT,
  draft         TEXT,
  draft_why     TEXT,
  intent_key    TEXT,
  resolution    TEXT
);
`;

export class Questions {
  #db: DatabaseSync;
  #profile: Profile;
  #jobs: Jobs | null = null;

  constructor(db: DatabaseSync, profile: Profile) {
    this.#db = db;
    this.#profile = profile;
    this.#db.exec(SCHEMA);
    const have = new Set((this.#db.prepare("PRAGMA table_info('questions')").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, decl] of [['scope', "TEXT NOT NULL DEFAULT 'person'"], ['job_id', 'TEXT'], ['draft', 'TEXT'], ['draft_why', 'TEXT'], ['intent_key', 'TEXT'], ['resolution', 'TEXT']]) {
      if (!have.has(name)) this.#db.exec(`ALTER TABLE questions ADD COLUMN ${name} ${decl}`);
    }
    if (!have.has('scope')) this.#rekey();
  }

  /**
   * Once, when scope is new: a question still waiting is known again the way
   * it would be asked now, so one about a single job belongs to that job,
   * and "Do you know anyone at Acme?" is the same question at every company.
   */
  #rekey(): void {
    const rows = (this.#db.prepare("SELECT * FROM questions WHERE status != 'answered'").all() as Array<Record<string, unknown>>).map(toQuestion);
    const taken = this.#db.prepare('SELECT 1 FROM questions WHERE question_norm = ?');
    const move = this.#db.prepare('UPDATE questions SET question_norm = ?, scope = ?, job_id = ? WHERE id = ?');
    for (const row of rows) {
      const k = questionKey(row.question, row.kind, row.askedBy[0] ?? null, () => `?${row.id}`);
      if (k.key !== row.norm && !taken.get(k.key)) move.run(k.key, k.scope, k.jobId, row.id);
    }
  }

  /** The kind a form's question is filed as: a choice with nothing to choose is text. */
  static kindOf(input: { kind?: QuestionKind; choices?: string[] }): QuestionKind {
    const choices = (input.choices ?? []).filter((c) => clean(c));
    return input.kind === 'choice' && !choices.length ? 'text' : input.kind ?? (choices.length ? 'choice' : 'text');
  }

  /**
   * A job asked this. One row per question, however often and by whom it is
   * asked, except that a question about one job has a row for each job.
   * `draft` is what Fanfold suggests for the user to check.
   */
  ask(
    input: { question: string; kind?: QuestionKind; choices?: string[] }, by: Asker | null,
    opts: { draft?: { value: string; why: string } | null; intentKey?: string | null; why?: string | null } = {},
  ): { question: Question; fresh: boolean } {
    const text = clean(input.question).slice(0, 300);
    if (!normaliseQuestion(text)) throw new Error('the question has no words to know it by again');
    const kind = Questions.kindOf(input);
    by = this.#onLedger(by);
    const { key, scope, jobId } = questionKey(text, kind, by);
    if (!key) throw new Error('the question has no words to know it by again');
    const now = new Date().toISOString();
    const asker = by && (by.company || by.title || by.url) ? [{ ...by, at: now }] : [];
    // With no draft, `why` says why it waits on the user (draft_why with no draft), such as a form with too many essays to draft.
    const draft = opts.draft ? [clean(opts.draft.value).slice(0, 2000), clean(opts.draft.why).slice(0, 300)] : [null, opts.why ? clean(opts.why).slice(0, 300) : null];
    const existing = this.#row(key);
    if (!existing) {
      const choices = (input.choices ?? []).map((c) => clean(c).slice(0, 120)).filter(Boolean).slice(0, 20);
      this.#db.prepare(`
        INSERT INTO questions (question, question_norm, kind, choices, asked_by, times_asked, created_at, scope, job_id, draft, draft_why, intent_key)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?)
      `).run(text, key, kind, JSON.stringify(kind === 'choice' ? choices : []), JSON.stringify(asker), now, scope, jobId, ...draft, opts.intentKey ?? null);
      return { question: this.#row(key)!, fresh: true };
    }
    const same = (a: Asker): boolean => (a.url && asker[0]?.url ? a.url === asker[0].url : a.company === asker[0]?.company && a.title === asker[0]?.title);
    const askedBy = [...asker, ...existing.askedBy.filter((a) => !asker.length || !same(a))].slice(0, ASKERS_KEPT);
    // Answered once, and the answer is gone from the bank: the user removed it, so it is open again.
    const status = (existing.status === 'answered' && !this.#profile.userAnswer(existing.norm)) || existing.status === 'closed' ? 'open' : existing.status;
    this.#db.prepare(`UPDATE questions SET asked_by = ?, times_asked = times_asked + 1, status = ?, draft = ?, draft_why = ?,
      intent_key = COALESCE(?, intent_key), resolution = CASE WHEN ? = 'answered' THEN resolution ELSE NULL END WHERE id = ?`)
      .run(JSON.stringify(askedBy), status, ...draft, opts.intentKey ?? null, status, existing.id);
    return { question: this.#row(key)!, fresh: false };
  }

  get(id: number): Question | null {
    this.#settle();
    const row = this.#db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toQuestion(row) : null;
  }

  list(status: QuestionStatus, limit = 100): Question[] {
    this.#settle();
    return (this.#db.prepare('SELECT * FROM questions WHERE status = ? ORDER BY created_at, id LIMIT ?')
      .all(status, limit) as Array<Record<string, unknown>>).map(toQuestion);
  }

  /** The host is showing these to the user now. */
  prompted(ids: number[]): void {
    const mark = this.#db.prepare('UPDATE questions SET prompted_at = ? WHERE id = ? AND prompted_at IS NULL');
    const now = new Date().toISOString();
    for (const id of ids) mark.run(now, id);
  }

  /**
   * The user's answer: saved to the answer bank, where every later form finds it. A declined question can still be answered.
   * `source` is where they gave it: "you" is Fanfold's own window, which nothing an agent passes on may overwrite.
   */
  answer(id: number, answer: string, source = 'you', opts: { intentKey?: string | null } = {}): BankAnswer {
    const question = this.get(id);
    if (!question) throw new Error(`no question with id ${id}`);
    // `intentKey` files it more widely than the question's own intent, when the user said so ("for every company").
    const saved = this.#profile.addAnswer(question.question, answer, source, { key: question.norm, jobId: question.jobId, intentKey: opts.intentKey ?? question.intent });
    this.#db.prepare('UPDATE questions SET status = \'answered\', answered_at = ?, draft = NULL, draft_why = NULL WHERE id = ?').run(new Date().toISOString(), id);
    return saved;
  }

  /** Nothing waits on it any more: every job that asked it has gone. It leaves the open list until a job asks it again. */
  close(id: number): boolean {
    return Number(this.#db.prepare('UPDATE questions SET status = \'closed\' WHERE id = ? AND status = \'open\'').run(id).changes) > 0;
  }

  /** The user would rather not answer. It is not asked again; only the user can still answer it. */
  decline(id: number): boolean {
    return Number(this.#db.prepare('UPDATE questions SET status = \'declined\' WHERE id = ? AND status = \'open\'').run(id).changes) > 0;
  }

  /**
   * A job the owner removed from their list. A question about that job alone,
   * or one only it was asking, goes; an answered one stays, as its answer is
   * the user's, in the bank, and so does one the user chose not to answer that
   * holds for every job. Any other question it asked stops naming it. Returns
   * the questions that went.
   */
  forgetJob(job: { jobId: string; urls: Array<string | null | undefined> }): number[] {
    const keys = new Set(job.urls.map((u) => postingKey(u)).filter((k): k is string => !!k));
    const ats = new Set(job.urls.map((u) => atsIdentity(u)).filter((k): k is string => !!k));
    const its = (a: Asker): boolean => a.jobId === job.jobId || (!!a.url && keys.has(postingKey(a.url) ?? ''));
    const about = (id: string | null): boolean => !!id && (id === job.jobId || ats.has(id) || (id.startsWith('posting:') && keys.has(id.slice('posting:'.length))));
    const rows = (this.#db.prepare("SELECT * FROM questions WHERE status != 'answered'").all() as Array<Record<string, unknown>>).map(toQuestion);
    const drop = this.#db.prepare('DELETE FROM questions WHERE id = ?');
    const trim = this.#db.prepare('UPDATE questions SET asked_by = ? WHERE id = ?');
    const gone: number[] = [];
    for (const q of rows) {
      const others = q.askedBy.filter((a) => !its(a));
      if (others.length === q.askedBy.length && !about(q.jobId)) continue;
      if ((q.scope === 'job' && about(q.jobId)) || (q.status !== 'declined' && !others.length)) {
        drop.run(q.id);
        gone.push(q.id);
      } else trim.run(JSON.stringify(others), q.id);
    }
    return gone;
  }

  /**
   * The question these words ask, while the user has not answered it: open,
   * or declined for now. The words are known again the way each waiting
   * question was, so a company's name or the job does not hide it; `by`
   * picks between jobs that each wait on the same question.
   */
  waiting(question: string, by: Asker | null = null): Question | null {
    by = this.#onLedger(by);
    const text = clean(question);
    const exact = this.#row(normaliseQuestion(text));
    if (exact && exact.status !== 'answered') return exact;
    const rows = (this.#db.prepare("SELECT * FROM questions WHERE status != 'answered' ORDER BY id DESC").all() as Array<Record<string, unknown>>).map(toQuestion);
    const matches = rows.filter((row) => [by, ...row.askedBy].some((a) => {
      const k = questionKey(text, row.kind, a ? { ...a, jobId: row.jobId ?? a.jobId } : null, () => row.jobId ?? '');
      return k.key === row.norm;
    }));
    const mine = by && matches.find((row) => row.askedBy.some((a) => (by.url && a.url === by.url) || (by.jobId && a.jobId === by.jobId)));
    return mine ?? matches[0] ?? null;
  }

  /**
   * Settled without the user typing an answer to it here: Fanfold worked it
   * out, or the user's answer to the same thing worded otherwise says it.
   * Nothing is saved as the user's answer to this wording.
   */
  resolve(id: number, r: Omit<Resolution, 'at'>): boolean {
    const resolution: Resolution = { ...r, answer: r.answer.slice(0, 4000), from: r.from.slice(0, 300), at: new Date().toISOString() };
    return Number(this.#db.prepare("UPDATE questions SET status = 'answered', answered_at = ?, draft = NULL, draft_why = NULL, resolution = ? WHERE id = ? AND status = 'open'")
      .run(resolution.at, JSON.stringify(resolution), id).changes) > 0;
  }

  /** Why a question waits on the user with nothing suggested, said on its card. */
  note(id: number, why: string | null): void {
    this.#db.prepare("UPDATE questions SET draft = NULL, draft_why = ? WHERE id = ? AND status != 'answered'").run(why ? clean(why).slice(0, 300) : null, id);
  }

  /** What a question asks, found out after it was filed. */
  setIntent(id: number, intentKey: string | null): void {
    this.#db.prepare('UPDATE questions SET intent_key = ? WHERE id = ?').run(intentKey, id);
  }

  /** What Fanfold suggests for a question still waiting. */
  suggest(id: number, draft: { value: string; why: string } | null): void {
    this.#db.prepare("UPDATE questions SET draft = ?, draft_why = ? WHERE id = ? AND status != 'answered'")
      .run(draft ? clean(draft.value).slice(0, 2000) : null, draft ? clean(draft.why).slice(0, 300) : null, id);
  }

  /**
   * Questions about one job filed while the ledger did not know the job yet,
   * under its address or its name, are moved to the job's id in the ledger;
   * one already there for the same question takes the other in (the older
   * row is kept, an answered one is never lost). One job is then never
   * asked under two keys. Returns how many rows moved or merged.
   */
  rekeyByLedger(): number {
    const ledger = this.#ledger();
    if (!ledger) return 0;
    const rows = (this.#db.prepare("SELECT * FROM questions WHERE scope = 'job' AND status != 'answered' AND job_id IS NOT NULL").all() as Array<Record<string, unknown>>).map(toQuestion);
    if (!rows.length) return 0;
    const known = new Set<string>();
    const byPosting = new Map<string, string>();
    // One posting has many addresses (the board's, the company's page with the board's id in it): its ATS id joins them.
    const byAts = new Map<string, string>();
    for (const r of ledger.list({ limit: 5000 })) {
      known.add(r.jobId);
      for (const u of [r.url, r.job.url, ...r.job.sourceUrls]) {
        const k = postingKey(u);
        if (k && !byPosting.has(k)) byPosting.set(k, r.jobId);
        const a = atsIdentity(u);
        if (a && !byAts.has(a)) byAts.set(a, r.jobId);
      }
    }
    let n = 0;
    for (const row of rows) {
      const current = row.jobId!;
      if (known.has(current)) continue;
      const fromKey = current.startsWith('posting:') ? byPosting.get(current.slice('posting:'.length)) : current.startsWith('ats:') ? byAts.get(current) : undefined;
      const target = fromKey ?? row.askedBy.map((a) => (a.jobId && known.has(a.jobId) ? a.jobId
        : byPosting.get(postingKey(a.url) ?? '') ?? byAts.get(atsIdentity(a.url) ?? ''))).find(Boolean);
      const suffix = `#${current}`;
      if (!target || target === current || !row.norm.endsWith(suffix)) continue;
      const key = `${row.norm.slice(0, -suffix.length)}#${target}`;
      const there = this.#db.prepare('SELECT * FROM questions WHERE question_norm = ?').get(key) as Record<string, unknown> | undefined;
      if (!there) {
        this.#db.prepare('UPDATE questions SET question_norm = ?, job_id = ? WHERE id = ?').run(key, target, row.id);
        n++;
        continue;
      }
      const other = toQuestion(there);
      if (other.status === 'answered') {
        this.#db.prepare('DELETE FROM questions WHERE id = ?').run(row.id);
        n++;
        continue;
      }
      const [keep, drop] = other.id < row.id ? [other, row] : [row, other];
      const same = (a: Asker, b: Asker): boolean => (a.url && b.url ? a.url === b.url : a.company === b.company && a.title === b.title);
      const askedBy = [...keep.askedBy, ...drop.askedBy].sort((a, b) => b.at.localeCompare(a.at))
        .filter((a, i, all) => all.findIndex((b) => same(a, b)) === i).slice(0, ASKERS_KEPT);
      const status = keep.status === 'declined' || drop.status === 'declined' ? 'declined'
        : keep.status === 'open' || drop.status === 'open' ? 'open' : keep.status;
      const draft = keep.draft ? [keep.draft, keep.draftWhy] : [drop.draft, drop.draftWhy];
      this.#db.exec('BEGIN');
      try {
        this.#db.prepare('DELETE FROM questions WHERE id = ?').run(drop.id);
        this.#db.prepare(`UPDATE questions SET question_norm = ?, job_id = ?, asked_by = ?, times_asked = ?, status = ?, draft = ?, draft_why = ?,
          intent_key = COALESCE(intent_key, ?), prompted_at = COALESCE(prompted_at, ?) WHERE id = ?`)
          .run(key, target, JSON.stringify(askedBy), keep.timesAsked + drop.timesAsked, status, draft[0], draft[1], drop.intent, drop.promptedAt, keep.id);
        this.#db.exec('COMMIT');
        n++;
      } catch {
        this.#db.exec('ROLLBACK');
      }
    }
    return n;
  }

  /** The ledger in the same database, once it has one: a job is known by its id there before by its address. */
  #ledger(): Jobs | null {
    if (!this.#jobs && this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'applications'").get()) this.#jobs = new Jobs(this.#db);
    return this.#jobs;
  }

  /** The job asking, known by the ledger's id when the ledger has its address. */
  #onLedger(by: Asker | null): Asker | null {
    if (!by?.url) return by;
    const jobId = this.#ledger()?.jobIdForUrl(by.url);
    return jobId ? { ...by, jobId } : by;
  }

  #row(norm: string): Question | null {
    this.#settle();
    const row = this.#db.prepare('SELECT * FROM questions WHERE question_norm = ?').get(norm) as Record<string, unknown> | undefined;
    return row ? toQuestion(row) : null;
  }

  /** An answer the user gave another way (Profile, a review card, a host's conversation) answers the question too. An agent's does not. */
  #settle(): void {
    this.#db.prepare(`
      UPDATE questions SET status = 'answered', answered_at = ?, draft = NULL, draft_why = NULL
      WHERE status != 'answered' AND question_norm IN (
        SELECT question_norm FROM answers WHERE source IN ('you', 'review') OR source LIKE 'you, in %'
      )
    `).run(new Date().toISOString());
  }
}

/** A profile fact that answers a question, and where it came from. */
export interface FactAnswer {
  field: ProfileField;
  label: string;
  value: string;
  fact: ProfileFact;
  /** How the question asked for it. */
  asked: FieldAsked;
  /** Set when the fact only suggests an answer: why, for the user to check. */
  draft?: string;
}

/**
 * The fact that answers this question, if one plainly does: confirmed, or
 * copied from the owner's own document. Words naming where the user is may
 * come with the question; any other word means it asks something else.
 * Salary and the right to work answer only once the user has confirmed them.
 */
export function factFor(profile: Profile, question: string): FactAnswer | null {
  const asked = fieldAsked(question, placeWords(profile.fact('location')?.value));
  // Where they may work is a list of choices, one per country, answered for one country at a time (known.ts): no line of it answers a form.
  if (!asked || RIGHTS_FIELDS.has(asked.field)) return null;
  const fact = profile.fact(asked.field);
  if (!fact?.usable || (SENSITIVE_FIELDS.has(asked.field) && !fact.confirmed)) return null;
  // "First name" and "Last name" asked apart are the first and the last word of the name; a one-word name answers neither.
  const words = fact.value.trim().split(/\s+/);
  const value = !asked.part ? fact.value : words.length < 2 ? null : asked.part === 'first' ? words[0] : words[words.length - 1];
  if (value === null) return null;
  return { field: asked.field, label: LABELS[asked.field], value, fact, asked, ...(asked.draft ? { draft: asked.draft } : {}) };
}

/**
 * The answer as the form takes it, or null when it does not fit: "Yes" or
 * "No", one of the form's own choices as it spells them, or a plain number.
 * Case and a closing full stop do not count against an answer; anything that
 * says more than the form asks does. Text is taken as given.
 */
export function inShape(question: Pick<Question, 'kind' | 'choices'>, answer: string): string | null {
  const said = answer.trim();
  const bare = said.replace(/[.!]+$/, '').trim();
  const pick = (options: string[]): string | null =>
    options.find((o) => o.toLowerCase() === said.toLowerCase()) ?? options.find((o) => o.toLowerCase() === bare.toLowerCase()) ?? null;
  if (question.kind === 'yes_no') return pick(['Yes', 'No']);
  if (question.kind === 'choice' && question.choices.length) return pick(question.choices);
  if (question.kind === 'number') return /^-?\d+(\.\d+)?$/.test(bare) ? bare : null;
  return said;
}

function toQuestion(r: Record<string, unknown>): Question {
  return {
    id: Number(r.id), question: String(r.question), norm: String(r.question_norm),
    scope: r.scope === 'job' ? 'job' : 'person', jobId: (r.job_id as string) || null,
    draft: (r.draft as string) ?? null, draftWhy: (r.draft_why as string) ?? null,
    intent: (r.intent_key as string) || null, resolution: json<Resolution | null>(r.resolution, null),
    kind: (QUESTION_KINDS as readonly string[]).includes(String(r.kind)) ? String(r.kind) as QuestionKind : 'text',
    choices: json<string[]>(r.choices, []), status: String(r.status) as QuestionStatus,
    askedBy: json<Question['askedBy']>(r.asked_by, []), timesAsked: Number(r.times_asked),
    promptedAt: (r.prompted_at as string) ?? null, createdAt: String(r.created_at), answeredAt: (r.answered_at as string) ?? null,
  };
}
