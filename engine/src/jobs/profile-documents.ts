/**
 * Whose a document is, and which one is the résumé.
 *
 * A document is the user's when they said so (they imported it, or pressed
 * "This is mine") and it does not name somebody else. A résumé headed with
 * another person's name is never read into the user's facts or career,
 * whoever added it, until the user says it is theirs anyway. One document at
 * a time is "the résumé": a file with no work history and no contact
 * details is not one.
 */
import type { DatabaseSync } from 'node:sqlite';
import { hasCvSections, namedLikeACv } from '../policy/import-hold.ts';
import { whoseText } from '../policy/upload-hold.ts';
import { dateRange } from './career.ts';
import { contactFacts } from './profile-fill.ts';

/** Where a person's name and town sit: the first lines of a résumé. */
const HEADER_LINES = 6;

/** Words that make a line a heading, a title or a label rather than someone's name. */
const NOT_A_NAME = /\b(?:resume|résumé|curriculum|vitae|cv|cover|letter|summary|profile|experience|education|skills|contact|objective|references|personal|details|information|about|address|phone|email|mobile|website|portfolio|linkedin|github|declaration|hobbies|interests|languages|certifications|projects|achievements|awards|publications|qualifications|overview|history|employment|hiring|team|dear|sincerely|regards|recruit\w*|human resources|engineer|developer|manager|designer|analyst|scientist|consultant|director|intern|lead|architect|specialist|officer|founder|student|graduate|senior|junior|staff|principal|head|president|associate|assistant|technician|administrator|coordinator|teacher|nurse|accountant|programmer|researcher|freelance|full stack|software|data|product|marketing|sales|university|college|institute|school|limited|ltd|inc|llc|gmbh|pvt|street|road|avenue|lane|confidential|page)\b/i;

/** A part of a name: a word of letters, an initial, or a hyphenated or apostrophed word. */
const NAME_WORD = /^\p{L}[\p{L}'’.-]*$/u;

/** Lowercase joining words inside a name: "Ludwig van Beethoven". */
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'da', 'das', 'do', 'dos', 'del', 'della', 'di', 'du', 'la', 'le', 'bin', 'binti', 'ibn']);

/** Where a header line splits into its parts: "Pune, India | +91 … | name@mail". */
const PARTS = /\s*[|•·▪●]\s*|\t|\s{3,}/;

/**
 * A name as a person writes it: a word in capitals or in lower case gets a
 * capital first letter ("AVERY QUINN" and "avery quinn" are "Avery Quinn"),
 * and a word already mixed ("McQuinn") stays as it is.
 */
export function properName(raw: string): string {
  const words = raw.trim().replace(/\s+/g, ' ').split(' ');
  return words.map((word, i) => {
    const letters = word.replace(/[^\p{L}]/gu, '');
    const upper = letters === letters.toUpperCase();
    const lower = letters === letters.toLowerCase();
    if (!letters || (!upper && !lower) || (upper && letters.length === 1)) return word;
    if (i > 0 && i < words.length - 1 && PARTICLES.has(word.toLowerCase())) return word.toLowerCase();
    return word.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }).join(' ');
}

/** Whether two names are one, however they are cased or spaced. */
export function sameName(a: string, b: string): boolean {
  const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();
  return !!fold(a) && fold(a) === fold(b);
}

/** A line that is a person's name and nothing else: two to four words of letters, no heading or job word. */
function nameLine(line: string): string | null {
  const v = line.trim().replace(/^name\s*[:-]\s*/i, '');
  if (!v || v.length > 48 || /[\d@/\\:;,|()]/.test(v) || NOT_A_NAME.test(v)) return null;
  const words = v.split(/\s+/);
  if (words.length < 2 || words.length > 4 || !words.every((w) => NAME_WORD.test(w))) return null;
  // A name's words start with a capital, written in capitals or not; a sentence's do not.
  if (!words.every((w, i) => /^\p{Lu}/u.test(w) || (i > 0 && PARTICLES.has(w.toLowerCase())))) return null;
  return v;
}

