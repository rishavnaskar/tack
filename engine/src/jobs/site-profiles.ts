/**
 * The owner's own profile on the sites they are signed in to, brought into
 * Fanfold as a document.
 *
 * Two routes. LinkedIn's own data export (the zip from "Get a copy of your
 * data") is read in code: its CSVs become a text and a career record with no
 * model. Otherwise Fanfold opens the owner's own profile pages in a window
 * they can watch, reads what each page says, and keeps it as text.
 *
 * The read is narrow on purpose. It starts only on the owner's word (a button,
 * or a host's call whose result the owner must confirm); it never signs in,
 * types anything or works a bot check, and the first sign-in page or check
 * ends it; it keeps a page only when the page shows it is the viewer's own
 * profile, and leaves out other people, recommendations and messages; it
 * loads at most eight pages, a few seconds apart; nothing schedules it. What
 * it keeps is text alone, so it can never be attached to an application.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { App } from '../app.ts';
import type { Logger } from '../lib/log.ts';
import type { Memory } from '../memory/memory.ts';
import type { BrowserRuntime, Tab } from '../observe/runtime.ts';
import type { Owner } from '../observe/tab-ledger.ts';
import type { Observation, ObservedNode } from '../types.ts';
import { detectChallenge } from '../policy/challenge.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { whoseText } from '../policy/upload-hold.ts';
import { guardRun } from '../agent/run-guard.ts';
import { isZip, readZipEntry } from '../memory/docx.ts';
import { fromLinkedInExport, sha256, type CareerRecords, type LinkedInExport } from './career.ts';
import { fillProfile } from './profile-fill.ts';
import type { Profile } from './profile.ts';
import { appearsIn } from './wording.ts';

export type SiteId = 'linkedin' | 'naukri' | 'instahyre' | 'indeed' | 'wellfound';
export const SITE_IDS: readonly SiteId[] = ['linkedin', 'naukri', 'instahyre', 'indeed', 'wellfound'];
export const isSiteId = (v: unknown): v is SiteId => typeof v === 'string' && (SITE_IDS as readonly string[]).includes(v);

/** A page as a recipe judges it: where it is, and every word on it, controls included. */
interface SitePage { url: string; text: string }

interface SiteRecipe {
  id: SiteId;
  label: string;
  hosts: string[];
  /** The page that resolves to the user's own profile. */
  start: string;
  /** Further pages of the same own profile, read after the first; may be empty. */
  more(profileUrl: string): string[];
  signedOut(page: SitePage): boolean;
  /** Markers that this is the viewer's own profile. A page that does not show them is never kept. */
  own(page: SitePage): boolean;
  /** Drop navigation, ads, "People also viewed", recommendations, endorsements, messaging. */
  clean(text: string): string;
  /** The profile's own address, such as LinkedIn's /in/<name>/, for the linkedin fact and the further pages. */
  profileUrl?(page: { url: string }): string | null;
}

export type ImportStatus = 'imported' | 'signed_out' | 'challenge' | 'not_recognised' | 'empty' | 'failed';
interface ImportResult { status: ImportStatus; documentId?: string; pages: number; chars: number; message: string }

/** What a person reads about a reading. */
export const COPY = {
  imported: 'Read {pages} page(s) and {chars} characters from your {site} profile. Fanfold is adding it to your profile.',
  importedAgent: 'Read {pages} page(s) and {chars} characters from your {site} profile. It will not be used to answer for you until you confirm it is yours.',
  signedOut: 'You are not signed in to {site} in Fanfold\'s window, so nothing was read. Sign in there, then try again.',
  challenge: '{site} showed a security check ("{evidence}"), so Fanfold stopped and kept nothing. Fanfold cannot answer these. You can complete it in Fanfold\'s window, then try again.',
  notRecognised: 'Fanfold did not recognize {url} as your {site} profile, so it kept nothing. {site} may have changed its pages.',
  notOwn: '{url} does not look like your {site} profile. It belongs to someone else, so Fanfold did not save anything.',
  empty: 'Your {site} profile page had no text Fanfold could save.',
  failed: 'Could not read your {site} profile: {reason}',
  running: 'Fanfold is already reading your {site} profile.',
  noWindow: 'Fanfold\'s browser has no visible window, and it only reads your profile in a window you can watch.',
  reading: 'Reading page {page} of {of} of your {site} profile…',
  exportImported: 'Read LinkedIn\'s export: {roles} job(s), {studies} stud(ies), {skills} skill(s), {certifications} certification(s), {languages} language(s).',
  exportTooBig: 'That file is larger than 50 MB, which is more than a LinkedIn profile export. Nothing was imported.',
  exportNotZip: 'That is not a zip file. Use the zip LinkedIn sends from "Get a copy of your data".',
  exportEmpty: 'That zip file is empty. Use the zip LinkedIn sends from "Get a copy of your data".',
  exportNoProfile: 'That zip file is missing Profile.csv, so it is not a LinkedIn data export. Nothing was imported.',
  exportNotYou: 'That export is for {name}, not {you}, so nothing was imported.',
};

