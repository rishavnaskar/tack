/**
 * Lexical retrieval (BM25) over document chunks and lessons.
 *
 * Deliberately not a vector index, and the reason is worth stating rather than
 * assuming. Embeddings would add a network call on a hot path and a native
 * dependency, in exchange for semantic matching that this corpus mostly does
 * not need: a user's documents are their own resume and writing, and the
 * queries against them contain the same vocabulary. Lessons are retrieved by
 * (domain, task_type) first, with text only breaking ties.
 *
 * The honest limitation: a query that shares no vocabulary with a relevant
 * chunk will miss it. Vectors are worth adding when the eval shows lexical
 * retrieval actually losing something — not before.
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * Words that say nothing about what a text is about. A task about Hacker News
 * shares "one" and "time" with almost any résumé, and that is no reason to
 * put the résumé in its prompt: a match has to be on words that carry the
 * topic. Checked before and after stemming, so "finding" goes with "find".
 */
const STOPWORDS = new Set(`
  a about above after again against all almost also although always am among an and another any anyone anything are
  around as at away back be because been before being below between both but by can could did didn do does doesn
  doing don done down during each either else enough even ever every few for from further had has have having he
  her here hers herself him himself his how however if in into is isn it its itself just least less ll many may me
  might mine more most much must my myself neither never no nor not now of off often on once only onto or other
  others our ours ourselves out over own per perhaps please quite rather re really same shall she should since so
  some something such than that the their theirs them themselves then there these they this those though through
  thus to too under until up upon us very via ve was wasn we were what whatever when where whether which while who
  whom whose why will with within without won would yet you your yours yourself yourselves
  ask call check come compare describe explain find get give go keep know let like look make need open put read run
  say see show start stop summarise summarize take tell think try use want went write
  day days thing things time times today tomorrow week weeks month months year years way ways lot lots part people
  place point kind sort type number example page pages site website link links web online
  one two three four five six seven eight nine ten first second third last next previous half
  able available best better big current different full good great high latest long low new newest old real recent
  right short small sure top
`.trim().split(/\s+/));

/** "résumé" and "resume" are one word to a search; marks on other scripts' letters are left alone. */
function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

const K1 = 1.2;
const B = 0.75;

/**
 * Conservative suffix stripping.
 *
 * Without it, "orchestration" and "orchestrator" are unrelated terms and a
 * perfectly reasonable question misses the paragraph that answers it. Applied
 * only to purely alphabetic tokens, so identifiers survive intact: "node.js"
 * must not become "node.j", and "C++" must not become "C".
 *
 * Longest suffix first, and only when a stem of at least four characters
 * remains — short stems collide with each other far more than they help.
 */
const SUFFIXES: Array<[string, string]> = [
  ['izations', 'iz'], ['ization', 'iz'], ['ations', 'at'], ['ation', 'at'],
  ['ators', 'at'], ['ator', 'at'], ['ions', ''], ['ion', ''],
  ['ings', ''], ['ing', ''], ['edly', ''], ['ies', 'i'],
  ['ers', ''], ['er', ''], ['ed', ''], ['ly', ''], ['es', ''], ['s', ''],
];

function stem(token: string): string {
  if (!/^[a-z]+$/.test(token)) return token;
  for (const [suffix, replacement] of SUFFIXES) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length) + replacement;
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  return foldAccents(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s.+#-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length > 1 && t.length < 40 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => !STOPWORDS.has(t));
}

/** Index terms kept before accents were folded ("résumé"), moved to the words searches now use ("resume"). */
export function refoldPostings(db: DatabaseSync): void {
  const stale = (db.prepare("SELECT DISTINCT term FROM postings WHERE term GLOB '*[^ -~]*'").all() as Array<{ term: string }>)
    .map((r) => r.term).filter((term) => tokenize(term).join(' ') !== term);
  const move = db.prepare('INSERT INTO postings (term, chunk_id, tf) VALUES (?,?,?) ON CONFLICT(term, chunk_id) DO UPDATE SET tf = tf + excluded.tf');
  for (const term of stale) {
    const rows = db.prepare('SELECT chunk_id, tf FROM postings WHERE term = ?').all(term) as Array<{ chunk_id: string; tf: number }>;
    db.prepare('DELETE FROM postings WHERE term = ?').run(term);
    for (const folded of tokenize(term)) for (const r of rows) move.run(folded, r.chunk_id, r.tf);
  }
}

export function termFrequencies(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const term of tokenize(text)) tf.set(term, (tf.get(term) ?? 0) + 1);
  return tf;
}

export interface ScoredDoc {
  id: string;
  score: number;
}

interface Bm25Input {
  /** term -> [{chunkId, tf}] for the query's terms only. */
  postings: Map<string, Array<{ id: string; tf: number }>>;
  /** chunk id -> length in tokens. */
  lengths: Map<string, number>;
  totalDocs: number;
  avgLength: number;
}

/**
 * Standard BM25. Kept as a pure function so it can be unit-tested against
 * hand-worked examples without a database.
 */
export function bm25(queryTerms: string[], input: Bm25Input, limit = 10): ScoredDoc[] {
  const scores = new Map<string, number>();
  const seen = new Set<string>();

  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const posting = input.postings.get(term);
    if (!posting?.length) continue;

    const df = posting.length;
    // The +1 inside the log keeps the idf non-negative for terms that appear
    // in most documents, which otherwise score as evidence against a match.
    const idf = Math.log(1 + (input.totalDocs - df + 0.5) / (df + 0.5));

    for (const { id, tf } of posting) {
      const len = input.lengths.get(id) ?? input.avgLength;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (len / (input.avgLength || 1))));
      scores.set(id, (scores.get(id) ?? 0) + idf * norm);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Split text into overlapping chunks on paragraph then sentence boundaries.
 * Overlap exists so a fact spanning a boundary is not lost by both chunks.
 */
export function chunkText(text: string, targetTokens = 220, overlapTokens = 40): string[] {
  const approxCharsPerToken = 4;
  const target = targetTokens * approxCharsPerToken;
  const overlap = overlapTokens * approxCharsPerToken;

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = current.length > overlap ? current.slice(-overlap) : '';
  };

  for (const para of paragraphs) {
    if (para.length > target) {
      // A single long paragraph: fall back to sentence boundaries.
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (current.length + s.length > target) flush();
        current += (current ? ' ' : '') + s;
      }
      continue;
    }
    if (current.length + para.length > target) flush();
    current += (current ? '\n\n' : '') + para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