/** The person a document is headed with: its first name-like line, or a "Name:" line near the top; null when it names nobody plainly. */
export function nameIn(text: string): string | null {
  const labelled = /^\s*(?:full )?name\s*[:-]\s*(.+)$/im.exec(text.slice(0, 1500))?.[1];
  if (labelled) {
    const n = nameLine(labelled);
    if (n) return n;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, HEADER_LINES);
  for (const line of lines) {
    const n = nameLine(line.split(PARTS)[0] ?? '');
    if (n) return n;
  }
  return null;
}

/** "Pune, India" or "Lisbon, Portugal" as the header of a résumé writes where its owner lives; null when it does not. */
export function headerLocation(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, HEADER_LINES);
  for (const line of lines) {
    for (const part of line.split(PARTS)) {
      const v = part.trim();
      if (v.length > 40 || /[\d@/\\:;()]/.test(v) || NOT_A_NAME.test(v)) continue;
      const m = /^(\p{Lu}[\p{L} .'’-]*),\s*(\p{Lu}[\p{L} .'’-]*)$/u.exec(v);
      if (m && v.split(/\s+/).length <= 5) return v;
    }
  }
  return null;
}

/** Whether a text has a work history: résumé sections, or a dated line. */
function workHistory(text: string): boolean {
  return hasCvSections(text) || text.split('\n').some((line) => line.length <= 160 && !!dateRange(line));
}

/** Whether a text cannot be the résumé: it has neither a work history nor contact details. */
export function notAResume(text: string): boolean {
  if (workHistory(text)) return false;
  const c = contactFacts(text);
  return !(c.email || c.phone || c.linkedin);
}

/**
 * The other person a document is about, or null: a document that reads as a
 * résumé or CV, does not mention the user's name, and is headed with
 * someone else's. With no name on the profile there is nobody to compare.
 */
export function someoneElse(userName: string | undefined, title: string, text: string): string | null {
  if (!userName?.trim() || !text.trim()) return null;
  if (whoseText(userName, text.slice(0, 3000)).startsWith('names ')) return null;
  if (!namedLikeACv(title) && !hasCvSections(text)) return null;
  const named = nameIn(text);
  return named && !sameName(named, userName) ? properName(named) : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS document_owners (
  document_id  TEXT PRIMARY KEY,
  other_name   TEXT,
  mine_anyway  INTEGER NOT NULL DEFAULT 0,
  judged_at    TEXT NOT NULL
);
`;

/** What Fanfold decided about whose each document is. */
export class DocumentOwners {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  /** The other person a document names, unless the user said it is theirs anyway. */
  otherName(documentId: string): string | null {
    const row = this.#db.prepare('SELECT other_name, mine_anyway FROM document_owners WHERE document_id = ?').get(documentId) as
      { other_name: string | null; mine_anyway: number } | undefined;
    return row && !Number(row.mine_anyway) ? row.other_name : null;
  }

  /** The user said a document is theirs whatever name it carries. */
  mineAnyway(documentId: string): boolean {
    const row = this.#db.prepare('SELECT mine_anyway FROM document_owners WHERE document_id = ?').get(documentId) as { mine_anyway: number } | undefined;
    return !!row && Number(row.mine_anyway) === 1;
  }

  /** Keep what a reading found: the other person's name, or null when it names the user or nobody. */
  judged(documentId: string, otherName: string | null): void {
    this.#db.prepare(`
      INSERT INTO document_owners (document_id, other_name, judged_at) VALUES (?,?,?)
      ON CONFLICT(document_id) DO UPDATE SET other_name = excluded.other_name, judged_at = excluded.judged_at
    `).run(documentId, otherName, new Date().toISOString());
  }

  setMineAnyway(documentId: string): void {
    this.#db.prepare(`
      INSERT INTO document_owners (document_id, other_name, mine_anyway, judged_at) VALUES (?, NULL, 1, ?)
      ON CONFLICT(document_id) DO UPDATE SET mine_anyway = 1
    `).run(documentId, new Date().toISOString());
  }

  forget(documentId: string): void {
    this.#db.prepare('DELETE FROM document_owners WHERE document_id = ?').run(documentId);
  }
}
