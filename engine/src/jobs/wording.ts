/** How a question is known again, however a form words it. */

const STOP = new Set(['the', 'a', 'an', 'you', 'your', 'are', 'do', 'is', 'of', 'to', 'in', 'for', 'with', 'and', 'or', 'please', 'have', 'any']);

/** Page text a person will read: no control or invisible characters, one line. */
export function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Lowercase, accents folded as folded() folds them, no punctuation, stop
 * words dropped: "Years of experience with Go?" → "years experience go",
 * "Résumé" → "resume".
 */
export function normaliseQuestion(q: string): string {
  return q.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ');
}

/**
 * A question as normaliseQuestion knew it before accents were folded: each
 * accent mark split its word ("résumé" was "re sume"). Kept only so keys
 * stored that way can be found and moved.
 */
export function splitAccentsQuestion(q: string): string {
  return normaliseQuestion(q.normalize('NFKD').replace(/\p{M}/gu, ' '));
}

/** The words of a normalised question, a plural taken as its singular. */
function words(norm: string): Set<string> {
  return new Set(norm.split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}

/** Shared words over all words, from 0 to 1: how alike two normalised questions are worded. */
export function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Text folded for a word-for-word comparison: case, accents, spacing and a link's scheme do not count. */
export function folded(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/https?:\/\/(www\.)?/g, '').replace(/\s+/g, ' ').trim();
}

/** Whether a value is written word for word in a text. A link counts with or without its scheme and closing slash. */
export function appearsIn(value: string, text: string): boolean {
  const v = folded(value).replace(/\/+$/, '');
  return v.length > 1 && folded(text).includes(v);
}

/** Text folded for checking a quote: case, accents, spacing and the shape of dashes and quote marks do not count. */
export function quoteFolded(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[‐-―−]/g, '-').replace(/[‘’‛′]/g, '\'').replace(/[“”″]/g, '"')
    .replace(/\s+/g, ' ').trim();
}

const WORDISH = /[\p{L}\p{N}]/u;

/** Where a quote is written in a text, word for word and never from inside a word, as an offset in the folded text; -1 when it is not. */
export function quoteAt(quote: string, text: string): number {
  const q = quoteFolded(quote);
  const t = quoteFolded(text);
  if (!q) return -1;
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
    const cutBefore = WORDISH.test(q[0]) && WORDISH.test(t[at - 1] ?? '');
    const cutAfter = WORDISH.test(q[q.length - 1]) && WORDISH.test(t[at + q.length] ?? '');
    if (!cutBefore && !cutAfter) return at;
  }
  return -1;
}

/** The words a text has, punctuation aside. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => WORDISH.test(w)).length;
}

/** Spellings that mean the same skill. Keys and values are lowercase. */
const SKILL_ALIASES: Record<string, string> = {
  js: 'javascript', 'java script': 'javascript', ecmascript: 'javascript', ts: 'typescript',
  golang: 'go', 'go lang': 'go', k8s: 'kubernetes', kube: 'kubernetes',
  postgres: 'postgresql', psql: 'postgresql', 'postgre sql': 'postgresql',
  node: 'node.js', nodejs: 'node.js', 'node js': 'node.js', reactjs: 'react', 'react.js': 'react', 'react js': 'react',
  vuejs: 'vue', 'vue.js': 'vue', py: 'python', python3: 'python', 'python 3': 'python',
  gcp: 'google cloud', 'google cloud platform': 'google cloud', 'amazon web services': 'aws',
  ml: 'machine learning', 'c sharp': 'c#', dotnet: '.net', 'dot net': '.net', tf: 'terraform',
  mongo: 'mongodb', 'elastic search': 'elasticsearch', cicd: 'ci/cd', 'ci cd': 'ci/cd', 'ci-cd': 'ci/cd',
  'apache kafka': 'kafka', 'apache spark': 'spark', pyspark: 'spark', 'amazon aws': 'aws',
};

/** How many of `open` a text has more than of `close`. */
const unmatched = (text: string, open: string, close: string): number => text.split(open).length - text.split(close).length;

/**
 * A skill's name as written, tidied: no quotes or stray punctuation around
 * it, and a bracket at either end only when it closes or opens one inside
 * ("Model Context Protocol (MCP)" keeps its last bracket; "(Docker" loses its first).
 */
export function tidySkill(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim().replace(/^["'“‘\s]+|["'”’?:;,!.\s]+$/g, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    if (s.startsWith(open) && unmatched(s, open, close) > 0) s = s.slice(1).trim();
    if (s.endsWith(close) && unmatched(s, open, close) < 0) s = s.slice(0, -1).trim();
  }
  return s;
}

/** A skill as it is known again: lowercase, its common spellings folded ("k8s" is kubernetes, "golang" is go). */
export function canonicalSkill(raw: string): string {
  const s = tidySkill(raw.normalize('NFKD').replace(/\p{M}/gu, '')).toLowerCase();
  return SKILL_ALIASES[s] ?? SKILL_ALIASES[s.replace(/[._-]/g, ' ').replace(/\s+/g, ' ')] ?? s;
}

/** Every spelling of a skill that names it. */
export function skillForms(skill: string): string[] {
  const c = canonicalSkill(skill);
  return [c, ...Object.keys(SKILL_ALIASES).filter((k) => SKILL_ALIASES[k] === c)];
}

/** Text to match as written inside a regular expression. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a text names a skill, in any of its spellings. A name of two
 * letters or "go" counts only as written with a capital, so "go to market"
 * is not Go.
 */
export function mentionsSkill(text: string, skill: string): boolean {
  return skillForms(skill).some((form) => {
    const short = form.length <= 2 || form === 'go';
    const body = short ? `(?:${escapeRe(form[0].toUpperCase() + form.slice(1))}|${escapeRe(form.toUpperCase())})` : escapeRe(form).replace(/ /g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}+#.])${body}(?![\\p{L}\\p{N}+#])`, short ? 'u' : 'iu').test(text);
  });
}
