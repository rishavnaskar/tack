/**
 * Where the person may work, and whether they need visa sponsorship there:
 * one entry per country, each a country and a status picked from fixed
 * lists, never free text. Every answer a form gets about it (authorised to
 * work, sponsorship, visa status, citizenship) is worked out here, in code,
 * for the one country the question or the job is about.
 *
 * An entry the person set is theirs. What an agent or a document proposed,
 * and an old sentence that could not be read into a choice, waits "to
 * confirm" and answers nothing until they pick.
 */
import type { DatabaseSync } from 'node:sqlite';
import { countriesIn, countryNamed, COUNTRY_LIST, FREE_MOVEMENT, FREE_MOVEMENT_AREA } from './countries.ts';
import { meaningOf } from './fact-questions.ts';
import { folded } from './wording.ts';

export const RIGHTS_STATUSES = ['citizen', 'permanent', 'employer_visa', 'open_permit', 'student', 'free_movement', 'refugee', 'not_authorised', 'other'] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];
export const SPONSORSHIP_VALUES = ['no', 'future', 'now'] as const;
export type Sponsorship = (typeof SPONSORSHIP_VALUES)[number];
export const ELSEWHERE_VALUES = ['need', 'skip'] as const;
export type Elsewhere = (typeof ELSEWHERE_VALUES)[number];

export interface RightsEntry {
  id: string;
  /** The kept name of the country, or "European Union" for the free movement area; empty only on an old sentence to confirm. */
  country: string;
  status: RightsStatus;
  /** "2027-06": the last month it holds. */
  validUntil: string | null;
  note: string | null;
  /** Null until said, for a status that implies none. */
  sponsorship: Sponsorship | null;
  /** The person set it. False: proposed, or read from an old sentence, and waiting for them to pick. */
  confirmed: boolean;
  /** 'you', 'you, in <app>', 'agent', 'extract' (a document), 'earlier' (what they wrote before choices). */
  source: string;
  /** The words it was read from, when it was. */
  was?: string;
  documentId?: string;
  updatedAt: string;
}

export interface RightsState {
  entries: RightsEntry[];
  /** For every country without an entry. Null until the person picks one. */
  elsewhere: { value: Elsewhere; source: string; updatedAt: string } | null;
  /** What they wrote about sponsorship before choices, kept until they pick. */
  earlierSponsorship: string | null;
}

/** What the person picks in, and how their pick reads. */
export const COPY = {
  status: {
    citizen: 'Citizen',
    permanent: 'Permanent resident',
    employer_visa: 'Work visa or permit tied to an employer',
    open_permit: 'Work permit not tied to an employer',
    student: 'Student visa with work rights',
    free_movement: 'Free movement or treaty right',
    refugee: 'Refugee or asylum status',
    not_authorised: 'Not authorised: I would need sponsorship',
    other: 'Other',
  } satisfies Record<RightsStatus, string>,
  statusHint: {
    citizen: '',
    permanent: 'green card, PR, ILR, settled status',
    employer_visa: 'H-1B, Skilled Worker, Blue Card, employment pass and the like',
    open_permit: 'open work permit, dependant or spouse permit, EAD, post-study work visa',
    student: 'limited hours, OPT/CPT and the like',
    free_movement: 'EU/EEA/Swiss citizen in another member state, TN, E-3, Trans-Tasman and the like',
    refugee: 'refugee, asylee, humanitarian protection',
    not_authorised: '',
    other: 'say what it is in the note',
  } satisfies Record<RightsStatus, string>,
  sponsorship: { no: 'No, never needed', future: 'Not now, but I will in future', now: 'Yes, I need it now' } satisfies Record<Sponsorship, string>,
  sponsorshipToChange: 'Yes, to change employer',
  elsewhere: { need: 'Anywhere else: I would need sponsorship', skip: 'I prefer not to apply where I’d need it' } satisfies Record<Elsewhere, string>,
  freeMovementArea: 'EU, EEA and Switzerland',
  notSaid: 'not said yet',

  // Beside a field on Setup and Profile.
  noCountry: 'Pick a country.',
  unknownCountry: '“{value}” isn’t a country Fanfold knows. Pick one from the list.',
  twice: '{country} is listed twice. Keep one entry for it.',
  noStatus: 'Pick your status in {country}.',
  noNote: 'Say in a few words what your status is in {country}.',
  areaStatus: 'For the EU, EEA and Switzerland, pick Free movement or treaty right, or add the country itself.',
  badMonth: 'Give the month and year it runs until, like 06/2027.',
  pastMonth: '{month} has already passed. Change the date, or the status if it has ended.',
  noSponsorship: 'Say whether you’ll need sponsorship in {country}.',
  tooLong: 'That’s too long. Keep it under {max} characters.',
  tooMany: 'That’s more countries than Fanfold keeps. Keep it to {max}.',

  // A sentence where a choice is wanted (an API caller, an agent).
  notRights: '{value} doesn’t say a country and a status. Pick them under Where you can work on Profile, or write it like “India: Citizen”.',
  notSponsorship: '{value} doesn’t say whether you need sponsorship. Write it for a country, like “India: No” or “United States: In future”.',

  // Why a question waits on Review.
  expired: 'Your {status} in {country} ran until {month}. Check it under Where you can work on Profile.',
  pending: 'What you wrote about {country} isn’t confirmed yet. Pick a status for it under Where you can work on Profile.',
  otherSays: 'Your status in {country} is “{note}”, which doesn’t answer this.',
  sponsorshipUnsaid: 'You haven’t said whether you’ll need sponsorship in {country}.',
  earlierSponsorship: 'You wrote “{text}” about sponsorship before. Pick an answer for each country under Where you can work on Profile.',
  noOption: 'None of the form’s choices fits your status in {country}: {status}.',
  manyOptions: 'More than one of the form’s choices fits your status in {country}: {options}.',
  noJobCountry: 'Fanfold doesn’t know which country this job is in.',
  severalCountries: 'This asks about more than one country.',

  // What an answer rests on, shown beside it.
  says: 'your profile says {country}: {words}',
  saysSponsorship: 'your profile says {country}: sponsorship {words}',
  saysElsewhere: 'your profile says {words}',
  saysCitizen: 'your profile lists you as a citizen of {countries}',
  saysThrough: 'your profile says you’re a citizen of {home}, so you can work in {country}',
  from: 'the profile\'s work authorisation for {country}',
  fromElsewhere: 'the profile\'s answer for anywhere else',

  // In a form's box.
  formStatus: {
    citizen: 'Citizen of {country}',
    permanent: 'Permanent resident of {country}',
    employer_visa: 'Work visa tied to an employer',
    open_permit: 'Work permit not tied to an employer',
    student: 'Student visa with work rights',
    free_movement: 'Free movement or treaty right to work in {country}',
    refugee: 'Refugee or asylum status',
    not_authorised: 'Not authorised to work in {country} without sponsorship',
    other: '{note}',
  } satisfies Record<RightsStatus, string>,
  validUntil: ', valid until {month}',
  andJoin: ' and ',
};

/** What a status implies: may they work there, does it end, and what sponsorship it means unless they say. */
const IMPLIES: Record<RightsStatus, { authorised: boolean | null; expires: boolean; sponsorship: Sponsorship | null }> = {
  citizen: { authorised: true, expires: false, sponsorship: 'no' },
  permanent: { authorised: true, expires: false, sponsorship: 'no' },
  employer_visa: { authorised: true, expires: true, sponsorship: 'now' },
  open_permit: { authorised: true, expires: true, sponsorship: null },
  student: { authorised: true, expires: true, sponsorship: null },
  free_movement: { authorised: true, expires: true, sponsorship: 'no' },
  refugee: { authorised: true, expires: true, sponsorship: 'no' },
  not_authorised: { authorised: false, expires: false, sponsorship: 'now' },
  other: { authorised: null, expires: true, sponsorship: null },
};