/** Pages one reading may load, the first included. */
const MAX_PAGES = 8;
/** Characters kept from one page, and from one reading. */
const PAGE_CHARS = 40_000;
const READING_CHARS = 150_000;
/** Less than this, once cleaned, is a page with nothing of the owner's on it. */
const MIN_CHARS = 60;

// ------------------------------------------------------------- recipes

const pathOf = (url: string): string => { try { return new URL(url).pathname; } catch { return ''; } };
const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ''; } };

/**
 * Text cleaned by its headings and lines: what comes before the first
 * heading is the site's own bar; a section whose heading matches `drop` is
 * left out down to the next heading as high as its own; a line, or a part of
 * one between " | " or " · ", matching `junk` is left out; words matching
 * `strip` are cut from inside a line, as a list entry read whole holds its
 * buttons and others' endorsements. Headings come marked with "#" (one per
 * level) and leave as plain lines.
 */
function cleaner(drop: RegExp, junk: RegExp, strip: RegExp[] = []): (text: string) => string {
  const stripped = (line: string): string => strip.reduce((l, re) => l.replace(re, ' '), line).replace(/(?:\s*·)+\s*$|^\s*·\s*/g, '').replace(/\s+(·\s+)+/g, ' · ').replace(/\s{2,}/g, ' ').trim();
  return (text) => {
    const out: string[] = [];
    let dropping: number | null = null;
    const lines = text.split('\n');
    const first = lines.findIndex((l) => /^#{1,6} /.test(l));
    for (const line of first > 0 ? lines.slice(first) : lines) {
      const heading = /^(#{1,6}) (.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        if (dropping !== null && level > dropping) continue;
        dropping = drop.test(heading[2].trim()) ? level : null;
        if (dropping === null && !junk.test(heading[2].trim())) out.push('', heading[2].trim());
        continue;
      }
      if (dropping !== null) continue;
      const kept = stripped(line).split(' | ')
        .map((part) => part.split(' · ').map((p) => p.trim()).filter((p) => p && !junk.test(p)).join(' · '))
        .filter(Boolean).join(' | ');
      if (kept && kept !== out[out.length - 1]) out.push(kept);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };
}

/** Words every site uses for its own controls and promotions, never the owner's. */
const COMMON_JUNK = String.raw`edit|add|save|cancel|delete|remove|update|upload|view|more|show more|show less|see more|see less|…\s*more|…\s*see more|read more|promoted|sponsored|ad|advertisement|ad options|close|dismiss|share|copy link|\d+ yrs?(?: \d+ mos?)?|\d+ mos?`;
const junkOf = (extra: string): RegExp => new RegExp(String.raw`^(?:${COMMON_JUNK}|${extra})$`, 'i');

/** LinkedIn's main profile shows the viewer these only on their own: the controls to change it, and what is private to them. */
const LI_OWN = /\b(?:add profile section|enhance profile|edit intro|private to you|open to work preferences|add section)\b/i;
/** Its details pages show the viewer controls to add to or change their own entries. */
const LI_OWN_DETAILS = /\b(?:(?:add|edit)(?: new)? (?:position|experience|education|skills?|certifications?|licen[cs]es?(?: (?:&|and) certifications?)?|languages?)|private to you)\b/i;

/**
 * One row per site: a changed address is a one-line fix. These addresses and
 * markers are unverified against the live sites, which is why a page must
 * show its own markers before anything on it is kept.
 */
export function siteRecipes(origins: Record<SiteId, string> = SITE_ORIGINS): Record<SiteId, SiteRecipe> {
  const o = origins;
  const signIn = (p: SitePage): boolean => /\b(?:sign in|log ?in)\b/i.test(p.text) && /\b(?:password|forgot|continue with google|create (?:an )?account|join now|register)\b/i.test(p.text);
  return {
    linkedin: {
      id: 'linkedin', label: 'LinkedIn', hosts: [hostOf(o.linkedin), hostOf(o.linkedin).replace(/^www\./, '')],
      start: `${o.linkedin}/in/me/`,
      more: (profile) => ['experience', 'education', 'skills', 'certifications', 'languages'].map((s) => `${profile}details/${s}/`),
      signedOut: (p) => /^\/(?:login|uas\/login|authwall|signup|checkpoint\/lg)\b/i.test(pathOf(p.url)) || (/\bjoin now\b/i.test(p.text) && signIn(p)),
      own: (p) => {
        const at = /^\/in\/([^/]+)\/(?:details\/[a-z-]+\/)?$/i.exec(pathOf(p.url));
        if (!at || at[1].toLowerCase() === 'me') return false;
        return pathOf(p.url).includes('/details/') ? LI_OWN_DETAILS.test(p.text) : LI_OWN.test(p.text);
      },
      profileUrl: (p) => {
        const at = /^\/in\/([^/]+)\//i.exec(pathOf(p.url));
        return at && at[1].toLowerCase() !== 'me' ? `${originOf(p.url)}/in/${at[1]}/` : null;
      },
      clean: cleaner(
        /^(?:people also viewed|people you may know|more profiles for you|explore premium profiles|you might like|pages for you|people also follow|other similar profiles|who your viewers also viewed|recommendations|activity|interests|top voices|companies|groups|newsletters|schools|causes|featured|analytics|resources|messaging|notifications|suggested for you|learning|profile language|public profile (?:&|and) url|ad options|promoted)\b/i,
        junkOf(String.raw`message|connect|follow|following|pending|open to|add profile section|enhance profile|resources|private to you|contact info|\d+\+? connections?|\d[\d,]* followers?|endorse|endorsed|\d+ endorsements?|endorsed by\b.*|.*\bendorsements?|.*\bhighly skilled at this|passed linkedin skill assessment|show all\b.*|show credential|see credential|credential id\b.*|(?:1st|2nd|3rd)(?: degree connection)?|\S+ logo|try premium.*|reactivate premium.*`),
        [
          /\bEndorsed by\b.*?(?:highly skilled at this|(?=\s\d+ endorsements?\b)|$)/gi, /\b\d+ endorsements?\b/gi, /\bEndorse\b/g,
          /\bPassed LinkedIn Skill Assessment\b/gi, /\bCredential ID\s+\S+/gi, /\b(?:Show|See) credential\b/gi, /·\s*\d+ yrs?(?: \d+ mos?)?\b|·\s*\d+ mos?\b/g,
        ],
      ),
    },
    naukri: {
      id: 'naukri', label: 'Naukri', hosts: [hostOf(o.naukri), hostOf(o.naukri).replace(/^www\./, '')],
      start: `${o.naukri}/mnjuser/profile`,
      more: () => [],
      signedOut: (p) => /^\/(?:nlogin|login|registration)\b/i.test(pathOf(p.url)) || signIn(p),
      own: (p) => /^\/mnjuser\/profile\b/i.test(pathOf(p.url)) && /\b(?:profile last updated|update resume|upload resume)\b/i.test(p.text),
      clean: cleaner(
        /^(?:recommended jobs|jobs you may (?:be interested in|like)|similar jobs|people also viewed|naukri fast ?forward|resume display|profile performance|search appearances|recruiter actions|quick links|messages|notifications|premium|blogs?)\b/i,
        junkOf(String.raw`verify|add details|missing details|\d+% complete|.*\bprofile completion\b.*|change photo|download|upgrade.*`),
      ),
    },
    instahyre: {
      id: 'instahyre', label: 'Instahyre', hosts: [hostOf(o.instahyre), hostOf(o.instahyre).replace(/^www\./, '')],
      start: `${o.instahyre}/candidate/profile/`,
      more: () => [],
      signedOut: (p) => /^\/(?:login|signup)\b/i.test(pathOf(p.url)) || signIn(p),
      own: (p) => /^\/candidate\/profile\b/i.test(pathOf(p.url)) && /\b(?:my profile|edit profile|profile strength|your resume|upload resume)\b/i.test(p.text),
      clean: cleaner(
        /^(?:jobs for you|recommended|opportunities|companies|messages|notifications|refer(?: and earn| a friend)?|premium)\b/i,
        junkOf(String.raw`verify|upgrade.*|download`),
      ),
    },
    indeed: {
      id: 'indeed', label: 'Indeed', hosts: [hostOf(o.indeed)],
      start: `${o.indeed}/`,
      more: () => [],
      signedOut: (p) => /^secure\./i.test(hostOf(p.url)) || /^\/(?:account\/login|auth)\b/i.test(pathOf(p.url)) || signIn(p),
      own: (p) => /\b(?:job preferences|ready to work|hide my profile|your resume|indeed resume)\b/i.test(p.text),
      clean: cleaner(
        /^(?:jobs for you|recommended jobs|recent searches|company reviews|salary guide|find jobs|messages|notifications)\b/i,
        junkOf(String.raw`download|replace|preview|.*\bvisible to employers\b.*`),
      ),
    },
    wellfound: {
      id: 'wellfound', label: 'Wellfound', hosts: [hostOf(o.wellfound), `www.${hostOf(o.wellfound).replace(/^www\./, '')}`],
      start: `${o.wellfound}/profile/edit/overview`,
      more: () => [],
      signedOut: (p) => /^\/(?:login|join|signup)\b/i.test(pathOf(p.url)) || signIn(p),
      own: (p) => /^\/profile\/edit\b/i.test(pathOf(p.url)) && /\b(?:edit your profile|your profile|view public profile|save changes)\b/i.test(p.text),
      clean: cleaner(
        /^(?:recommended|jobs for you|messages|discover|trending|startups? for you|companies for you)\b/i,
        junkOf(String.raw`save changes|upgrade.*|download`),
      ),
    },
  };
}

/** Where each site lives. Tests point these at fixture pages of their own on *.localhost. */
export const SITE_ORIGINS: Record<SiteId, string> = {
  linkedin: 'https://www.linkedin.com',
  naukri: 'https://www.naukri.com',
  instahyre: 'https://www.instahyre.com',
  indeed: 'https://profile.indeed.com',
  wellfound: 'https://wellfound.com',
};

/** The recipes as the origins now stand. */
export const recipes = (): Record<SiteId, SiteRecipe> => siteRecipes({ ...SITE_ORIGINS });

// --------------------------------------------------------- page to text

/** Parts of a page that are never the owner's profile: menus, side columns, footers, pop-ups, a site's search. */
const LEFT_OUT = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog']);
/** Controls whose words are the site's, not the owner's. Links and filled fields stay: a company name is often a link. */
const CONTROLS = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'checkbox', 'radio', 'option', 'listbox', 'slider', 'spinbutton', 'searchbox', 'img', 'frame']);

