/**
 * A page of job search results as rows: which job, where, how recent, and
 * its address, in place of the whole page. Read from the observation the
 * snapshot took, so a row's ref is the card's own and works with browser_act.
 *
 * A result card is a node carrying a job id ([job=…]) with the job's link or
 * its "Dismiss <title> job" button inside it. The card's words are what the
 * page wrote: every value stays page text, quoted like any other.
 */
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import type { Observation, ObservedNode } from '../types.ts';

export interface SearchRow {
  job: string;
  ref: string | null;
  title: string;
  company: string | null;
  /** Where, with the workplace when the card says it. */
  location: string | null;
  posted: string | null;
  /** What else the card says, such as "Easy Apply" or "Applied". */
  notes: string[];
  url: string | null;
  /** The card's words, when they could not be told apart. */
  words: string | null;
}

const text = (n: ObservedNode | undefined): string =>
  [n?.name, n?.text].filter(Boolean).map((t) => unwrapUntrustedForDisplay(t!)).join(' ').replace(/\s+/g, ' ').trim();
const nameOf = (n: ObservedNode): string => (n.name ? unwrapUntrustedForDisplay(n.name).replace(/\s+/g, ' ').trim() : '');

const DISMISS = /^Dismiss (.+) job$/i;
const LOGO = /^(.+?)\s+(company\s+)?logo$/i;
const AGE = /\b(?:(?:re)?posted\s+)?(?:\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|just now|today|yesterday)\b/i;
const WORKPLACE = /\((?:hybrid|remote|on-site|onsite)\)/i;
/** What a card says beside the job itself. */
const NOTES = /\b(easy apply|applied|viewed|promoted|actively reviewing applicants|be an early applicant|verified job)\b/gi;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The end of a node's subtree in a flat, depth-annotated list. */
function subtree(nodes: readonly ObservedNode[], at: number): ObservedNode[] {
  const out: ObservedNode[] = [];
  for (let i = at + 1; i < nodes.length && nodes[i].depth > nodes[at].depth; i++) out.push(nodes[i]);
  return out;
}

/** The job's own address, as the board numbers it. */
function postingUrl(pageUrl: string, job: string): string | null {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (/(^|\.)linkedin\.com$/.test(host) && /^\d+$/.test(job)) return `https://www.linkedin.com/jobs/view/${job}/`;
  } catch {
    // An address that does not parse names no posting.
  }
  return null;
}

export function searchRows(observation: Observation): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  const { nodes } = observation;
  for (const [at, card] of nodes.entries()) {
    const job = card.state.job;
    if (!job || seen.has(job)) continue;
    const inside = subtree(nodes, at);
    const dismiss = inside.map((n) => DISMISS.exec(nameOf(n))).find(Boolean);
    const link = inside.find((n) => n.role === 'link' && nameOf(n) && !LOGO.test(nameOf(n)));
    const title = (link ? nameOf(link) : dismiss?.[1] ?? '').trim();
    if (!title) continue;
    seen.add(job);
    const logo = [card, ...inside].map((n) => (n.role === 'img' ? LOGO.exec(nameOf(n)) : null)).find(Boolean);
    const company = logo?.[1].trim() ?? null;

    // The card's words, less the job's title, the logo, and the marks of the selected or verified card.
    let words = text(card);
    for (const part of [logo?.[0], title]) if (part) words = words.replace(part, ' ');
    words = words.replace(/\((?:verified job)\)|\bwith verification\b/gi, ' ').replace(/\s+/g, ' ')
      .replace(/^[·\s]+/, '').replace(/^Selected,\s*/i, '').trim();
    if (company) {
      // A logo drawn as the company's first letter comes before its name.
      words = words.replace(new RegExp(`^(?:\\S\\s+)?${escape(company)}(?=\\s|$)\\s*`), '');
    }
    const posted = AGE.exec(words)?.[0] ?? null;
    const notes: string[] = [];
    for (const m of words.matchAll(NOTES)) if (!notes.some((n) => n.toLowerCase() === m[1].toLowerCase())) notes.push(m[1]);
    // Where: up to the workplace the card names, or up to the first of its notes.
    const workplace = WORKPLACE.exec(words);
    const firstNote = words.search(new RegExp(`${NOTES.source}|${AGE.source}`, 'i'));
    const end = workplace ? workplace.index + workplace[0].length : firstNote >= 0 ? firstNote : words.length;
    const where = words.slice(0, end).replace(/[·\s]+$/, '').trim() || null;
    rows.push({
      job, ref: card.ref, title, company, posted, notes,
      location: company ? where : null,
      url: postingUrl(observation.url, job),
      // Without the company's own name, the company and the place cannot be told apart, so both are given as written.
      words: company ? null : where,
    });
  }
  return rows;
}

/** One line per row, every page-written value quoted. */
export function renderRows(rows: readonly SearchRow[]): string {
  const q = (s: string): string => JSON.stringify(s);
  return rows.map((r, i) => [
    `${i + 1}. ${q(r.title)}${r.company ? ` at ${q(r.company)}` : ''}`,
    ...(r.location ? [q(r.location)] : r.words ? [q(r.words)] : []),
    ...(r.posted ? [`posted ${q(r.posted)}`] : []),
    ...(r.notes.length ? [r.notes.map(q).join(', ')] : []),
    r.url ?? `job ${q(r.job)}`,
  ].join(' — ') + (r.ref ? ` [ref=${r.ref}]` : '')).join('\n');
}