export const statusExpires = (s: RightsStatus): boolean => IMPLIES[s].expires;
export const defaultSponsorship = (s: RightsStatus): Sponsorship | null => IMPLIES[s].sponsorship;

/** How the sponsorship choice reads for this status: an employer-tied visa needs it to change employer. */
export function sponsorshipWords(value: Sponsorship, status?: RightsStatus): string {
  return value === 'now' && status === 'employer_visa' ? COPY.sponsorshipToChange : COPY.sponsorship[value];
}

const MAX_NOTE = 120;
const MAX_ENTRIES = 20;
const SETTING = 'profile.workRights';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2027-06" as a person reads it: "June 2027". */
export function monthWords(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : ym;
}

const thisMonth = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const expired = (e: Pick<RightsEntry, 'validUntil'>, now: Date): boolean => !!e.validUntil && e.validUntil < thisMonth(now);
const placeName = (country: string): string => (country === FREE_MOVEMENT ? COPY.freeMovementArea : country);

/** Names said with "the" in a sentence: "in the United States". */
export const WITH_THE: ReadonlySet<string> = new Set([
  'United States', 'United Kingdom', 'Netherlands', 'Philippines', 'United Arab Emirates', 'Bahamas', 'Gambia', 'Maldives', 'Marshall Islands',
  'Solomon Islands', 'Central African Republic', 'Dominican Republic', 'Democratic Republic of the Congo', 'Republic of the Congo', FREE_MOVEMENT,
]);

/** A country as a sentence says it: "the United States", "India", "the EU, EEA and Switzerland". */
export function countryWords(country: string): string {
  return `${WITH_THE.has(country) ? 'the ' : ''}${placeName(country)}`;
}

/** The status as a sentence part, with its note and end: "Work visa or permit tied to an employer (H-1B), valid until June 2027". */
export function entryWords(e: Pick<RightsEntry, 'status' | 'note' | 'validUntil'>): string {
  const base = e.status === 'other' && e.note ? `${COPY.status.other}: ${e.note}` : `${COPY.status[e.status]}${e.note ? ` (${e.note})` : ''}`;
  return base + (e.validUntil ? COPY.validUntil.replace('{month}', monthWords(e.validUntil)) : '');
}

/** A country and what the person picked for it. */
export type EntryChoice = Pick<RightsEntry, 'country' | 'status' | 'note' | 'validUntil' | 'sponsorship'>;

/** One entry as a line: "India: Citizen. Sponsorship: No, never needed." */
export function entryLine(e: EntryChoice): string {
  const s = e.sponsorship ?? defaultSponsorship(e.status);
  return `${placeName(e.country) || '?'}: ${entryWords(e)}. Sponsorship: ${s ? sponsorshipWords(s, e.status) : COPY.notSaid}.`;
}

/** One line per entry, then anywhere else: what the profile page, a host and a model read. */
export function rightsLines(state: RightsState, opts: { confirmedOnly?: boolean } = {}): string[] {
  const lines = state.entries.filter((e) => e.confirmed || !opts.confirmedOnly).map(entryLine);
  if (state.elsewhere) lines.push(`${COPY.elsewhere[state.elsewhere.value]}.`);
  return lines;
}

// ---------------------------------------------------------------- input

export interface EntryInput {
  id?: string;
  country?: string;
  status?: string;
  validUntil?: string | null;
  note?: string | null;
  sponsorship?: string | null;
}

