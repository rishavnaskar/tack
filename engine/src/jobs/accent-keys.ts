/**
 * Once: question keys kept while normaliseQuestion split a word at each
 * accent ("résumé" was "re sume", "Société" was "socie te") are moved to the
 * folded form built now, so a saved answer, a waiting question, a worked-out
 * answer and a kept classification are all found again.
 *
 * A key is rebuilt from the words it was made from where they are kept: the
 * row's own question, the companies and titles of the jobs that asked, the
 * values a classification read. The part after "#" that names a job is the
 * ledger's id and is left as it is; a company named there is folded like the
 * wording. Two rows that end up under one key are merged: the user's own
 * answer beats anything else, then the newer one stays. Whatever goes is kept
 * whole in the settings row that marks this repair done, and reported.
 */
import type { DatabaseSync } from 'node:sqlite';
import { escapeRe, normaliseQuestion, splitAccentsQuestion } from './wording.ts';
import { isUserSource } from './profile.ts';
import { json } from './json.ts';

/** The settings key that says this repair has run, with what it moved and merged. */
export const FOLD_SETTING = 'questions.repair.foldedAccents';

type Table = 'answers' | 'questions' | 'derived_answers' | 'question_intents';
type Row = Record<string, unknown>;

/** Two rows that came to share a key: the one kept, and the one merged into it, whole. */
export interface KeyMerge { table: Table; key: string; kept: unknown; dropped: unknown; row: Row }

export interface Folded {
  /** Keys moved, by table; `intent_key` counts intent keys moved in any table. */
  moved: Record<string, number>;
  merged: KeyMerge[];
}

/** The words keys may have been built from: each text and each word, in the old split form and the folded one. */
class Folds {
  readonly #whole = new Map<string, string>();
  readonly #pairs = new Map<string, string>();
  #words: Array<[RegExp, string]> = [];