/** Containers whose name labels what is in them, said again by their own heading. */
const CONTAINERS = new Set(['region', 'main', 'form', 'list', 'group', 'article', 'table', 'figure']);

const words = (t: string | null | undefined): string => (t ? unwrapUntrustedForDisplay(t as never).replace(/\s+/g, ' ').trim() : '');

/** The end of a node's subtree in the flat list: the next node no deeper than it. */
function subtreeEnd(nodes: ObservedNode[], at: number): number {
  let i = at + 1;
  while (i < nodes.length && nodes[i].depth > nodes[at].depth) i++;
  return i;
}

/**
 * A page read for keeping: `text` is every word on it, controls included,
 * for telling whose page it is; `body` is what the page says, with menus,
 * side columns, pop-ups, frames and controls left out, each list entry on one
 * line with its parts between " | ", and headings marked "#" by level for the
 * recipe's clean.
 */
export function readPage(obs: Observation): SitePage & { body: string } {
  const nodes = obs.nodes;
  const all = [words(obs.title as unknown as string)];
  for (const n of nodes) {
    const said = [words(n.name), words(n.text), words(n.value)].filter(Boolean).join(' ');
    if (said) all.push(said);
  }
  const piece = (n: ObservedNode): string => {
    if (CONTROLS.has(n.role) || (n.state.frame && n.state.frame !== 'shadow')) return '';
    if (CONTAINERS.has(n.role)) return words(n.text);
    if (n.role === 'textbox' || n.role === 'combobox') {
      const value = words(n.value);
      // A label wrapped round a text area also holds what is written in it.
      const label = words(n.name).replace(value, '').trim();
      return value ? [label, value].filter(Boolean).join(': ') : '';
    }
    return words(n.name) || words(n.text);
  };
  const body: string[] = [];
  for (let i = 0; i < nodes.length;) {
    const n = nodes[i];
    const end = subtreeEnd(nodes, i);
    if (LEFT_OUT.has(n.role)) { i = end; continue; }
    if (n.role === 'heading') {
      const said = piece(n);
      if (said) body.push(`${'#'.repeat(Math.min(Math.max(n.state.level ?? 2, 1), 6))} ${said}`);
      i++;
      continue;
    }
    // One entry (a job, a degree, a certificate) is one line, unless it holds entries or headings of its own.
    const inside = nodes.slice(i + 1, end);
    if (n.role === 'listitem' && inside.length && !inside.some((c) => c.role === 'listitem' || c.role === 'heading' || LEFT_OUT.has(c.role))) {
      const parts: string[] = [];
      for (const c of [n, ...inside]) {
        const said = piece(c);
        if (said && !parts.some((p) => p === said || p.includes(said))) parts.push(said);
      }
      if (parts.length) body.push(parts.join(' | '));
      i = end;
      continue;
    }
    const said = piece(n);
    if (said && said !== body[body.length - 1]) body.push(said);
    i++;
  }
  return { url: obs.url, text: all.join('\n'), body: body.join('\n').slice(0, PAGE_CHARS) };
}