/** "06/2027", "2027-06", "June 2027" as "2027-06"; null when it is not a month and year. */
export function monthOf(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
  m = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec(t);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${m[1].padStart(2, '0')}` : null;
  m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (m) {
    const at = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m![1].toLowerCase().slice(0, 3)));
    return at >= 0 ? `${m[2]}-${String(at + 1).padStart(2, '0')}` : null;
  }
  return null;
}

/**
 * Why each part of these entries cannot be saved, keyed "entries.0.country",
 * "entries.1.sponsorship" and so on; empty when all of it can.
 */
export function rightsProblems(entries: EntryInput[], now = new Date()): Record<string, string> {
  const out: Record<string, string> = {};
  if (entries.length > MAX_ENTRIES) out['entries'] = COPY.tooMany.replace('{max}', String(MAX_ENTRIES));
  const seen = new Map<string, number>();
  entries.forEach((e, i) => {
    const at = (field: string, why: string): void => { out[`entries.${i}.${field}`] ??= why; };
    const typed = String(e.country ?? '').trim();
    const country = typed ? countryNamed(typed) : null;
    if (!typed) at('country', COPY.noCountry);
    else if (!country) at('country', COPY.unknownCountry.replace('{value}', typed.length > 40 ? `${typed.slice(0, 37)}…` : typed));
    else if (seen.has(country)) at('country', COPY.twice.replace('{country}', countryWords(country).replace(/^the /, 'The ')));
    if (country) seen.set(country, i);
    // Said for the country once it is one on the list; until then, plainly.
    const named = (copy: string): string => (country ? copy.replace('{country}', countryWords(country)) : copy.replace(' in {country}', ''));
    const status = RIGHTS_STATUSES.find((s) => s === e.status);
    if (!status) { at('status', named(COPY.noStatus)); return; }
    if (country === FREE_MOVEMENT && status !== 'free_movement') at('status', COPY.areaStatus);
    const note = String(e.note ?? '').trim();
    if (note.length > MAX_NOTE) at('note', COPY.tooLong.replace('{max}', String(MAX_NOTE)));
    if (status === 'other' && !note) at('note', named(COPY.noNote));
    const until = String(e.validUntil ?? '').trim();
    if (until && statusExpires(status)) {
      const month = monthOf(until);
      if (!month) at('validUntil', COPY.badMonth);
      else if (month < thisMonth(now)) at('validUntil', COPY.pastMonth.replace('{month}', monthWords(month)));
    }
    const s = e.sponsorship ? SPONSORSHIP_VALUES.find((x) => x === e.sponsorship) : null;
    if (!s && !defaultSponsorship(status)) at('sponsorship', named(COPY.noSponsorship));
  });
  return out;
}

/** Entries as they are kept, once rightsProblems found nothing wrong with them. */
function tidyEntry(e: EntryInput, by: { source: string; confirmed: boolean; was?: string; documentId?: string }, at: string): RightsEntry {
  const status = RIGHTS_STATUSES.find((s) => s === e.status) ?? 'other';
  const until = statusExpires(status) && e.validUntil ? monthOf(String(e.validUntil)) : null;
  const note = String(e.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) || null;
  const sponsorship = (e.sponsorship ? SPONSORSHIP_VALUES.find((x) => x === e.sponsorship) : null) ?? defaultSponsorship(status);
  return {
    id: e.id && /^[\w-]{1,40}$/.test(e.id) ? e.id : newId(),
    country: countryNamed(String(e.country ?? '')) ?? '', status, validUntil: until, note, sponsorship,
    confirmed: by.confirmed, source: by.source, ...(by.was ? { was: by.was } : {}), ...(by.documentId ? { documentId: by.documentId } : {}), updatedAt: at,
  };
}

let counter = 0;
const newId = (): string => `wr${Date.now().toString(36)}${(counter++).toString(36)}`;

// ---------------------------------------------------------------- store

/** The entries, kept in the profile's own database. */
export class WorkRights {
  #db: DatabaseSync;
  #changed: () => void;
  /** Set on the start that moved old sentences into entries: what each became, for the log. Empty on every later start. */
  readonly migrated: Array<{ field: string; entries: number; toConfirm: number }> = [];

  constructor(db: DatabaseSync, changed: () => void = () => {}) {
    this.#db = db;
    this.#changed = changed;
    this.#db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  state(): RightsState {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING) as { value: string } | undefined;
    if (!row) return { entries: [], elsewhere: null, earlierSponsorship: null };
    try {
      const v = JSON.parse(row.value) as Partial<RightsState>;
      return { entries: Array.isArray(v.entries) ? v.entries : [], elsewhere: v.elsewhere ?? null, earlierSponsorship: v.earlierSponsorship ?? null };
    } catch {
      return { entries: [], elsewhere: null, earlierSponsorship: null };
    }
  }

  #write(state: RightsState): void {
    this.#db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTING, JSON.stringify(state));
    this.#changed();
  }

  /** Whether the person set at least one entry themselves: what setup counts. */
  hasConfirmed(): boolean {
    return this.state().entries.some((e) => e.confirmed && e.country);
  }

  /** The person's whole list, as they saved it: every entry theirs, in their order, and anything to confirm settled by it. */
  save(entries: EntryInput[], elsewhere: Elsewhere | null | undefined, source = 'you'): RightsState {
    const at = new Date().toISOString();
    const before = this.state();
    const kept = entries.map((e) => {
      const old = before.entries.find((x) => x.id === e.id);
      const next = tidyEntry(e, { source, confirmed: true }, at);
      // Unchanged, it keeps when and how it was said.
      return old && old.confirmed && sameEntry(old, next) ? old : next;
    });
    const general = elsewhere === undefined ? before.elsewhere
      : elsewhere ? (before.elsewhere?.value === elsewhere ? before.elsewhere : { value: elsewhere, source, updatedAt: at }) : null;
    const state: RightsState = { entries: kept, elsewhere: general, earlierSponsorship: null };
    this.#write(state);
    return state;
  }

  /** One entry the person gave, in place of any entry for the same country; the rest stay as they are. */
  put(entry: EntryInput, source = 'you', elsewhere?: Elsewhere | null): RightsEntry {
    const at = new Date().toISOString();
    const state = this.state();
    const next = tidyEntry(entry, { source, confirmed: true }, at);
    const i = state.entries.findIndex((x) => x.country === next.country || (entry.id && x.id === entry.id));
    if (i >= 0) state.entries[i] = { ...next, id: state.entries[i].id };
    else state.entries.push(next);
    if (elsewhere) state.elsewhere = state.elsewhere?.value === elsewhere ? state.elsewhere : { value: elsewhere, source, updatedAt: at };
    this.#write(state);
    return i >= 0 ? state.entries[i] : next;
  }

  /** The general answer for every country without an entry. */
  setElsewhere(value: Elsewhere | null, source = 'you'): void {
    const state = this.state();
    state.elsewhere = value ? { value, source, updatedAt: new Date().toISOString() } : null;
    this.#write(state);
  }

  /**
   * Entries proposed by an agent or read from a document: waiting for the
   * person, never in place of one they set, and never answering anything
   * until they confirm it.
   */
  propose(entries: EntryInput[], by: { source: string; was?: string; documentId?: string }): number {
    const state = this.state();
    const at = new Date().toISOString();
    let n = 0;
    for (const e of entries) {
      const next = tidyEntry(e, { ...by, confirmed: false }, at);
      const i = state.entries.findIndex((x) => x.country === next.country && (!!next.country || x.was === next.was));
      if (i >= 0 && state.entries[i].confirmed) continue;
      if (i >= 0 && sameEntry(state.entries[i], next)) continue;
      if (i >= 0) state.entries[i] = { ...next, id: state.entries[i].id };
      else state.entries.push(next);
      n++;
    }
    if (n) this.#write(state);
    return n;
  }

  /**
   * A sentence given where a choice is wanted (Profile.set: an agent's
   * proposal, a document's reading, an API caller). Read into entries when it
   * can be; the person's own sentence is theirs, anyone else's waits for them.
   * False when nothing in it could be read.
   */
  fromText(field: 'workAuthorisation' | 'sponsorship', text: string, by: { confirmed: boolean; source: string; documentId?: string }): boolean {
    const value = text.trim();
    if (field === 'workAuthorisation') {
      const read = readRights(value);
      if (!read.entries.length && !read.elsewhere && !(by.confirmed && read.unread.length)) return false;
      if (by.confirmed) {
        for (const e of read.entries) this.put(e, by.source);
        if (read.elsewhere) this.setElsewhere(read.elsewhere, by.source);
        // What the person wrote that does not read as a choice is kept as they wrote it, for them to pick: never dropped.
        if (read.unread.length) {
          const state = this.state();
          const at = new Date().toISOString();
          for (const u of read.unread) {
            if (state.entries.some((e) => e.was === value && e.note === u.text)) continue;
            state.entries.push(tidyEntry({ country: u.country ?? '', status: 'other', note: u.text }, { source: 'earlier', confirmed: false, was: value }, at));
          }
          this.#write(state);
        }
      } else {
        this.propose(read.entries, { source: by.source, was: value, documentId: by.documentId });
      }
      return true;
    }
    const read = readSponsorship(value);
    const state = this.state();
    const applied = !read.unread.length && applySponsorship(state, read, by.confirmed);
    // The person's own sentence that fits no one entry, or does not read as a choice, is kept as they wrote it, for them to pick from.
    if (!applied && by.confirmed) state.earlierSponsorship = value;
    else if (!applied) return false;
    this.#write(state);
    return true;
  }

  /** Every entry, the general answer and anything to confirm, gone: the person cleared it. */
  clear(field: 'workAuthorisation' | 'sponsorship'): void {
    const state = this.state();
    if (field === 'workAuthorisation') state.entries = [];
    else { state.elsewhere = null; state.earlierSponsorship = null; }
    this.#write(state);
  }

  /** Everything here that came from this document, or only what is still to confirm from it. */
  dropFrom(documentId: string, onlyProposals = false): number {
    const state = this.state();
    const keep = state.entries.filter((e) => e.documentId !== documentId || (onlyProposals && e.confirmed));
    const n = state.entries.length - keep.length;
    if (n) this.#write({ ...state, entries: keep });
    return n;
  }

  /**
   * Once: what the person wrote as a sentence before there were choices
   * becomes entries where it reads plainly, and is kept, to confirm, where it
   * does not. Nothing is dropped.
   */
  migrate(old: { workAuthorisation?: OldFact; sponsorship?: OldFact }): void {
    const state = this.state();
    const at = new Date().toISOString();
    const work = old.workAuthorisation;
    if (work?.value.trim()) {
      const read = readRights(work.value);
      const by = { source: work.confirmed ? 'you' : work.source, confirmed: work.confirmed, was: work.value, ...(work.documentId ? { documentId: work.documentId } : {}) };
      for (const e of read.entries) state.entries.push(tidyEntry(e, by, at));
      if (read.elsewhere && work.confirmed) state.elsewhere = { value: read.elsewhere, source: by.source, updatedAt: at };
      // What could not be read stays, as the person wrote it, for them to pick.
      for (const u of read.unread) {
        state.entries.push(tidyEntry({ country: u.country ?? '', status: 'other', note: u.text }, { source: 'earlier', confirmed: false, was: work.value }, at));
      }
      this.migrated.push({ field: 'workAuthorisation', entries: read.entries.length, toConfirm: read.unread.length });
    }
    const spons = old.sponsorship;
    if (spons?.value.trim()) {
      const read = readSponsorship(spons.value);
      const applied = applySponsorship(state, read, spons.confirmed, true);
      if (!applied || read.unread.length) state.earlierSponsorship = spons.value.trim();
      this.migrated.push({ field: 'sponsorship', entries: applied ? 1 : 0, toConfirm: state.earlierSponsorship ? 1 : 0 });
    }
    if (this.migrated.length) this.#write(state);
  }
}

interface OldFact { value: string; confirmed: boolean; source: string; documentId?: string }

function sameEntry(a: RightsEntry, b: RightsEntry): boolean {
  return a.country === b.country && a.status === b.status && a.validUntil === b.validUntil && a.note === b.note && a.sponsorship === b.sponsorship;
}

/**
 * A sponsorship sentence applied to the entries: each country it names, the
 * general answer, or a bare yes or no for the one entry there is. With
 * `defaults`, a bare answer that contradicts the one entry's status is not
 * applied. False when nothing was.
 */
function applySponsorship(state: RightsState, read: SponsorshipRead, confirmed: boolean, migrating = false): boolean {
  let applied = false;
  const at = new Date().toISOString();
  for (const { country, value } of read.countries) {
    const e = state.entries.find((x) => x.country === country);
    if (!e || (e.confirmed && !confirmed)) continue;
    e.sponsorship = value;
    e.updatedAt = at;
    applied = true;
  }
  if (read.elsewhere && confirmed) {
    state.elsewhere = { value: read.elsewhere, source: 'you', updatedAt: at };
    applied = true;
  }
  if (read.bare) {
    const live = state.entries.filter((e) => e.country);
    const only = live.length === 1 ? live[0] : null;
    const fits = only && (!migrating || !defaultSponsorship(only.status) || (defaultSponsorship(only.status) === 'no') === (read.bare === 'no'));
    if (only && fits && (!only.confirmed || confirmed)) {
      only.sponsorship = read.bare;
      only.updatedAt = at;
      applied = true;
    } else if (!applied) return false;
  }
  return applied;
}

// ---------------------------------------------------------------- reading sentences

/** Words that name a status, and the country a visa's name implies. `named`: the words are the visa's name, kept as the entry's note. */
const STATUS_WORDS: Array<{ status: RightsStatus; re: RegExp; country?: string; named?: boolean }> = [
  { status: 'free_movement', re: /\b(?:eu|eea|european union|swiss) (?:citizen|national)s?\b|\bfree movement\b|\btrans[- ]?tasman\b|\bcommon travel area\b/i },
  { status: 'free_movement', re: /\bTN(?: visa| status)?\b/, country: 'United States', named: true },
  { status: 'free_movement', re: /\bE-?3(?: visa)?\b/, country: 'United States', named: true },
  { status: 'free_movement', re: /\bspecial category visa\b/i, country: 'Australia', named: true },
  { status: 'not_authorised', re: /\b(?:not|never) (?:legally )?(?:authori[sz]ed|eligible|permitted|allowed|entitled)\b|\b(?:need|needs|require|requires|will need|would need)(?: a)? (?:visa|work permit|work visa)\b|\bno (?:right to work|work rights|work permit|work authori[sz]ation)\b|\bnot a (?:citizen|permanent resident|resident)\b/i },
  { status: 'refugee', re: /\brefugee\b|\basylee\b|\basylum(?! seeker)\b|\bhumanitarian protection\b/i },
  { status: 'student', re: /\bSTEM OPT\b|\bOPT\b|\bCPT\b|\bF-?1\b/, country: 'United States', named: true },
  { status: 'student', re: /\bTier ?4\b/i, country: 'United Kingdom', named: true },
  { status: 'student', re: /\bstudy permit\b|\bstudent (?:visa|permit|pass)\b/i, named: true },
  { status: 'open_permit', re: /\bH-?4 EAD\b|\bEAD\b|\bL-?2\b/, country: 'United States', named: true },
  { status: 'open_permit', re: /\bpre-?settled(?: status)?\b|\bgraduate (?:route|visa)\b|\byouth mobility\b/i, country: 'United Kingdom', named: true },
  { status: 'open_permit', re: /\bPGWP\b|\bpost[- ]graduation work permit\b/i, country: 'Canada', named: true },
  { status: 'open_permit', re: /\bstamp ?4\b/i, country: 'Ireland', named: true },
  { status: 'open_permit', re: /\bopen (?:work )?permit\b|\bpost[- ]study work\b|\bdependa?nt(?:'s)? (?:visa|permit|pass)\b|\bspouse (?:visa|permit)\b|\bworking holiday\b|\bbridging visa\b|\bnot tied to (?:an |any )?employer\b/i, named: true },
  { status: 'employer_visa', re: /\bH-?1B\d?\b|\bL-?1[AB]?\b|\bO-?1\b|\bE-?2\b/i, country: 'United States', named: true },
  { status: 'employer_visa', re: /\bskilled worker\b|\bTier ?2\b/i, country: 'United Kingdom', named: true },
  { status: 'employer_visa', re: /\bemployment pass\b|\bS Pass\b/i, country: 'Singapore', named: true },
  { status: 'employer_visa', re: /\bsubclass 482\b|\bTSS\b/, country: 'Australia', named: true },
  { status: 'employer_visa', re: /\bblue card\b|\bcritical skills\b|\bintra[- ]company\b|\bemployer[- ](?:sponsored|specific|tied)\b|\bsponsored by (?:my|an|the) employer\b|\btied to (?:an |my |the )?employer\b|\bstamp ?1\b/i, named: true },
  { status: 'permanent', re: /\bgreen ?card\b|\blawful permanent resident\b|\bLPR\b/i, country: 'United States', named: true },
  { status: 'permanent', re: /\bindefinite leave to remain\b|\bILR\b|\bsettled status\b/i, country: 'United Kingdom', named: true },
  { status: 'permanent', re: /\bpermanent residen(?:t|ce|cy)\b/i },
  { status: 'permanent', re: /\bPR\b/ },
  { status: 'citizen', re: /\bcitizen(?:ship)?\b|\bnaturali[sz]ed\b|\bpassport holder\b/i },
];

/** The labels themselves, as a host is told to write them. */
const LABELS: Array<{ status: RightsStatus; re: RegExp }> = [
  { status: 'not_authorised', re: /^not authori[sz]ed\b/i },
  { status: 'employer_visa', re: /^work (?:visa|permit)(?: or permit)? tied to (?:an )?employer\b/i },
  { status: 'open_permit', re: /^work permit not tied to (?:an )?employer\b/i },
  { status: 'student', re: /^student visa(?: with work rights)?\b/i },
  { status: 'free_movement', re: /^free movement(?: or treaty right)?\b/i },
  { status: 'refugee', re: /^refugee(?: or asylum status)?\b/i },
  { status: 'permanent', re: /^permanent resident\b/i },
  { status: 'citizen', re: /^citizen\b/i },
  { status: 'other', re: /^other\b/i },
];

const ELSEWHERE = /\b(?:anywhere|everywhere|elsewhere|any other|other countries|all other|rest of the world|outside (?:of )?(?:it|that|them))\b/i;
const SKIP = /\b(?:prefer not|rather not|won'?t apply|not (?:to )?apply|don'?t apply|skip)\b/i;
const FUTURE = /\bnot now\b|\bnot (?:currently|at the moment|yet)\b|\bin (?:the )?future\b|\bfuture\b|\blater\b|\beventually\b|\bwhen (?:my|the|it)\b.{0,40}\b(?:ends|expires|runs out|ends)\b/i;
const UNTIL = /\b(?:until|till|valid (?:until|to|through|till)|expir(?:es|ing|y)(?: on| in)?|ends?(?: on| in)?|runs? out(?: in| on)?)\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}\s*\/\s*\d{4}|\d{4}-\d{1,2})\b/i;

interface Read { country: string | null; status: RightsStatus | null; note: string | null; validUntil: string | null; sponsorship: Sponsorship | null }

/** What a sponsorship remark in a work authorisation sentence says, or null. */
function sponsorshipSaid(text: string): Sponsorship | null {
  const labelled = /\bsponsorship\s*[:=]\s*(.+)$/i.exec(text);
  if (labelled) return sponsorshipValue(labelled[1]);
  if (!/\bsponsor/i.test(text)) return null;
  if (/\b(?:without|no|not needed|not required|never need|don'?t need|do not need|doesn'?t need|does not need|won'?t need|no need for)\b[^.;]{0,30}\bsponsor|\bsponsor\w*\b[^.;]{0,15}\b(?:not (?:needed|required)|never)\b/i.test(text)) return 'no';
  if (FUTURE.test(text)) return 'future';
  return /\b(?:need|needs|require|requires|will need|would need)\b/i.test(text) ? 'now' : null;
}

/** "No", "In future", "Yes, I need it now", the labels: one sponsorship value, or null. */
function sponsorshipValue(text: string): Sponsorship | null {
  const t = text.trim().replace(/[.!]+$/, '');
  if (!t) return null;
  for (const v of SPONSORSHIP_VALUES) if (folded(t) === folded(COPY.sponsorship[v])) return v;
  if (folded(t) === folded(COPY.sponsorshipToChange)) return 'now';
  if (FUTURE.test(t)) return 'future';
  const m = meaningOf('sponsorship', t).polarity;
  return m === 'no' ? 'no' : m === 'yes' || /^now\b/i.test(t) ? 'now' : null;
}

/** One part of a sentence: its country, status, note, end and sponsorship, as far as it says them. */
function readPart(part: string): Read {
  const text = part.trim();
  const out: Read = { country: null, status: null, note: null, validUntil: null, sponsorship: sponsorshipSaid(text) };
  const until = UNTIL.exec(text);
  if (until) out.validUntil = monthOf(until[1].replace(/\s+/g, ' '));
  // "India: Citizen", "United States: Work visa tied to an employer (H-1B), until 06/2027", as a host is told to write it.
  const pair = /^([^:]{2,60}):\s*(.+)$/.exec(text);
  const named = pair ? countryNamed(pair[1]) : null;
  if (pair && named) {
    out.country = named;
    const rest = pair[2].trim();
    const label = LABELS.find((l) => l.re.test(rest));
    if (label) {
      out.status = label.status;
      const after = rest.replace(label.re, '').replace(/^[^(:]*?(?=\(|:|,|$)/, '');
      const note = label.status === 'other' ? /^\s*[:(-]?\s*([^,;)]+)/.exec(after)?.[1] : /\(([^)]+)\)/.exec(after)?.[1];
      if (note?.trim()) out.note = note.trim();
      return out;
    }
    return { ...out, ...statusIn(rest), country: named };
  }
  const countries = countriesIn(text);
  const found = statusIn(text);
  out.status = found.status;
  out.note = found.note;
  out.country = countries.length === 1 ? countries[0] : countries.length ? null : found.country;
  if (countries.length > 1) out.country = null;
  return out;
}

function statusIn(text: string): { status: RightsStatus | null; note: string | null; country: string | null } {
  for (const s of STATUS_WORDS) {
    const m = s.re.exec(text);
    if (m) return { status: s.status, note: s.named ? m[0].trim() : null, country: s.country ?? null };
  }
  return { status: null, note: null, country: null };
}

export interface RightsRead {
  /** Entries read plainly: a country and a status each. */
  entries: EntryChoice[];
  elsewhere: Elsewhere | null;
  /** Parts that name where they may work but not plainly how: kept to confirm. */
  unread: Array<{ text: string; country: string | null }>;
}

/**
 * What a work authorisation sentence says, read in code: "Indian citizen,
 * authorised to work in India without sponsorship" is India, Citizen, No.
 * Each part separated by a semicolon or a new line is read on its own, and a
 * part naming two countries is split at its commas. A part that names where
 * but not how ("Authorised to work in the UK") is unread, never guessed.
 */
export function readRights(text: string): RightsRead {
  const out: RightsRead = { entries: [], elsewhere: null, unread: [] };
  const byCountry = new Map<string, Read>();
  const floating: Read[] = [];
  const parts = text.split(/\s*(?:[;\n|]|\s·\s)\s*(?=\S)/).map((p) => p.trim()).filter(Boolean)
    // "US · authorised" is one part, written with a dot between the country and what it says.
    .reduce<string[]>((all, p) => {
      const prev = all[all.length - 1];
      if (prev && countryNamed(prev) && !/:/.test(prev)) all[all.length - 1] = `${prev}: ${p}`;
      else all.push(p);
      return all;
    }, []);
  for (const whole of parts) {
    // "EU, EEA and Switzerland: Free movement" names one place, written as a host is told to write it.
    const paired = /^([^:]{2,60}):/.exec(whole);
    const many = !(paired && countryNamed(paired[1])) && (countriesIn(whole).length > 1 || (ELSEWHERE.test(whole) && countriesIn(whole).length > 0));
    const pieces = many ? whole.split(/\s*(?:,|\bbut\b|\bwhile\b|\bwhereas\b|\band\b(?= (?:need|require|would|will|am|have|hold|not)\b))\s*/i).filter((x) => x.trim()) : [whole];
    for (const piece of pieces) {
      if (ELSEWHERE.test(piece) && !countriesIn(piece).length) {
        const need = SKIP.test(piece) ? 'skip' : /\b(?:need|needs|require|requires|would need|will need|visa|sponsor\w*)\b/i.test(piece) ? 'need' : null;
        if (need) { out.elsewhere = need; continue; }
      }
      const r = readPart(piece);
      if (r.country) {
        const had = byCountry.get(r.country);
        if (!had) byCountry.set(r.country, r);
        else {
          // The same country said twice: what one part leaves out, the other may say; two statuses for it is not plain.
          if (had.status && r.status && had.status !== r.status) { had.status = null; had.note = piece; continue; }
          had.status ??= r.status;
          had.note ??= r.note;
          had.validUntil ??= r.validUntil;
          had.sponsorship ??= r.sponsorship;
        }
      } else if (r.status || r.sponsorship || r.validUntil) {
        floating.push({ ...r, note: r.note ?? null });
      } else {
        out.unread.push({ text: piece, country: null });
      }
    }
  }
  // A part that names no country ("need a visa", "until June 2027") belongs to the one country the rest names, when there is one.
  const only = byCountry.size === 1 ? [...byCountry.values()][0] : null;
  for (const f of floating) {
    if (only && (!f.status || !only.status || f.status === only.status)) {
      only.status ??= f.status;
      only.note ??= f.note;
      only.validUntil ??= f.validUntil;
      only.sponsorship ??= f.sponsorship;
    } else if (f.status) out.unread.push({ text: text.trim(), country: null });
  }
  for (const [country, r] of byCountry) {
    // A citizen or permanent resident who needs sponsorship there says two things that cannot both be so.
    const clash = r.status && r.sponsorship && defaultSponsorship(r.status) === 'no' && r.sponsorship !== 'no' && r.status !== 'free_movement' && r.status !== 'refugee';
    const ok = r.status && (country !== FREE_MOVEMENT || r.status === 'free_movement') && (r.status !== 'other' || r.note) && !clash;
    if (ok) out.entries.push({ country, status: r.status!, note: r.note, validUntil: r.validUntil, sponsorship: r.sponsorship ?? defaultSponsorship(r.status!) });
    else out.unread.push({ text: parts.find((p) => countriesIn(p).includes(country)) ?? text.trim(), country });
  }
  // Unread parts that only repeat a country an entry already settles add nothing to confirm.
  out.unread = out.unread.filter((u, i, all) => !(u.country && out.entries.some((e) => e.country === u.country)) && all.findIndex((x) => x.text === u.text && x.country === u.country) === i);
  return out;
}

interface SponsorshipRead {
  countries: Array<{ country: string; value: Sponsorship }>;
  elsewhere: Elsewhere | null;
  /** A plain answer for no country in particular. */
  bare: Sponsorship | null;
  unread: string[];
}

/** What a sponsorship sentence says: for each country it names, for anywhere else, or plainly. */
export function readSponsorship(text: string): SponsorshipRead {
  const out: SponsorshipRead = { countries: [], elsewhere: null, bare: null, unread: [] };
  for (const part of text.split(/\s*[;\n|]\s*/).map((p) => p.trim()).filter(Boolean)) {
    const pair = /^([^:]{2,60}):\s*(.+)$/.exec(part);
    const where = pair ? pair[1] : '';
    const what = pair ? pair[2] : part;
    if (ELSEWHERE.test(where) || (!pair && ELSEWHERE.test(part) && !countriesIn(part).length)) {
      const said = folded(what);
      const v = SKIP.test(what) || said === folded(COPY.elsewhere.skip) ? 'skip'
        : said === folded(COPY.elsewhere.need) || /\b(?:need|needs|require|requires|would|yes|now|visa)\b/i.test(what) ? 'need' : null;
      if (v) out.elsewhere = v; else out.unread.push(part);
      continue;
    }
    const country = pair ? countryNamed(where) : countriesIn(part).length === 1 ? countriesIn(part)[0] : null;
    const value = sponsorshipValue(what) ?? sponsorshipSaid(what);
    if (pair && !country) { out.unread.push(part); continue; }
    if (!value || (!pair && countriesIn(part).length > 1)) { out.unread.push(part); continue; }
    if (country) out.countries.push({ country, value });
    else if (out.bare && out.bare !== value) out.unread.push(part);
    else out.bare = value;
  }
  return out;
}

// ---------------------------------------------------------------- answering

export type RightsKind = 'authorised' | 'sponsorship' | 'status' | 'citizenship' | 'nationality';

export interface RightsAsk {
  kind: RightsKind;
  /** The country it is about: named by the question, else the job's. Null when neither says. */
  country: string | null;
  /** The question named several countries. */
  several?: boolean;
  /** "Do you currently need sponsorship?": only now, not in future. */
  nowOnly?: boolean;
  /** "...citizen or permanent resident...": either answers yes. */
  orResident?: boolean;
  shape: { kind: 'text' | 'number' | 'yes_no' | 'choice'; choices: string[] };
}

export type RightsAnswer =
  | { outcome: 'answer'; answer: string; statement: string; from: string; via: 'entry' | 'elsewhere'; updatedAt: string }
  | { outcome: 'ask'; why: string; via: 'entry' | 'elsewhere' | 'none'; updatedAt: string };

/**
 * The person's own entry for this country: theirs for it, else the free
 * movement area's when the country is in it, else the right a citizen of one
 * member state has in every other (`through` names their own country). A
 * proposal for the country is `pending`, and comes before that right.
 */
export function entryFor(state: RightsState, country: string): { entry: RightsEntry; area: boolean; through?: string } | { pending: RightsEntry } | null {
  const own = state.entries.find((e) => e.confirmed && e.country === country);
  if (own) return { entry: own, area: false };
  const inArea = FREE_MOVEMENT_AREA.has(country) || country === FREE_MOVEMENT;
  const area = inArea ? state.entries.find((e) => e.confirmed && e.country === FREE_MOVEMENT) : null;
  if (area) return { entry: area, area: true };
  const pending = state.entries.find((e) => !e.confirmed && e.country === country);
  if (pending) return { pending };
  const home = inArea ? state.entries.find((e) => e.confirmed && e.status === 'citizen' && FREE_MOVEMENT_AREA.has(e.country)) : null;
  if (!home) return null;
  const entry: RightsEntry = { ...home, status: 'free_movement', validUntil: null, note: null, sponsorship: 'no' };
  return { entry, area: true, through: home.country };
}

/** Whether the person would need sponsorship in this country, as far as their entries say: null when they say nothing about it. */
export function needsSponsorshipIn(state: RightsState, country: string, now = new Date()): boolean | null {
  const found = entryFor(state, country);
  if (found && 'pending' in found) return null;
  if (!found) return state.elsewhere ? true : null;
  const e = found.entry;
  if (expired(e, now)) return null;
  const s = e.sponsorship ?? defaultSponsorship(e.status);
  return s === null ? null : s !== 'no';
}

interface Truth {
  authorised: boolean | null;
  sponsorship: Sponsorship | null;
  status: RightsStatus;
  note: string | null;
  citizen: boolean | null;
}

/**
 * The answer the person's entries give this question, for its country, or
 * why it waits for them; null when the entries say nothing about it (no
 * entry for the country and no answer for anywhere else).
 */
export function answerRights(state: RightsState, ask: RightsAsk, now = new Date()): RightsAnswer | null {
  const none = (why: string): RightsAnswer => ({ outcome: 'ask', why, via: 'none', updatedAt: '' });
  if (ask.kind === 'nationality') return nationality(state, ask);
  if (ask.several) return none(COPY.severalCountries);
  if (!ask.country) return none(COPY.noJobCountry);
  const country = ask.country;
  const name = countryWords(country);
  const found = entryFor(state, country);
  if (found && 'pending' in found) return { outcome: 'ask', why: COPY.pending.replace('{country}', name), via: 'entry', updatedAt: found.pending.updatedAt };
  // What they wrote about sponsorship before there were choices waits for them to pick: no default speaks over it.
  if (ask.kind === 'sponsorship' && state.earlierSponsorship) return { outcome: 'ask', why: COPY.earlierSponsorship.replace('{text}', state.earlierSponsorship), via: 'entry', updatedAt: '' };
  if (!found) {
    // Anywhere else: they would need sponsorship there, so they may not work there without it. Never a citizen's answer.
    if (!state.elsewhere || ask.kind === 'citizenship') return null;
    const truth: Truth = { authorised: false, sponsorship: 'now', status: 'not_authorised', note: null, citizen: null };
    const words = COPY.elsewhere[state.elsewhere.value];
    return shaped(truth, ask, country, { statement: COPY.saysElsewhere.replace('{words}', words), from: COPY.fromElsewhere, via: 'elsewhere', updatedAt: state.elsewhere.updatedAt });
  }
  const e = found.entry;
  const at = { via: 'entry' as const, updatedAt: e.updatedAt };
  const ended = expired(e, now);
  const sponsorship = e.sponsorship ?? defaultSponsorship(e.status);
  const truth: Truth = {
    authorised: ended ? null : IMPLIES[e.status].authorised,
    sponsorship,
    status: e.status, note: e.note,
    // A citizen's answer comes from a Citizen entry for that very country; any other status the person picked there says they are not one.
    citizen: found.area || e.country === FREE_MOVEMENT ? null : e.status === 'citizen' ? true : e.status === 'other' ? null : false,
  };
  const endedWhy = (): RightsAnswer => ({ outcome: 'ask', why: COPY.expired.replace('{status}', COPY.status[e.status].toLowerCase()).replace('{country}', name).replace('{month}', monthWords(e.validUntil!)), ...at });
  const statement = found.through
    ? COPY.saysThrough.replace('{home}', countryWords(found.through)).replace('{country}', name)
    : (ask.kind === 'sponsorship' && sponsorship
      ? COPY.saysSponsorship.replace('{words}', sponsorshipWords(sponsorship, e.status))
      : COPY.says.replace('{words}', entryWords(e))).replace('{country}', placeName(e.country));
  const facts = { statement, from: COPY.from.replace('{country}', placeName(e.country)), ...at };
  switch (ask.kind) {
    case 'authorised':
    case 'status':
      if (ended) return endedWhy();
      if (truth.authorised === null && ask.kind === 'authorised' && e.status === 'other') return { outcome: 'ask', why: COPY.otherSays.replace('{country}', name).replace('{note}', e.note ?? ''), ...at };
      break;
    case 'sponsorship':
      if (!sponsorship) return { outcome: 'ask', why: COPY.sponsorshipUnsaid.replace('{country}', name), ...at };
      if (ended && sponsorship === 'no') return endedWhy();
      break;
    case 'citizenship':
      if (truth.citizen === null) return null;
      break;
  }
  return shaped(truth, ask, country, facts);
}

/** "What is your citizenship?": the countries of the person's Citizen entries. */
function nationality(state: RightsState, ask: RightsAsk): RightsAnswer | null {
  const citizen = state.entries.filter((e) => e.confirmed && e.status === 'citizen' && e.country && e.country !== FREE_MOVEMENT);
  if (!citizen.length) return null;
  const countries = citizen.map((e) => e.country);
  const updatedAt = citizen.map((e) => e.updatedAt).sort().at(-1) ?? '';
  const statement = COPY.saysCitizen.replace('{countries}', countries.join(COPY.andJoin));
  const base = { statement, from: COPY.from.replace('{country}', countries.join(COPY.andJoin)), via: 'entry' as const, updatedAt };
  if (ask.shape.kind === 'text') return { outcome: 'answer', answer: countries.join(COPY.andJoin), ...base };
  if (ask.shape.kind !== 'choice') return null;
  const hits = ask.shape.choices.filter((c) => !catchAll(c) && countries.includes(countryNamed(c) ?? countriesIn(c)[0] ?? ''));
  if (hits.length === 1) return { outcome: 'answer', answer: hits[0], ...base };
  return { outcome: 'ask', why: hits.length ? COPY.manyOptions.replace('{country}', countries.join(COPY.andJoin)).replace('{options}', hits.map((h) => `“${h}”`).join(', ')) : COPY.noOption.replace('{country}', countries.join(COPY.andJoin)).replace('{status}', COPY.status.citizen), via: 'entry', updatedAt };
}

type Facts = { statement: string; from: string; via: 'entry' | 'elsewhere'; updatedAt: string };

/** The truth put in the form's shape: a Yes or No, the status in words, or the one choice that fits it. */
function shaped(t: Truth, ask: RightsAsk, country: string, facts: Facts): RightsAnswer {
  const name = countryWords(country);
  const ok = (answer: string): RightsAnswer => ({ outcome: 'answer', answer, ...facts });
  const yes = yesFor(t, ask);
  if (ask.kind === 'status' && ask.shape.kind === 'text') return ok(formStatus(t, country));
  if (ask.shape.kind === 'number') return { outcome: 'ask', why: COPY.noOption.replace('{country}', name).replace('{status}', COPY.status[t.status]), via: facts.via, updatedAt: facts.updatedAt };
  if (ask.shape.kind === 'yes_no' || ask.shape.kind === 'text') {
    if (yes === null) return { outcome: 'ask', why: COPY.noOption.replace('{country}', name).replace('{status}', COPY.status[t.status]), via: facts.via, updatedAt: facts.updatedAt };
    return ok(yes ? 'Yes' : 'No');
  }
  const pick = pickOption(t, ask, country);
  if (pick.one) return ok(pick.one);
  const why = pick.many.length
    ? COPY.manyOptions.replace('{country}', name).replace('{options}', pick.many.map((h) => `“${h}”`).join(', '))
    : COPY.noOption.replace('{country}', name).replace('{status}', t.status === 'other' && t.note ? t.note : COPY.status[t.status]);
  return { outcome: 'ask', why, via: facts.via, updatedAt: facts.updatedAt };
}

/** The yes or no this question takes from the truth; null when it cannot say. */
function yesFor(t: Truth, ask: RightsAsk): boolean | null {
  switch (ask.kind) {
    case 'authorised': return t.authorised;
    case 'sponsorship': return t.sponsorship === null ? null : t.sponsorship === 'now' || (t.sponsorship === 'future' && !ask.nowOnly);
    case 'citizenship': return t.citizen === null ? null : t.citizen || (!!ask.orResident && t.status === 'permanent');
    default: return null;
  }
}

/** The status in a form's text box: "Citizen of India", "Work visa tied to an employer (H-1B), valid until June 2027". */
export function formStatus(t: Pick<Truth, 'status' | 'note'> & { validUntil?: string | null }, country: string): string {
  if (t.status === 'other') return t.note ?? COPY.status.other;
  const base = COPY.formStatus[t.status].replace('{country}', countryWords(country)).replace('{note}', t.note ?? '');
  return `${base}${t.note ? ` (${t.note})` : ''}`;
}

// ---------------------------------------------------------------- a form's choices

/** What a form's choice says, read by its words. */
interface OptionSays {
  /** It opens with a yes or a no, or says outright that one may or may not work there. */
  polarity: 'yes' | 'no' | null;
  /** What it says about sponsorship. */
  sponsor: 'yes' | 'no' | 'future' | null;
  statuses: Set<RightsStatus>;
  country: string | null;
  catchAll: boolean;
}

/** Statuses a form's choice names, by its words. Several names may fit one choice: "Visa holder" is any visa. */
const OPTION_STATUS: Array<{ status: RightsStatus[]; re: RegExp }> = [
  { status: ['free_movement'], re: /(?<!\bnon[- ]?|\boutside (?:the )?)\b(?:eu|eea|european union|european economic area)\b|\bswiss (?:citizen|national)\b|\bfree movement\b|\btn\b|\be-?3\b|\btrans[- ]?tasman\b|\bcommon travel area\b|\bspecial category visa\b/ },
  { status: ['refugee'], re: /\brefugee\b|\basylee\b|\basylum\b|\bhumanitarian\b/ },
  { status: ['student'], re: /\bf-?1\b|\bopt\b|\bcpt\b|\bstudent\b|\bstudy permit\b|\btier ?4\b/ },
  { status: ['open_permit'], re: /\bead\b|\bemployment authori[sz]ation (?:document|card)\b|\bopen (?:work )?permit\b|\bpost[- ]study\b|\bgraduate (?:route|visa)\b|\bpgwp\b|\bdependa?nt\b|\bspouse\b|\bh-?4\b|\bl-?2\b|\bpre[- ]?settled\b|\bworking holiday\b|\byouth mobility\b|\bstamp ?4\b|\bnot tied to\b/ },
  { status: ['employer_visa'], re: /\bh-?1-?b\d?\b|\bl-?1[ab]?\b|\bo-?1\b|\be-?2\b|\btier ?2\b|\bskilled worker\b|\bblue card\b|\bemployment pass\b|\bs pass\b|\bemployer[- ]sponsored\b|\bsponsored (?:work )?visa\b|\bintra[- ]company\b|\bcritical skills\b|\btss\b|\bstamp ?1\b|\btied to (?:an |the |my )?employer\b/ },
  { status: ['employer_visa', 'open_permit'], re: /\bwork (?:visa|permit)\b|\bvalid (?:work )?permit\b/ },
  { status: ['employer_visa', 'open_permit', 'student'], re: /\bvisa holder\b|\bon a visa\b|\btemporary (?:visa|resident|status)\b/ },
  { status: ['permanent'], re: /\bpermanent residen(?:t|ce|cy)\b|\bgreen ?card\b|\blawful permanent\b|\blpr\b|\bindefinite leave\b|\bilr\b|(?<!pre[- ]?)\bsettled status\b|\bpr\b/ },
  { status: ['citizen'], re: /\bcitizen(?:ship)?\b|\bnational\b(?! insurance)/ },
  { status: ['not_authorised'], re: /\bnot (?:currently )?(?:legally )?(?:authori[sz]ed|eligible|permitted|entitled)\b|\bno (?:work )?(?:authori[sz]ation|permit|right to work)\b/ },
];

function catchAll(option: string): boolean {
  return /^\s*(?:other|none of (?:the )?above|n\/?a|not applicable|prefer not|decline|i (?:don'?t|do not) (?:know|wish)|select|choose|please select)\b/i.test(option) || /^-+$/.test(option.trim());
}

function optionSays(option: string, kind: RightsKind): OptionSays {
  const t = folded(option).replace(/[’]/g, '\'');
  const statuses = new Set<RightsStatus>();
  for (const s of OPTION_STATUS) {
    if (!s.re.test(t)) continue;
    // "Not a citizen", "non-citizen": not that status.
    if (s.status.includes('citizen') && /\b(?:non|not a|not an)[- ]?(?:\w+ )?citizen/.test(t)) continue;
    if (s.status.includes('citizen') && statuses.has('free_movement')) continue;
    for (const x of s.status) statuses.add(x);
  }
  let polarity: OptionSays['polarity'] = /^\s*(?:yes|y)\b/.test(t) ? 'yes' : /^\s*(?:no|n)\b/.test(t) ? 'no' : null;
  const future = /\bnot now\b|\bnot (?:currently|yet|at (?:this|the) (?:time|moment))\b|\bin (?:the )?future\b|\blater\b|\beventually\b/.test(t) && !/\bnow or (?:in the future|later)\b/.test(t);
  const unneeded = /\b(?:without|no|not|never|don'?t|do not|doesn'?t|won'?t|will not|wouldn'?t|would not)\b[^.]{0,30}\b(?:sponsor\w*|need\w*|requir\w*)\b|\bsponsor\w*\b[^.]{0,15}\bnot (?:needed|required)\b/.test(t);
  const needed = /\b(?:need|needs|needed|require|requires|required|with sponsorship)\b/.test(t);
  let sponsor: OptionSays['sponsor'] = null;
  if (kind === 'sponsorship') {
    // The choice answers the sponsorship question itself: "Not now, but in the future" says when, a Yes or a No says whether.
    if (future) { sponsor = 'future'; polarity = null; }
    else polarity ??= unneeded ? 'no' : needed ? 'yes' : null;
  } else if (/\bsponsor/.test(t)) {
    sponsor = future ? 'future' : unneeded ? 'no' : 'yes';
  }
  if (!polarity && (kind === 'authorised' || kind === 'status')) {
    polarity = /\b(?:not|no)\b[^.]{0,20}\b(?:authori[sz]ed|eligible|permitted|entitled|right to work|allowed)\b/.test(t) ? 'no'
      : /\b(?:authori[sz]ed|eligible|permitted|entitled|right to work|allowed to work)\b/.test(t) ? 'yes' : null;
  }
  if (!polarity && kind === 'citizenship' && statuses.has('citizen')) polarity = /\b(?:non|not)\b/.test(t) ? 'no' : null;
  const countries = countriesIn(option);
  return { polarity, sponsor, statuses, country: countries.length === 1 ? countries[0] : null, catchAll: catchAll(option) };
}

/** Whether a choice's word on sponsorship fits what the person said. */
function sponsorFits(said: OptionSays['sponsor'], t: Truth, ask: RightsAsk): boolean {
  if (!said) return true;
  if (!t.sponsorship) return false;
  if (said === 'future') return t.sponsorship === 'future';
  const needs = t.sponsorship === 'now' || (t.sponsorship === 'future' && !(ask.kind === 'sponsorship' && ask.nowOnly));
  return said === 'yes' ? needs : !needs;
}

/** The note's words, as a form might write the visa: "H-1B", "Stamp 4". */
const compact = (s: string): string => folded(s).replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The one choice that fits, matched by meaning: a choice is out when
 * anything it says (yes or no, sponsorship, a status, a country) does not
 * hold for the person, and a catch-all ("Other") is never picked for them.
 * Of those left, the one saying most that holds is picked; a tie or none
 * leaves the question to the person.
 */
export function pickOption(t: Truth, ask: RightsAsk, country: string): { one: string | null; many: string[] } {
  const scored: Array<{ option: string; score: number }> = [];
  const note = t.note ? compact(t.note) : '';
  for (const option of ask.shape.choices) {
    const says = optionSays(option, ask.kind);
    if (says.catchAll) {
      // Picked for "Other" only when the person's own note names it.
      continue;
    }
    let score = 0;
    let fits = true;
    const want = yesFor(t, ask);
    const noted = !!note && note.length >= 2 && compact(option).includes(note);
    if (says.polarity) {
      if (ask.kind === 'status') fits &&= t.authorised !== null && (says.polarity === 'yes') === t.authorised;
      else fits &&= want !== null && (says.polarity === 'yes') === want;
      score += 1;
    }
    // A choice that says when ("Not now, but in the future") says more than a plain Yes.
    if (says.sponsor) { fits &&= sponsorFits(says.sponsor, t, ask); score += says.sponsor === 'future' ? 2 : 1; }
    if (says.statuses.size) {
      const matches = says.statuses.has(t.status) || noted;
      // On a yes-or-no question about citizenship, a status in the choice is only what it says yes or no to.
      if (ask.kind !== 'citizenship') fits &&= matches;
      score += matches ? 2 : 0;
    }
    if (says.country) {
      fits &&= says.country === country || (t.status === 'free_movement' && (says.country === FREE_MOVEMENT || FREE_MOVEMENT_AREA.has(says.country)));
      score += 1;
    }
    if (noted) score += 3;
    // A choice that says nothing Fanfold can read is not a choice it can make.
    if (!says.polarity && !says.sponsor && !says.statuses.size && !noted) fits = false;
    if (fits) scored.push({ option, score });
  }
  if (!scored.length) return { one: null, many: [] };
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  return top.length === 1 ? { one: top[0].option, many: [] } : { one: null, many: top.map((s) => s.option) };
}

// ---------------------------------------------------------------- what a question asks

/** A yes-or-no question by its words: "Are you…", "Do you…", "Legally authorised to work…?". */
const YES_NO = /^\s*(?:are|do|does|is|will|would|have|has|can|could|may|did|were)\b/i;
const STATUS_WORDING = /\b(?:status|type|kind|category|which|what|describe|select|choose|current (?:work )?(?:visa|authori[sz]ation))\b/i;
const NOW_ONLY = /\b(?:now|currently|at (?:this|the) (?:time|moment)|present(?:ly)?|today|immediately)\b/i;
const ANY_TIME = /\b(?:future|later|ever|eventually|going forward|at any (?:point|time)|in the next|will you|would you)\b/i;
const OR_RESIDENT = /\bpermanent resident\b|\bgreen ?card\b/i;
const AUTHORISED_WORDS = /\b(?:authori[sz]ed|eligible|entitled|permitted|allowed|right to work|legally)\b/i;

/** The intents whose questions the entries answer. */
export const RIGHTS_INTENTS: ReadonlySet<string> = new Set(['work.authorisation', 'work.sponsorship', 'work.citizenship']);

/**
 * What a question about the right to work asks, from what it is known to ask
 * and its words; null for a question about anything else.
 */
export function rightsKind(intent: string | null, question: string, shape: RightsAsk['shape']): Pick<RightsAsk, 'kind' | 'nowOnly' | 'orResident'> | null {
  if (intent === 'work.sponsorship') return { kind: 'sponsorship', nowOnly: NOW_ONLY.test(question) && !ANY_TIME.test(question) };
  const yesNo = shape.kind === 'yes_no' || YES_NO.test(question);
  if (intent === 'work.citizenship') {
    // "Are you a US citizen, permanent resident or otherwise authorised to work?" asks whether they may work there.
    if (AUTHORISED_WORDS.test(question) && /\botherwise\b|\bor\b/i.test(question)) return { kind: 'authorised' };
    return yesNo ? { kind: 'citizenship', orResident: OR_RESIDENT.test(question) } : { kind: 'nationality' };
  }
  if (intent === 'work.authorisation') {
    if (shape.kind === 'number') return null;
    return yesNo || (AUTHORISED_WORDS.test(question) && !STATUS_WORDING.test(question)) ? { kind: 'authorised' } : { kind: 'status' };
  }
  return null;
}

/** The picker's countries, the person's own first when it is known. */
export function countryChoices(own: string | null): string[] {
  return own && COUNTRY_LIST.includes(own) ? [own, ...COUNTRY_LIST.filter((c) => c !== own)] : [...COUNTRY_LIST];
}