  add(text: unknown): void {
    if (typeof text !== 'string' || splitAccentsQuestion(text) === normaliseQuestion(text)) return;
    if (!this.#whole.has(splitAccentsQuestion(text))) this.#whole.set(splitAccentsQuestion(text), normaliseQuestion(text));
    // A word the old form split in two is safe to fold wherever it stands; one that only lost a piece ("doña" was "don") is folded only as a whole text.
    for (const word of text.normalize('NFKD').split(/[^\p{L}\p{N}\p{M}]+/u)) {
      const was = splitAccentsQuestion(word);
      if (was.includes(' ') && !this.#pairs.has(was)) this.#pairs.set(was, normaliseQuestion(word));
    }
  }

  seal(): void {
    this.#words = [...this.#pairs].sort((a, b) => b[0].length - a[0].length)
      .map(([was, is]) => [new RegExp(`(?<=^| )${escapeRe(was)}(?= |$)`, 'g'), is]);
  }

  /** A normalised wording, folded; `own` is the text it was built from, when that is kept. */
  wording(part: string, own?: unknown): string {
    if (typeof own === 'string' && splitAccentsQuestion(own) === part) return normaliseQuestion(own);
    const whole = this.#whole.get(part);
    if (whole !== undefined) return whole;
    return this.#words.reduce((out, [re, is]) => out.replace(re, is), part);
  }

  /** A question key: its wording, then "#" and the job's id (left alone), or "#company:" and the company (folded). */
  key(key: string, own?: unknown): string {
    const at = key.indexOf('#');
    if (at < 0) return this.wording(key, own);
    const tail = key.slice(at);
    const company = tail.startsWith('#company:') && !tail.startsWith('#company:?');
    return this.wording(key.slice(0, at), own) + (company ? `#company:${this.wording(tail.slice('#company:'.length))}` : tail);
  }

  /** An intent key, "referral.know_anyone:socie te" → "referral.know_anyone:societe": each value folded, a job after "#" left alone. */
  intent(key: unknown): unknown {
    if (typeof key !== 'string' || !key) return key;
    const at = key.indexOf('#');
    const [id, ...values] = (at < 0 ? key : key.slice(0, at)).split(':');
    return [id, ...values.map((v) => this.wording(v))].join(':') + (at < 0 ? '' : key.slice(at));
  }
}

/** One row's plan: its key and the columns that change, and which rows it is merged with. */
interface Plan { row: Row; key: string; group: string; set: Row }

const first = (rows: Row[], col: string): unknown => rows.map((r) => r[col]).find((v) => typeof v === 'string' && v) ?? null;
const when = (r: Row, cols: string[]): string => String(first([r], cols[0]) ?? (cols[1] ? first([r], cols[1]) : null) ?? '');
/** Newer first, by the first of `cols` a row has; then the later row. */
const newer = (cols: string[]) => (a: Row, b: Row): number => when(b, cols).localeCompare(when(a, cols)) || Number(b._rid) - Number(a._rid);

/** Run the repair, once. Null when it has run before. All of it happens in one transaction: everything moves, or nothing does. */
export function foldAccentKeys(db: DatabaseSync, now = new Date()): Folded | null {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(FOLD_SETTING)) return null;
  const all = (table: string): Row[] => (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    ? db.prepare(`SELECT rowid AS _rid, * FROM ${table}`).all() as Row[] : []);
  const answers = all('answers');
  const questions = all('questions');
  const derived = all('derived_answers');
  const intents = all('question_intents');

  const folds = new Folds();
  for (const r of [...answers, ...derived]) folds.add(r.question);
  for (const r of questions) {
    folds.add(r.question);
    for (const a of json<Array<{ company?: unknown; title?: unknown }>>(r.asked_by, [])) { folds.add(a.company); folds.add(a.title); }
  }
  for (const r of all('jobs')) { folds.add(r.company); folds.add(r.title); }
  for (const r of intents) for (const v of Object.values(json<Row>(r.params, {}))) folds.add(v);
  folds.seal();

  const moved: Record<string, number> = { answers: 0, questions: 0, derived_answers: 0, question_intents: 0, intent_key: 0 };
  const merged: KeyMerge[] = [];

  /** A row's plan, with its intent key folded in `column` (or in its JSON `basis`). */
  const plan = (row: Row, key: string, group = key): Plan => {
    const set: Row = {};
    const intent = folds.intent(row.intent_key);
    if (intent !== row.intent_key) set.intent_key = intent;
    const basis = json<Row>(row.basis, {});
    const basisIntent = folds.intent(basis.intentKey);
    if (basisIntent !== basis.intentKey) set.basis = JSON.stringify({ ...basis, intentKey: basisIntent });
    if ('intent_key' in set || 'basis' in set) moved.intent_key++;
    return { row: { ...row, ...set }, key, group, set };
  };

  /**
   * Each group's best row, by `better`, takes the group's key; the others are
   * deleted once `merge` has taken what they hold. Keys move through a
   * stand-in so no two rows ever share one.
   */
  const apply = (table: Table, keyCol: string, plans: Plan[], better: (a: Row, b: Row) => number, merge: (rows: Row[]) => Row): void => {
    const groups = new Map<string, Plan[]>();
    for (const p of plans) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    const writes: Plan[] = [];
    for (const group of groups.values()) {
      const [kept, ...rest] = group.sort((a, b) => better(a.row, b.row));
      for (const p of rest) {
        db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(Number(p.row._rid));
        const row = { ...p.row };
        delete row._rid;
        merged.push({ table, key: kept.key, kept: kept.row.id ?? kept.row.key, dropped: row.id ?? row.key, row });
      }
      const set = { ...kept.set, ...(rest.length ? merge([kept.row, ...rest.map((p) => p.row)]) : {}) };
      if (kept.key !== kept.row[keyCol]) moved[table]++;
      if (kept.key !== kept.row[keyCol] || Object.keys(set).length) writes.push({ ...kept, set });
    }
    const park = db.prepare(`UPDATE ${table} SET ${keyCol} = ? WHERE rowid = ?`);
    for (const w of writes) park.run(`\u0001${String(w.row._rid)}`, Number(w.row._rid));
    for (const w of writes) {
      const cols = Object.keys(w.set);
      db.prepare(`UPDATE ${table} SET ${[keyCol, ...cols].map((c) => `${c} = ?`).join(', ')} WHERE rowid = ?`)
        .run(w.key, ...cols.map((c) => w.set[c] as string | number | null), Number(w.row._rid));
    }
  };

  db.exec('BEGIN');
  try {
    // Saved answers, per job ones included: the user's own beats an agent's or a draft, then the newer.
    const userFirst = (a: Row, b: Row): number => Number(isUserSource(String(b.source))) - Number(isUserSource(String(a.source))) || newer(['updated_at', 'created_at'])(a, b);
    apply('answers', 'question_norm', answers.map((r) => plan(r, folds.key(String(r.question_norm), r.question))), userFirst, (rows) => ({
      intent_key: first(rows, 'intent_key'),
      used_count: rows.reduce((n, r) => n + Number(r.used_count ?? 0), 0),
      last_used_at: rows.map((r) => r.last_used_at).filter((t): t is string => typeof t === 'string').sort().at(-1) ?? null,
    }));

    // Questions: one the user has answered beats one still waiting, then the newer. What each was asked by is kept.
    const answeredFirst = (a: Row, b: Row): number => Number(b.status === 'answered') - Number(a.status === 'answered') || newer(['answered_at', 'created_at'])(a, b);
    apply('questions', 'question_norm', questions.map((r) => plan(r, folds.key(String(r.question_norm), r.question))), answeredFirst, (rows) => {
      const askers = rows.flatMap((r) => json<Array<{ url?: string; company?: string; title?: string; at?: string }>>(r.asked_by, []))
        .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
        .filter((a, i, list) => list.findIndex((b) => (a.url && b.url ? a.url === b.url : a.company === b.company && a.title === b.title)) === i).slice(0, 5);
      const drafted = rows.find((r) => r.draft) ?? rows[0];
      return {
        asked_by: JSON.stringify(askers), times_asked: rows.reduce((n, r) => n + Number(r.times_asked ?? 0), 0),
        status: rows.some((r) => r.status === 'answered') ? 'answered' : rows.some((r) => r.status === 'declined') ? 'declined'
          : rows.some((r) => r.status === 'open') ? 'open' : rows[0].status,
        draft: drafted.draft ?? null, draft_why: drafted.draft_why ?? null,
        intent_key: first(rows, 'intent_key'), prompted_at: first(rows, 'prompted_at'), resolution: first(rows, 'resolution'),
      };
    });

    // Worked-out answers, one per question and job: the user's refusal of one beats it, then the newer.
    const refusalFirst = (a: Row, b: Row): number => Number(b.rejected ?? 0) - Number(a.rejected ?? 0) || newer(['created_at'])(a, b);
    apply('derived_answers', 'question_norm', derived.map((r) => {
      const key = folds.key(String(r.question_norm), r.question);
      return plan(r, key, `${key}\u0000${String(r.job_id ?? '')}`);
    }), refusalFirst, () => ({}));

    // Kept classifications of a wording: the newer one, with every answer check either holds.
    apply('question_intents', 'key', intents.map((r) => plan(r, folds.key(String(r.key)))), newer(['created_at']), (rows) => ('support' in rows[0]
      ? { support: JSON.stringify(Object.assign({}, ...rows.slice().reverse().map((r) => json<Row>(r.support, {})))) } : {}));

    const record = { at: now.toISOString(), moved, merged: merged.map(({ table, key, kept, row }) => ({ table, key, kept, dropped: row })) };
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(FOLD_SETTING, JSON.stringify(record));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { moved, merged };
}