// ----------------------------------------------------------- the record

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_imports (
  site        TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  message     TEXT NOT NULL,
  pages       INTEGER NOT NULL DEFAULT 0,
  chars       INTEGER NOT NULL DEFAULT 0,
  document_id TEXT,
  started_by  TEXT NOT NULL,
  at          TEXT NOT NULL
);
`;

export interface LastImport { status: ImportStatus; message: string; pages: number; chars: number; documentId: string | null; startedBy: 'owner' | 'agent'; at: string }
interface Reading { page: number; of: number; startedBy: 'owner' | 'agent'; at: string }

/** How the last reading of each site went, kept; which are being read now, in memory. */
class SiteImports {
  #db: DatabaseSync;
  readonly #reading = new Map<string, Reading>();

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  last(site: string): LastImport | null {
    const r = this.#db.prepare('SELECT * FROM site_imports WHERE site = ?').get(site) as Record<string, unknown> | undefined;
    return r ? {
      status: r.status as ImportStatus, message: String(r.message), pages: Number(r.pages), chars: Number(r.chars),
      documentId: (r.document_id as string) ?? null, startedBy: r.started_by === 'agent' ? 'agent' : 'owner', at: String(r.at),
    } : null;
  }

  record(site: string, r: ImportResult, startedBy: 'owner' | 'agent'): void {
    this.#db.prepare(`
      INSERT INTO site_imports (site, status, message, pages, chars, document_id, started_by, at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(site) DO UPDATE SET status = excluded.status, message = excluded.message, pages = excluded.pages, chars = excluded.chars,
        document_id = excluded.document_id, started_by = excluded.started_by, at = excluded.at
    `).run(site, r.status, r.message, r.pages, r.chars, r.documentId ?? null, startedBy, new Date().toISOString());
  }

  reading(site: string): Reading | null {
    return this.#reading.get(site) ?? null;
  }

  /** False when that site is being read already. */
  begin(site: string, startedBy: 'owner' | 'agent'): boolean {
    if (this.#reading.has(site)) return false;
    this.#reading.set(site, { page: 0, of: 1, startedBy, at: new Date().toISOString() });
    return true;
  }

  step(site: string, page: number, of: number): void {
    const r = this.#reading.get(site);
    if (r) this.#reading.set(site, { ...r, page, of });
  }

  end(site: string): void {
    this.#reading.delete(site);
  }
}

const stores = new WeakMap<DatabaseSync, SiteImports>();
/** One per database, so the Profile page and a host's call see the same readings. */
export function siteImports(db: DatabaseSync): SiteImports {
  let s = stores.get(db);
  if (!s) stores.set(db, s = new SiteImports(db));
  return s;
}

// ----------------------------------------------------------- the reading

export interface ImportDeps {
  memory: Memory;
  profile: Profile;
  careers: CareerRecords;
  imports: SiteImports;
  /** A tab in a window of its own that the owner can watch, held in the tab ledger by `owner` until it is closed. */
  openTab(owner?: Owner): Promise<Tab>;
  /** Shows the reading in Fanfold as a run of its own. */
  openRun?(runId: string, goal: string): void;
  closeRun?(runId: string, ok: boolean, note: string): void;
  bindRun?(runId: string, page: BrowserRuntime): () => void;
  /** Read a stored document into the profile and the career record, and wait for both. */
  fill(documentId: string): Promise<unknown>;
  /** Answer the waiting questions again with what is now known. */
  sweep(): Promise<unknown>;
  emit?(event: { type: string; [k: string]: unknown }): void;
  log?: Pick<Logger, 'warn'>;
  /** Tests point the recipes at fixture pages. */
  recipes?: Record<SiteId, SiteRecipe>;
  /** The pause between two page loads: two to four seconds unless a test says otherwise. */
  gap?(): number;
  /** How long a loaded page may take to show whose it is. */
  settleMs?: number;
  sleep?(ms: number): Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const format = (text: string, values: Record<string, string | number>): string =>
  Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);

/** The same page, give or take a trailing slash, a query or a fragment. */
const samePage = (a: string, b: string | null): boolean => !!b && `${originOf(a)}${pathOf(a).replace(/\/+$/, '')}` === `${originOf(b)}${pathOf(b).replace(/\/+$/, '')}`;

type Seen = SitePage & { body: string; obs: Observation };

/** What a profile page has on any site, whoever it belongs to. */
const PROFILE_SECTIONS = /\b(?:experience|employment|education|skills)\b/i;
/** What a site shows a visitor to someone else's profile, and never on the owner's own. */
const VISITOR_CONTROLS = /\b(?:message|connect|follow)\b/i;

/**
 * A person's profile, on any site, that is not the owner's: the sections a
 * profile has, with the controls a visitor gets or a name that is not theirs.
 */
export function someoneElses(page: SitePage, owner: string | null | undefined): boolean {
  if (!PROFILE_SECTIONS.test(page.text)) return false;
  if (VISITOR_CONTROLS.test(page.text)) return true;
  const name = owner?.trim();
  return !!name && !whoseText(name, page.text).startsWith('names ');
}

/** Look until the page shows whose it is, a sign-in, a check, or stops changing. */
async function settle(page: BrowserRuntime, recipe: SiteRecipe, ms: number, sleep: (ms: number) => Promise<void>): Promise<Seen> {
  const until = Date.now() + ms;
  let before = '';
  for (;;) {
    const obs = await page.observe();
    const seen = { ...readPage(obs), obs };
    const decided = detectChallenge(obs) || recipe.signedOut(seen) || recipe.own(seen);
    if (decided || Date.now() >= until || (!obs.loading && seen.text === before)) return seen;
    before = seen.text;
    await sleep(500);
  }
}

/**
 * Read the owner's own profile on one site into a text-only document, then
 * into the profile, the career record and the waiting questions. Never
 * throws; the result says what happened in words for the owner. An owner's
 * reading is theirs at once; a host's waits for the owner to say so.
 */
export async function importSiteProfile(deps: ImportDeps, siteId: SiteId, opts: { startedBy: 'owner' | 'agent'; by?: string }): Promise<ImportResult> {
  const recipe = (deps.recipes ?? recipes())[siteId];
  if (!recipe) return { status: 'failed', pages: 0, chars: 0, message: format(COPY.failed, { site: siteId, reason: 'no such site' }) };
  const site = recipe.label;
  if (!deps.imports.begin(siteId, opts.startedBy)) return { status: 'failed', pages: 0, chars: 0, message: format(COPY.running, { site }) };
  const sleep = deps.sleep ?? wait;
  const runId = randomUUID();
  let loads = 0;
  let result: ImportResult = { status: 'failed', pages: 0, chars: 0, message: format(COPY.failed, { site, reason: 'it stopped early' }) };
  let tab: Tab | null = null;
  let unbind: (() => void) | undefined;
  try {
    deps.openRun?.(runId, `Read your own ${site} profile`);
    deps.emit?.({ type: 'site_import', site: siteId, state: 'reading', page: 0, of: 1, message: format(COPY.reading, { page: 1, of: 1, site }) });
    // Owner kind 'import': the tab ledger claims this tab here, and releases it where it is closed below.
    tab = await deps.openTab({ kind: 'import', id: runId });
    unbind = deps.bindRun?.(runId, tab.page);
    await tab.page.focus?.().catch(() => {});

    const kept: string[] = [];
    const queue = [recipe.start];
    let profileUrl: string | null = null;
    for (let i = 0; i < queue.length && loads < MAX_PAGES; i++) {
      if (loads) await sleep(deps.gap?.() ?? 2_000 + Math.random() * 2_000);
      loads++;
      deps.imports.step(siteId, loads, queue.length);
      deps.emit?.({ type: 'site_import', site: siteId, state: 'reading', page: loads, of: queue.length, message: format(COPY.reading, { page: loads, of: queue.length, site }) });
      await tab.page.goto(queue[i]);
      const seen = await settle(tab.page, recipe, deps.settleMs ?? 8_000, sleep);
      const challenge = detectChallenge(seen.obs);
      const own = !challenge && recipe.hosts.includes(hostOf(seen.url)) && recipe.own(seen);
      // The owner's own page is never a sign-in page, whatever words a menu on it uses.
      if (challenge?.reason === 'signin' || (!own && recipe.signedOut(seen))) {
        result = { status: 'signed_out', pages: loads, chars: 0, message: format(COPY.signedOut, { site }) };
        return result;
      }
      if (challenge) {
        result = { status: 'challenge', pages: loads, chars: 0, message: format(COPY.challenge, { site, evidence: challenge.evidence.slice(0, 80) }) };
        return result;
      }
      // A details page with nothing in it may send the browser back to the profile itself: nothing more to read there.
      if (i > 0 && samePage(seen.url, profileUrl)) continue;
      if (!own || (i > 0 && !samePage(seen.url, queue[i]))) {
        // Someone else's profile is said as that on every site; "may have changed its pages" is for a page it does not know.
        const theirs = !own && recipe.hosts.includes(hostOf(seen.url)) && someoneElses(seen, deps.profile.fact('name')?.value);
        result = { status: 'not_recognised', pages: loads, chars: 0, message: format(theirs ? COPY.notOwn : COPY.notRecognised, { site, url: seen.url }) };
        return result;
      }
      if (i === 0) {
        profileUrl = recipe.profileUrl?.(seen) ?? null;
        queue.push(...recipe.more(profileUrl ?? seen.url).slice(0, MAX_PAGES - 1));
      }
      kept.push(recipe.clean(seen.body));
    }

    const body = kept.filter(Boolean).join('\n\n').slice(0, READING_CHARS);
    if (body.replace(/\s+/g, '').length < MIN_CHARS) {
      result = { status: 'empty', pages: loads, chars: 0, message: format(COPY.empty, { site }) };
      return result;
    }
    const title = `${site} profile`;
    const text = [title, profileUrl ? `${site}: ${profileUrl}` : `Read from ${recipe.start}`, '', body].join('\n');
    const trusted = opts.startedBy === 'owner';
    const previous = deps.memory.documentsFrom(`site:${siteId}`);
    const documentId = deps.memory.addDocument({
      title, text, sourcePath: `site:${siteId}`, mime: 'text/plain', kind: 'site',
      importedBy: trusted ? null : `agent:${opts.by || 'an outside agent'}`,
    });
    for (const old of previous) {
      deps.memory.deleteDocument(old);
      deps.profile.forgetDocument(old);
      deps.careers.delete(old);
    }
    if (siteId === 'linkedin' && profileUrl) {
      deps.profile.set({ linkedin: profileUrl }, { confirmed: false, source: trusted ? 'document' : 'extract', basis: { documentId, title } });
    }
    result = {
      status: 'imported', documentId, pages: loads, chars: body.length,
      message: format(trusted ? COPY.imported : COPY.importedAgent, { pages: kept.length, site, chars: body.length.toLocaleString('en') }),
    };
    return result;
  } catch (err) {
    result = { status: 'failed', pages: loads, chars: 0, message: format(COPY.failed, { site, reason: (err as Error).message || String(err) }) };
    return result;
  } finally {
    unbind?.();
    // Every outcome closes the window it opened.
    await tab?.close().catch(() => {});
    deps.closeRun?.(runId, result.status === 'imported', result.message);
    deps.imports.record(siteId, result, opts.startedBy);
    deps.imports.end(siteId);
    deps.emit?.({ type: 'site_import', site: siteId, state: 'finished', status: result.status, message: result.message, documentId: result.documentId ?? null });
    if (result.documentId) {
      try {
        await deps.fill(result.documentId);
        await deps.sweep();
      } catch (err) {
        deps.log?.warn('could not read an imported profile into the profile', { err, site: siteId });
      }
    }
  }
}

/** What a reading needs from the app: a window the owner can watch, paced and watched like any run's. */
export function importDeps(app: App): ImportDeps {
  return {
    memory: app.memory, profile: app.profile, careers: app.careers, imports: siteImports(app.db), log: app.log,
    openTab: async (owner) => {
      if (app.headless) throw new Error(COPY.noWindow);
      const page = await app.startBrowser();
      if (!page.openTab) throw new Error('this browser cannot open a window of its own');
      // Held by the import from before the tab exists until it closes: the janitor closes it if the import dies.
      const tab = await page.openTab({ window: true, owner });
      return { page: guardRun(tab.page, { sites: app.sites, log: app.log }), close: () => tab.close() };
    },
    openRun: (id, goal) => app.store.openRun(id, goal),
    closeRun: (id, ok, note) => app.store.closeRun(id, ok ? 'done' : 'failed', ok ? note : undefined, ok ? undefined : note),
    bindRun: (id, page) => app.bindRun(id, page),
    fill: async (id) => { await app.fillProfileFrom(id); await app.profileFilled(); },
    sweep: () => app.resolveQuestions(),
    emit: (e) => app.emit(e),
  };
}

// --------------------------------------------- LinkedIn's own data export

export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
/** The files read from the export; messages, connections, recommendations and the rest are never opened. */
const EXPORT_FILES = { Profile: 'First Name', Positions: 'Company Name', Education: 'School Name', Skills: 'Name', Certifications: 'Name', Languages: 'Name' } as const;
const MAX_ROWS = 400;
const MAX_CELL = 4_000;

/** RFC 4180 rows: quoted fields may hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** A CSV's rows by column name, from the header that names `key`; LinkedIn puts notes above some headers. */
function rowsOf(csv: string, key: string): Array<Record<string, string>> {
  const rows = parseCsv(csv);
  const at = rows.findIndex((r) => r.some((c) => c.trim() === key));
  if (at < 0) return [];
  const header = rows[at].map((c) => c.trim());
  return rows.slice(at + 1, at + 1 + MAX_ROWS)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').slice(0, MAX_CELL)])));
}

type ExportResult =
  | { ok: true; documentId: string; message: string; counts: { roles: number; studies: number; skills: number; certifications: number; languages: number } }
  | { ok: false; status: 400 | 413 | 422; message: string };

/**
 * LinkedIn's export, which the owner chose to give: one text document "LinkedIn
 * export" replacing any earlier one, and its career record built from the
 * columns with no model. The profile takes the name, place and links it
 * states where it has none.
 */
export async function importLinkedInExport(
  deps: Pick<ImportDeps, 'memory' | 'profile' | 'careers' | 'imports' | 'sweep' | 'emit' | 'log'>,
  zip: Buffer,
): Promise<ExportResult> {
  const refuse = (status: 400 | 413 | 422, message: string): ExportResult => {
    deps.imports.record('linkedin_export', { status: 'failed', pages: 0, chars: 0, message }, 'owner');
    return { ok: false, status, message };
  };
  if (zip.length > MAX_EXPORT_BYTES) return refuse(413, COPY.exportTooBig);
  // A zip with nothing in it starts with its directory's end: a zip, just an empty one.
  if (zip.length >= 22 && zip.readUInt32LE(0) === 0x06054b50) return refuse(422, COPY.exportEmpty);
  if (!isZip(zip)) return refuse(400, COPY.exportNotZip);
  const files: LinkedInExport = {};
  try {
    for (const [file, key] of Object.entries(EXPORT_FILES) as Array<[keyof typeof EXPORT_FILES, string]>) {
      const bytes = readZipEntry(zip, `${file}.csv`);
      if (bytes) files[file] = rowsOf(bytes.toString('utf8'), key);
    }
  } catch (err) {
    return refuse(400, format(COPY.failed, { site: 'LinkedIn', reason: (err as Error).message }));
  }
  if (!files.Profile) return refuse(422, COPY.exportNoProfile);
  const read = fromLinkedInExport(files);
  const you = deps.profile.fact('name')?.value?.trim();
  const same = (a: string, b: string): boolean => whoseText(a, b).startsWith('names ');
  if (you && read.name && !same(you, read.name) && !same(read.name, you)) return refuse(422, format(COPY.exportNotYou, { name: read.name, you }));

  const title = 'LinkedIn export';
  const previous = deps.memory.documentsFrom('export:linkedin');
  const documentId = deps.memory.addDocument({ title, text: read.text, sourcePath: 'export:linkedin', mime: 'text/plain', kind: 'export' });
  for (const old of previous) {
    deps.memory.deleteDocument(old);
    deps.profile.forgetDocument(old);
    deps.careers.delete(old);
  }
  const text = (await deps.memory.documentText(documentId)) ?? read.text;
  const record = read.record(documentId);
  // Built from the columns, so no model read it: the same text is never read again by one.
  deps.careers.put(documentId, sha256(text), record, null);
  // Contact details by pattern alone; then the name and place the export states, where the profile has none.
  await fillProfile({ memory: deps.memory, profile: deps.profile, model: null }, documentId).catch(() => null);
  const basis = { documentId, title };
  for (const [field, value] of [['name', read.name], ['location', read.location]] as const) {
    if (value && !deps.profile.fact(field) && appearsIn(value, text)) deps.profile.set({ [field]: value }, { confirmed: false, source: 'document', basis });
  }
  const counts = {
    roles: record.roles.length, studies: record.education.length, skills: record.skills.length,
    certifications: record.certifications.length, languages: record.languages.length,
  };
  const message = format(COPY.exportImported, counts);
  deps.imports.record('linkedin_export', { status: 'imported', documentId, pages: 0, chars: read.text.length, message }, 'owner');
  deps.emit?.({ type: 'profile_changed' });
  await deps.sweep().catch((err: unknown) => deps.log?.warn('could not answer waiting questions after the LinkedIn export', { err }));
  return { ok: true, documentId, message, counts };
}
