/**
 * What Fanfold already knows that answers a question on a form.
 *
 * Three outcomes. An answer goes in the form at once: a confirmed fact or the
 * user's own saved answer, a value copied from a document the owner gave, or
 * something Fanfold worked out from its own records. A draft waits for the
 * user with a suggestion and the reason for it: an agent's guess, an answer
 * to a question worded alike, a fact that needs changing to fit. Anything
 * else is asked. Nothing here calls a model.
 *
 * Each question is first known by what it asks (its intent, intents.ts), so
 * the user's answer to one wording answers every other, and what the intent
 * asks is worked out in code from the profile, the career record read from
 * the user's documents, and the ledger. The intent says how far Fanfold may
 * go on its own; an answer older than the intent allows, or one the user's
 * documents contradict, is a draft that says so.
 */
import { atsIdentity, type Jobs } from './jobs.ts';
import type { Memory } from '../memory/memory.ts';
import { readerText } from '../memory/document-instructions.ts';
import { isUserSource, LABELS, RIGHTS_FIELDS, valueFromAnswer, yearsIn, type Profile, type ProfileField } from './profile.ts';
import { clean, factFor, inShape, Questions, type Asker, type FactAnswer, type QuestionKind } from './questions.ts';
import { jobKey, namesCompany, questionKey } from './scope.ts';
import { canonicalSkill, escapeRe, folded, normaliseQuestion, quoteFolded, skillForms } from './wording.ts';
import { countriesIn, countryNamed, countryOfPlace } from './countries.ts';
import { answerRights, RIGHTS_INTENTS, rightsKind, type RightsAsk } from './work-rights.ts';
import { classifyLocal, companyOf, EVERY_COMPANY, fieldAsked, INTENT, intentKey, placeWords, SENSITIVE_FIELDS, unnumbered, type Classified, type IntentDef, type QuestionIntents } from './intents.ts';
import { sensitiveAsked } from '../policy/sensitive-question.ts';
import {
  careerOf, currentRole, degreeDispute, degreeLevel, hasSkill, highestDegree, KNOWN_SKILLS, newestRole, roleDispute, said, skillSpanYears, staleRole, statedDispute, studyDispute, totalYearsBasis, workedAt as workedAtRole,
  type CareerRecord, type CareerRecords, type Role, type Study,
} from './career.ts';

/** What the user reads on Review as the reason for a suggestion. */
export const COPY = {
  savedOtherShape: 'your saved answer "{answer}", formatted for this form',
  agentSaved: 'an agent saved this answer, but you haven’t checked it',
  near: 'your answer to "{question}"',
  factSays: 'your profile says {label}: "{value}"',
  converted: 'your profile says {label}: "{value}", which is {amount} {unit}',
  bothSay: 'your profile says "{fact}", and your saved answer to this question says "{answer}"',
  notEmployer: 'your résumé does not list {company} as an employer',
  noResume: 'Fanfold doesn’t have any of your résumés to check',
  sameQuestion: 'your answer to "{question}", which asks the same thing',
  stale: 'you said this {days} days ago. Check if it is still true',
  disagree: 'you said "{mine}", but your résumé "{title}" says "{theirs}"',
  totalYears: 'your résumé shows {years} years of full time work: {roles}',
  estimate: 'about {years} years based on the dates in your résumé, but {why}',
  stated: 'your résumé says "{quote}"',
  moreThanTotal: 'your résumé says "{quote}", which is more than your {total} total years of work. Please check it',
  skillSpan: 'your roles at {roles} mention {skill}: {years} years total, though not all of that time was spent on {skill}',
  notMentioned: 'your documents do not mention {skill}',
  names: 'your résumé mentions {skill}: "{quote}"',
  current: '{employer}, {start} to present, in your résumé',
  newest: 'your most recent job at {employer} in your résumé ended {end}',
  studied: '{degree} at {institution}, in your résumé',
  noneListed: 'your résumé lists none',
  applied: 'according to Fanfold, you applied to {company} for {title} on {date}',
  notApplied: 'Fanfold has no record of an application to {company}, but you may have applied on your own',
  eeo: 'your saved choice for optional questions',
  inexact: 'this asks for a bit more than "{about}". Check that it fits',
  ledger: 'Fanfold\'s record of your applications',
  document: 'the user\'s document "{title}"',
  removed: 'you removed the answer Fanfold worked out for this',
  profileSays: 'the profile\'s {label} is "{value}"',
  everyCompany: 'your answer to "{question}", which you said applies to every company',
  saidNoFor: 'you said No for {company}',
  savedSays: 'the user\'s saved answer to "{question}" is "{answer}"',
  fromStart: 'your profile says your earliest start is "{value}", so check that your notice period is the same',
};

/** The company a "know anyone there" intent key is about, as a person would write it. */
const companyIn = (key: string): string => key.slice(EVERY_COMPANY.length + 1).replace(/\b\p{L}/gu, (c) => c.toUpperCase()) || 'another company';

const factSays = (f: FactAnswer): string => COPY.profileSays.replace('{label}', f.label.toLowerCase()).replace('{value}', f.value);
const savedSays = (a: { question: string; answer: string }): string => COPY.savedSays.replace('{question}', a.question).replace('{answer}', a.answer);
const docTitle = (record: CareerRecord, id: string): string => record.sources?.find((s) => s.documentId === id)?.title ?? '';

export interface Asked {
  question: string;
  kind?: QuestionKind;
  choices?: string[];
}

interface Quote { quote: string; documentId?: string; title?: string }

export type Known =
  | {
    outcome: 'answer'; answer: string;
    /** Where it came from, as the host is told it. */
    from: string;
    /** 'user' when it is the user's own word; 'fanfold' when Fanfold took or worked it out, and the user never typed it. */
    by: 'user' | 'fanfold';
    /** The words it rests on, for a Fanfold answer. */
    quote?: string;
    /** The saved answer used, so its use is counted. */
    answerId?: number;
    /** What Fanfold worked out, to keep so a record that reports it can be checked. */
    derived?: { jobId: string | null; basis: Record<string, unknown> };
    /** One line on what it rests on ("9 years of full-time work: ..."), and every quote behind it. */
    statement?: string;
    quotes?: Quote[];
  }
  | { outcome: 'draft'; draft: string; why: string }
  | { outcome: 'ask'; why?: string };

export interface KnownDeps {
  profile: Profile;
  jobs: Pick<Jobs, 'forPosting' | 'job'> & Partial<Pick<Jobs, 'list' | 'jobIdForUrl'>>;
  memory: Pick<Memory, 'listDocuments' | 'documentText'>;
  /** What the question asks, when the caller classified it. Otherwise it is known here by pattern, stored wording or seed. */
  intent?: Classified | null;
  intents?: QuestionIntents | null;
  /** The career record; read from `careers` when not given. */
  career?: CareerRecord | null;
  careers?: CareerRecords | null;
  now?: Date;
  /** Told which way the answer was found, for the check an answer needs when a model said what the question is. */
  trace?: { path?: 'key' | 'fact' | 'intent' | 'resolve' | 'document' };
}

type Shape = { kind: QuestionKind; choices: string[] };
type Answer = Extract<Known, { outcome: 'answer' }>;
type Draft = { draft: string; why: string };

const DAY = 86_400_000;
/** How far apart two things the user said must be for one to count as their later word. */
const APART = 60_000;

/** Which of a fact and a saved answer the user gave later, or null when either is undated or they came within a minute of each other. */
function later(fact: string, answer: string): 'fact' | 'answer' | null {
  const f = Date.parse(fact);
  const a = Date.parse(answer);
  if (!Number.isFinite(f) || !Number.isFinite(a) || Math.abs(f - a) <= APART) return null;
  return f > a ? 'fact' : 'answer';
}

/** What a question asks, as known without a model: by its words without a list number, else as worded. */
function classified(question: string, kind: string, by: Asker | null, deps: Pick<KnownDeps, 'profile' | 'intents'>): Classified | null {
  const opts = { intents: deps.intents, places: placeWords(deps.profile.fact('location')?.value) };
  const bare = unnumbered(question);
  return classifyLocal(bare, kind, by, opts) ?? (bare !== question ? classifyLocal(question, kind, by, opts) : null);
}

export async function known(asked: Asked, by: Asker, deps: KnownDeps): Promise<Known> {
  const k = await knownFrom(asked, by, deps);
  // Whatever path found it, a sensitive question goes in only with the user's own word (D4).
  if (k.outcome === 'answer' && k.by !== 'user' && isSensitive(asked.question, asked.kind, by, deps)) {
    return { outcome: 'draft', draft: k.answer, why: k.statement ?? k.from };
  }
  // What the user took back is not worked out again, for that question or any other wording of what it asks: it is theirs to answer.
  if (k.outcome === 'answer' && k.by === 'fanfold' && k.derived) {
    const key = k.derived.basis.intentKey;
    if (deps.profile.derivedRejected(clean(asked.question), k.derived.jobId, k.answer) || (typeof key === 'string' && deps.profile.intentRejected(key))) {
      return { outcome: 'ask', why: COPY.removed };
    }
  }
  return k;
}

async function knownFrom(asked: Asked, by: Asker, deps: KnownDeps): Promise<Known> {
  const question = clean(asked.question);
  const shape: Shape = { kind: Questions.kindOf(asked), choices: (asked.choices ?? []).map(clean).filter(Boolean) };
  const { key, scope } = questionKey(question, shape.kind, by);
  const now = deps.now ?? new Date();
  const cls = deps.intent !== undefined ? deps.intent : classified(question, shape.kind, by, deps);
  const def = cls ? INTENT.get(cls.intent) : undefined;
  const trace = (path: NonNullable<KnownDeps['trace']>['path']): void => { if (deps.trace) deps.trace.path = path; };
  let career: CareerRecord | null | undefined;
  const record = (): CareerRecord | null => (career === undefined ? (career = deps.career !== undefined ? deps.career : careerOf({ memory: deps.memory, careers: deps.careers })) : career);
  /** A user's word that is too old for what it says, or that their documents contradict, waits for them instead. */
  const vetted = (a: Answer, said: { value: string; updatedAt: string }): Known => {
    const old = def?.staleAfterDays ? Math.floor((now.getTime() - Date.parse(said.updatedAt)) / DAY) : 0;
    if (def?.staleAfterDays && old > def.staleAfterDays) return { outcome: 'draft', draft: a.answer, why: COPY.stale.replace('{days}', String(old)) };
    const other = def?.checked ? contradiction(def, said.value, record(), now) : null;
    return other ? { outcome: 'draft', draft: a.answer, why: other } : a;
  };

  const drafts: Draft[] = [];
  const saved = deps.profile.answerByKey(key);
  const mine = saved && isUserSource(saved.source) ? saved : null;
  // A fact answers only the question its field is about; a question the intents know as something else is not answered from it.
  const candidate = factFor(deps.profile, unnumbered(question));
  const fact = candidate && (!def || def.field === candidate.field) ? candidate : null;
  const fromFact = fact ? shapeFact(fact, question, shape) : null;

  // Where they may work, and whether they need sponsorship there: from the entries they set, for this question's country only.
  const rights = rightsAsked(question, shape, cls, by, deps);
  let elsewhere: Known | null = null;
  /** Why the entries leave this to the person: no saved answer settles it either, though one may be offered as a draft. */
  let held: string | null = null;
  if (rights) {
    const r = answerRights(deps.profile.rights.state(), rights.ask, now);
    const theirs = mine && rights.named ? mine : null;
    if (r?.outcome === 'answer') {
      const k = resting({ outcome: 'answer', answer: r.answer, from: r.from, by: 'user' } as Answer, r.statement);
      if (r.via === 'elsewhere') elsewhere = k;
      // An answer they gave this very question about this very country, later than the entry, is their word now.
      else if (!theirs || folded(inShape(shape, theirs.answer) ?? theirs.answer) === folded(r.answer)) { trace('fact'); return k; }
      else {
        const newer = later(r.updatedAt, theirs.updatedAt);
        if (newer === 'fact') { trace('fact'); return k; }
        if (newer === null) return { outcome: 'draft', draft: r.answer, why: COPY.bothSay.replace('{fact}', r.statement).replace('{answer}', theirs.answer) };
      }
    } else if (r?.outcome === 'ask' && (r.via === 'none' ? !theirs : !(theirs && later(r.updatedAt, theirs.updatedAt) === 'answer'))) {
      // What the entries cannot settle (an ended visa, a choice that fits no option) waits for the person, with why.
      if (r.via !== 'none' || !mine) held = r.why;
    }
    // Said for anywhere else, it comes before an answer to the same words for another job, which may have been for another country.
    if (elsewhere && !rights.named) return elsewhere;
  }

  // An attestation or a consent is the user's to give each time: only their own answer for this very form.
  if (def && (def.id === 'legal.attestation' || def.id === 'legal.consent')) {
    const shaped = mine ? inShape(shape, mine.answer) : null;
    return mine && shaped !== null ? resting({ outcome: 'answer', answer: shaped, from: 'a saved answer', by: 'user', answerId: mine.id }, savedSays(mine)) : { outcome: 'ask' };
  }

  // A confirmed fact first, then the user's own answer, then a value copied from their document.
  // When the user also answered this very question, their words for it are used. Where the two disagree,
  // the later of them is what the user means now; said within a minute of each other, or undated, both wait for them.
  let superseded = false;
  if (fact?.fact.confirmed && fromFact && 'answer' in fromFact) {
    const agrees = !!mine && (fact.fact.basis.answerId === mine.id
      || folded(inShape(shape, mine.answer) ?? mine.answer) === folded(fromFact.answer)
      || folded(valueFromAnswer(fact.asked, question, mine.answer) ?? '') === folded(fact.value));
    const newer = mine && !agrees ? later(fact.fact.updatedAt, mine.updatedAt) : null;
    if (!mine || newer === 'fact') {
      trace('fact');
      return vetted(resting({ outcome: 'answer', answer: fromFact.answer, from: `the profile's ${fact.label.toLowerCase()}`, by: 'user' }, factSays(fact)), fact.fact);
    }
    if (!agrees && newer !== 'answer') return { outcome: 'draft', draft: fromFact.answer, why: COPY.bothSay.replace('{fact}', fact.value).replace('{answer}', mine.answer) };
    superseded = !agrees;
  }
  if (mine) {
    const shaped = inShape(shape, mine.answer);
    if (shaped !== null && held) drafts.push({ draft: shaped, why: savedSays(mine) });
    else if (shaped !== null) {
      trace('key');
      return vetted(resting({ outcome: 'answer', answer: shaped, from: 'a saved answer', by: 'user', answerId: mine.id }, savedSays(mine)), { value: mine.answer, updatedAt: mine.updatedAt });
    }
    const fitted = fit(shape, mine.answer);
    if (fitted) drafts.push({ draft: fitted, why: COPY.savedOtherShape.replace('{answer}', mine.answer) });
  }

  // The user's answer to the same thing worded otherwise.
  const ik = cls && def && def.reuse !== 'never' ? intentKey(cls, by) : null;
  const viaIntent = ik ? deps.profile.answerByIntent(ik) : null;
  if (viaIntent && viaIntent.id !== mine?.id && cls && def) {
    const shaped = inShape(shape, viaIntent.answer) ?? fromYears(def, question, shape, viaIntent.answer);
    const from = COPY.sameQuestion.replace('{question}', viaIntent.question);
    if (shaped !== null && cls.exact && def.reuse !== 'draft' && !held) {
      trace('intent');
      return vetted(resting({ outcome: 'answer', answer: shaped, from, by: 'user', answerId: viaIntent.id }, savedSays(viaIntent)), { value: viaIntent.answer, updatedAt: viaIntent.updatedAt });
    }
    const fitted = shaped ?? fit(shape, viaIntent.answer);
    if (fitted) drafts.push({ draft: fitted, why: from });
  }

  // Knowing someone at one company says nothing about another: the user's answer for every company, else a No they gave elsewhere as a draft.
  if (def?.id === 'referral.know_anyone' && cls?.exact && (shape.kind === 'yes_no' || shape.kind === 'choice')) {
    const general = deps.profile.answerByIntent(EVERY_COMPANY);
    const shaped = general ? inShape(shape, general.answer) ?? fit(shape, general.answer) : null;
    if (general && shaped) {
      trace('intent');
      return resting({ outcome: 'answer', answer: shaped, from: COPY.everyCompany.replace('{question}', general.question), by: 'user', answerId: general.id }, savedSays(general));
    }
    const no = deps.profile.userAnswersUnder(`${EVERY_COMPANY}:`).find((a) => a.intent !== ik && /^\s*no\b/i.test(a.answer));
    const draft = no ? fit(shape, 'No') : null;
    if (no && draft) drafts.push({ draft, why: COPY.saidNoFor.replace('{company}', companyIn(no.intent ?? '')) });
  }

  if (elsewhere) return elsewhere;

  if (fact && fromFact && !superseded) {
    if ('answer' in fromFact && fact.fact.confirmed) return resting({ outcome: 'answer', answer: fromFact.answer, from: `the profile's ${fact.label.toLowerCase()}`, by: 'user' }, factSays(fact));
    if ('answer' in fromFact) {
      trace('document');
      return { outcome: 'answer', answer: fromFact.answer, from: fact.fact.from ? `the user's document "${fact.fact.from}"` : 'the user\'s document', by: 'fanfold', quote: fact.value };
    }
    drafts.push(fromFact);
  }

  if (cls && def) {
    const worked = await resolve({ question, shape, by, deps, cls, def, record, now, viaPattern: !!candidate });
    const capped = worked ? cap(worked, cls, def) : null;
    if (capped?.outcome === 'answer') {
      trace('resolve');
      return capped;
    }
    if (capped?.outcome === 'draft') drafts.push(capped);
  }

  if (saved && !mine) {
    const fitted = fit(shape, saved.answer);
    if (fitted) drafts.push({ draft: fitted, why: COPY.agentSaved });
  }
  // A near wording of "know anyone at X" is about another company: never offered from it.
  if (scope === 'person' && def?.reuse !== 'never' && def?.id !== 'referral.know_anyone') {
    const near = deps.profile.nearAnswer(key);
    const fitted = near ? fit(shape, near.answer.answer) : null;
    if (near && fitted) drafts.push({ draft: fitted, why: COPY.near.replace('{question}', near.answer.question) });
  }
  return drafts[0] ? { outcome: 'draft', ...drafts[0] } : held ? { outcome: 'ask', why: held } : { outcome: 'ask' };
}

/**
 * Whether only the user's own word answers this question (D4): by its words,
 * by the profile field it asks for, or by what it is known to ask. A model or
 * a host saying otherwise does not make it less so.
 */
export function isSensitive(question: string, kind: QuestionKind | undefined, by: Asker | null, deps: Pick<KnownDeps, 'profile' | 'intents'>): boolean {
  const q = clean(question);
  if (sensitiveAsked(q)) return true;
  const asked = fieldAsked(unnumbered(q), placeWords(deps.profile.fact('location')?.value));
  if (asked && SENSITIVE_FIELDS.has(asked.field)) return true;
  const cls = classified(q, kind ?? 'text', by, deps);
  return !!(cls && INTENT.get(cls.intent)?.sensitive);
}

/** What the user is asked about themselves that Fanfold answers in full whenever it holds it, beyond a profile field. */
const ABOUT_THEM = /^(?:notice|start|salary|work|location|experience)\./;

/**
 * Whether this question asks about the user themselves, as something
 * Fanfold answers whenever it holds the answer (a profile field, notice,
 * start, pay, the right to work, where they are, their experience): when
 * Fanfold holds none, nothing else fills it. Read as isSensitive reads it.
 */
export function aboutUser(question: string, kind: QuestionKind | undefined, by: Asker | null, deps: Pick<KnownDeps, 'profile' | 'intents'>): boolean {
  const cls = classified(clean(question), kind ?? 'text', by, deps);
  const def = cls ? INTENT.get(cls.intent) : undefined;
  return !!def && def.scope === 'person' && def.ceiling === 'answer' && (!!def.field || ABOUT_THEM.test(def.id));
}

/**
 * Whether two answers say the same: alike once case, accents and
 * punctuation are set aside, the same Yes or No, or a bare number typed for
 * the one number held ("70" for "70 LPA", "30" for "30 days"; not "56" for "5600000").
 */
export function sameAnswer(held: string, typed: string): boolean {
  const plain = (v: string): string => folded(v).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = plain(held);
  const b = plain(typed);
  if (a === b) return true;
  const polarity = (v: string): string | null => (/^(yes|y|true)\b/.test(v) ? 'yes' : /^(no|n|false)\b/.test(v) ? 'no' : null);
  if (polarity(a) !== null && polarity(a) === polarity(b)) return true;
  const bare = /^\d[\d,]*(?:\.\d+)?$/.exec(typed.trim());
  const numbers = held.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const value = (n: string): number => Number(n.replace(/,/g, ''));
  return !!bare && numbers.length === 1 && value(numbers[0]) === value(bare[0]);
}

/**
 * Whether a value an agent typed is what Fanfold holds from the user for this
 * question: a confirmed fact or the user's own saved answer, saying the same.
 * Anything else, a proposal included, does not back it.
 */
export function backedByUser(k: Known, typed: string): boolean {
  return k.outcome === 'answer' && k.by === 'user' && sameAnswer(k.answer, typed);
}

/** The suggestion to show for a question waiting on the user, or null. */
export async function suggestionFor(asked: Asked & { draft?: string | null; draftWhy?: string | null }, by: Asker | null, deps: KnownDeps): Promise<{ value: string; from: string } | null> {
  const k = await known(asked, by ?? { company: '', title: '', url: '' }, deps);
  // Said to the owner, about their own things: "your document", never "the user's".
  const yours = (text: string): string => text.replace(/\bthe user['’]s\b/g, 'your').replace(/\bThe user['’]s\b/g, 'Your');
  if (k.outcome === 'answer') return { value: k.answer, from: yours(k.from) };
  if (k.outcome === 'draft') return { value: k.draft, from: yours(k.why) };
  return asked.draft ? { value: asked.draft, from: yours(asked.draftWhy ?? '') } : null;
}

/** What an answer rests on, with the value itself ("the profile's notice period is "30 days""), for an answer whose result carries no statement. */
const RESTS_ON = new WeakMap<object, string>();

/** An answer, remembered with the value it rests on. */
function resting<K extends Known>(k: K, on: string): K {
  RESTS_ON.set(k, on);
  return k;
}

/** The one line an answer rests on, its value included: its statement, its quote, or what it was taken from and what that says. */
export function restsOn(k: Answer): string {
  return k.statement ?? RESTS_ON.get(k) ?? `${k.from}${k.quote ? `: "${k.quote}"` : ''}`;
}

/** Answers that rest on what the documents say outright, which an intent stopping at a draft still allows: "6 years of Go". */
const STATED = new WeakSet<object>();

/** The most Fanfold may do on its own: an intent that stops at a draft, or a question that asks more than the intent, waits for the user. */
function cap(k: Known, cls: Classified, def: IntentDef): Known | null {
  if (k.outcome !== 'answer') return k;
  if (def.ceiling === 'ask') return null;
  if (def.ceiling === 'draft' && !STATED.has(k)) return { outcome: 'draft', draft: k.answer, why: k.statement ?? k.from };
  if (!cls.exact) return { outcome: 'draft', draft: k.answer, why: COPY.inexact.replace('{about}', def.about) };
  // A sensitive answer is the user's own word or nothing (D4).
  if (def.sensitive && k.by !== 'user') return { outcome: 'draft', draft: k.answer, why: k.statement ?? k.from };
  return k;
}

/** Why the user's word on this disagrees with their own documents, or null when it does not. */
function contradiction(def: IntentDef, value: string, record: CareerRecord | null, now: Date): string | null {
  if (!record) return null;
  if (def.id === 'experience.total_years') {
    const t = totalYearsBasis(record, now);
    const n = /^\s*(\d+(?:\.\d+)?)/.exec(value);
    if (!t.ok || !n || Math.floor(Number(n[1])) === t.years) return null;
    return COPY.disagree.replace('{mine}', value).replace('{title}', docTitle(record, t.roles[0]?.documentId ?? '')).replace('{theirs}', `${t.years} years`);
  }
  const role = currentRole(record);
  if (!role) return null;
  const theirs = def.id === 'employer.current' ? role.employer : def.id === 'title.current' ? role.title : '';
  if (!theirs) return null;
  const a = quoteFolded(value);
  const b = quoteFolded(theirs);
  if (a.includes(b) || b.includes(a)) return null;
  return COPY.disagree.replace('{mine}', value).replace('{title}', docTitle(record, role.documentId)).replace('{theirs}', theirs);
}

// ------------------------------------------------------------------ shape

/** A fact as the form takes it: an answer when it fits as it is, a draft when it must be changed to fit. */
function shapeFact(f: FactAnswer, question: string, shape: Shape): { answer: string } | { draft: string; why: string } | null {
  const says = COPY.factSays.replace('{label}', f.label.toLowerCase()).replace('{value}', f.value);
  if (f.draft) {
    const v = fit(shape, f.value);
    return v ? { draft: v, why: f.draft } : null;
  }
  // A city asked on its own gets the city: "Bengaluru" from "Bengaluru, India", as the user's own words.
  if (f.field === 'location' && CITY_ALONE.test(question) && !OTHER_PLACE.test(question)) {
    const city = f.value.split(',')[0].trim();
    if (city) return shape.kind === 'text' ? { answer: city } : inShape(shape, city) !== null ? { answer: inShape(shape, city)! } : null;
  }
  if (shape.kind === 'text') return { answer: f.value };
  if (shape.kind === 'number') return numberFrom(f, question, says);
  const v = inShape(shape, f.value);
  if (v !== null) return { answer: v };
  const fitted = fit(shape, f.value);
  return fitted ? { draft: fitted, why: says } : null;
}

/** The country of the job asking, when the ledger knows where it is. */
function jobCountry(by: Asker, deps: KnownDeps): string | null {
  const job = (by.jobId ? deps.jobs.job(by.jobId) : null) ?? (by.url ? deps.jobs.forPosting(by.url)?.job : null);
  return job?.location ? countryOfPlace(job.location) : null;
}

/**
 * A question the work authorisation entries answer: what it asks, and the
 * one country it is about. The country is the one the question names, else
 * the job's ("Are you authorised to work in the country you are applying
 * to?"); `named` says the question named it. Null for any other question, and
 * for one known only as asking more than this.
 */
function rightsAsked(question: string, shape: Shape, cls: Classified | null, by: Asker, deps: KnownDeps): { ask: RightsAsk; named: boolean } | null {
  const intent = cls && RIGHTS_INTENTS.has(cls.intent) ? cls.intent : null;
  if (!intent || !cls?.exact) return null;
  const what = rightsKind(intent, question, shape);
  if (!what) return null;
  const inQuestion = [...new Set(countriesIn(question))];
  const param = cls.params.country ? countryNamed(cls.params.country) ?? countriesIn(cls.params.country)[0] ?? null : null;
  const named = inQuestion.length === 1 ? inQuestion[0] : inQuestion.length ? null : param;
  const country = named ?? (inQuestion.length > 1 ? null : jobCountry(by, deps));
  return { ask: { ...what, country, several: inQuestion.length > 1, shape }, named: !!named };
}

/** A question for the city alone, and the words that ask for more than the city. */
const CITY_ALONE = /\b(?:city|town)\b/i;
const OTHER_PLACE = /\b(?:country|state|province|region|address|postcode|postal|zip|pin ?code)\b|,|\band\b/i;

const UNITS: Record<string, number> = { day: 1, week: 7, month: 30 };

/**
 * A number field from a fact: the number when the fact is one, or the
 * question names the fact's unit ("Notice period (in days)" from "60 days").
 * A number in another unit, or with more said around it, is a draft.
 */
function numberFrom(f: FactAnswer, question: string, says: string): { answer: string } | { draft: string; why: string } | null {
  const m = /^[$€£₹]?\s?(\d[\d,]*(?:\.\d+)?)\s*([a-z]+)?/i.exec(f.value.trim());
  if (!m) return /^(?:immediate(?:ly)?|none|nil|no notice)/i.test(f.value.trim()) ? { draft: '0', why: says } : null;
  const n = m[1].replace(/,/g, '');
  const unit = m[2]?.toLowerCase().replace(/s$/, '');
  const more = f.value.trim().slice(m[0].length).trim();
  if (more) return { draft: n, why: says };
  if (!unit) return { answer: n };
  const asked = normaliseQuestion(question).split(' ').map((w) => w.replace(/s$/, ''));
  if (asked.includes(unit)) return { answer: n };
  const want = asked.find((w) => w in UNITS);
  if (want && unit in UNITS) {
    const amount = Math.round((Number(n) * UNITS[unit]) / UNITS[want] * 10) / 10;
    return { draft: String(amount), why: COPY.converted.replace('{label}', f.label.toLowerCase()).replace('{value}', f.value).replace('{amount}', String(amount)).replace('{unit}', `${want}s`) };
  }
  return { draft: n, why: says };
}

/** A value put in the form's shape where its meaning is plain: "No, I don't" for a yes/no, the one choice that names it. Null when it is not. */
function fit(shape: Shape, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const exact = inShape(shape, v);
  if (exact !== null) return exact;
  if (shape.kind === 'yes_no') return /^(?:yes|yeah|yep)\b/i.test(v) ? 'Yes' : /^(?:no|nope|not|none)\b/i.test(v) ? 'No' : null;
  if (shape.kind === 'choice') {
    const hits = shape.choices.filter((c) => folded(c).includes(folded(v)) || folded(v).includes(folded(c)));
    return hits.length === 1 ? hits[0] : null;
  }
  if (shape.kind === 'number') return /^[$€£₹]?\s?(\d[\d,]*(?:\.\d+)?)/.exec(v)?.[1]?.replace(/,/g, '') ?? null;
  return v;
}

/** "At least 5 years", "5+ years", "more than 5 years": the least that would be Yes. */
function threshold(question: string): number | null {
  const m = /\b(at least|minimum(?: of)?|min\.?|over|more than|greater than)?\s*(\d{1,2})\s*(\+|plus)?\s*(?:years?|yrs)\b/i.exec(question);
  if (!m) return null;
  const n = Number(m[2]);
  return /over|more|greater/i.test(m[1] ?? '') ? n + 1 : n;
}

/** What a choice spans, in years: "3-5 years", "5+", "Less than 1 year", "None". */
function span(choice: string): [number, number] | null {
  const c = choice.toLowerCase();
  if (/\b(?:none|no experience|never)\b/.test(c) || /^\s*0\s*(?:years?)?\s*$/.test(c)) return [0, 0];
  const less = /(?:less than|under|<|fewer than|below)\s*(\d+(?:\.\d+)?)/.exec(c);
  if (less) return [0, Number(less[1]) - 0.001];
  const more = /(\d+(?:\.\d+)?)\s*(?:\+|or more|plus|and above|and more|years? or more)|(?:more than|over|above|>)\s*(\d+(?:\.\d+)?)/.exec(c);
  const range = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/.exec(c);
  if (range) return [Number(range[1]), Number(range[2])];
  if (more) return more[1] !== undefined ? [Number(more[1]), Infinity] : [Number(more[2]) + 0.001, Infinity];
  const one = /^\D*(\d+(?:\.\d+)?)\D*$/.exec(c);
  return one ? [Number(one[1]), Number(one[1])] : null;
}

/**
 * A number of years in the form's shape: itself, the one choice whose span
 * holds it, or Yes/No against the years the question names. Null when it
 * does not fit plainly, say two choices hold it or none does.
 */
function yearsShaped(n: number, question: string, shape: Shape): string | null {
  if (shape.kind === 'number' || shape.kind === 'text') return String(n);
  if (shape.kind === 'yes_no') {
    const least = threshold(question);
    return least === null ? null : n >= least ? 'Yes' : 'No';
  }
  const holding = shape.choices.filter((c) => {
    const s = span(c);
    return s && n >= s[0] && n <= s[1];
  });
  return holding.length === 1 ? holding[0] : null;
}

/** The choice nearest a number, for a draft when none holds it exactly. */
function nearestChoice(n: number, shape: Shape): string | null {
  let best: { c: string; d: number } | null = null;
  for (const c of shape.choices) {
    const s = span(c);
    if (!s) continue;
    const d = n < s[0] ? s[0] - n : n > s[1] ? n - s[1] : 0;
    if (!best || d < best.d) best = { c, d };
  }
  return best?.c ?? null;
}

/** The user's number of years, said for one wording, put in another's shape ("6" for "Do you have 5+ years?"). */
function fromYears(def: IntentDef, question: string, shape: Shape, answer: string): string | null {
  if (def.id !== 'experience.skill_years' && def.id !== 'experience.total_years') return null;
  const n = /^\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs)?\s*$/i.exec(answer);
  return n ? yearsShaped(Math.floor(Number(n[1])), question, shape) : null;
}

// ------------------------------------------------------------- resolving

interface Resolving {
  question: string; shape: Shape; by: Asker; deps: KnownDeps; cls: Classified; def: IntentDef;
  record: () => CareerRecord | null; now: Date;
  /** A field pattern already had its say. */
  viaPattern: boolean;
}

/** An answer Fanfold worked out from the user's documents, with what it rests on, kept so a record that reports it can be checked. */
function fromRecord(r: Resolving, answer: string, statement: string, items: Array<{ quote: string; documentId: string }>): Answer {
  const record = r.record()!;
  const quotes: Quote[] = items.map((i) => ({ quote: i.quote, documentId: i.documentId, title: docTitle(record, i.documentId) }));
  const title = quotes[0]?.title ?? '';
  return {
    outcome: 'answer', answer, from: title ? COPY.document.replace('{title}', title) : 'the user\'s documents', by: 'fanfold', quote: quotes[0]?.quote,
    statement, quotes,
    derived: {
      jobId: r.def.scope === 'job' && !r.def.params?.includes('company') ? jobKey(r.by) : null,
      basis: {
        from: 'career', intent: r.cls.intent, statement, quotes, documentIds: [...new Set(items.map((i) => i.documentId))],
        // What it answers in every wording: taking it back takes it back for all of them.
        intentKey: intentKey(r.cls, r.by),
      },
    },
  };
}

const NAME_PARTS: ReadonlySet<string> = new Set(['contact.first_name', 'contact.last_name']);

const roleSaid = (role: Role): string => `${role.employer} ${said(role.start)} – ${said(role.end)}`;

async function resolve(r: Resolving): Promise<Known | null> {
  const { def, shape, question } = r;
  // A field a model or the seed said this asks: the fact for that field, as a pattern would have found it.
  // Part of the name is only ever what factFor cut from it: the whole name is not a first or a last name.
  // Where they may work is answered from the entries alone (rightsAsked), never from a line of text.
  if (def.field && !r.viaPattern && !NAME_PARTS.has(def.id) && !RIGHTS_FIELDS.has(def.field)) {
    const field = fieldFact(r.deps.profile, def.field);
    const country = r.cls.params.country;
    if (field && (!country || quoteFolded(field.value).includes(quoteFolded(country)))) {
      const shaped = shapeFact(field, question, shape);
      if (shaped && 'answer' in shaped) {
        return resting({ outcome: 'answer', answer: shaped.answer, from: `the profile's ${field.label.toLowerCase()}`, by: field.fact.confirmed ? 'user' : 'fanfold', ...(field.fact.confirmed ? {} : { quote: field.value }) }, factSays(field));
      }
      if (shaped) return { outcome: 'draft', ...shaped };
    }
  }
  const record = r.record();
  switch (def.id) {
    case 'experience.total_years': return totalYearsOf(r, record);
    case 'experience.skill_years': return skillYears(r, record);
    case 'experience.has_skill': {
      const skill = canonicalSkill(r.cls.params.skill ?? '');
      if (!record || !skill || (shape.kind !== 'yes_no' && shape.kind !== 'choice')) return null;
      const item = hasSkill(record, skill);
      if (item) {
        const yes = fit(shape, 'Yes');
        return yes ? fromRecord(r, yes, COPY.names.replace('{skill}', skill).replace('{quote}', item.quote), [item]) : null;
      }
      const no = plainSkill(skill) ? fit(shape, 'No') : null;
      return no ? { outcome: 'draft', draft: no, why: COPY.notMentioned.replace('{skill}', skill) } : null;
    }
    case 'employer.current':
    case 'title.current': {
      if (!record) return null;
      const pick = (role: Role): string => (def.id === 'employer.current' ? role.employer : role.title);
      const now = currentRole(record);
      if (now && pick(now)) {
        // Two documents that disagree on whether, or as what, they still work there: both are shown, neither is taken.
        const stale = staleRole(record, now, r.now) ?? roleDispute(record, now, 'dates') ?? (def.id === 'title.current' ? roleDispute(record, now, 'title') : null);
        const answer = inShape(shape, pick(now));
        const statement = COPY.current.replace('{employer}', now.employer).replace('{start}', said(now.start));
        if (stale || answer === null) return { outcome: 'draft', draft: pick(now), why: stale ?? statement };
        return fromRecord(r, answer, statement, [now]);
      }
      const last = newestRole(record);
      if (!last || !pick(last)) return null;
      const statement = COPY.newest.replace('{employer}', last.employer).replace('{end}', said(last.end));
      const disputed = roleDispute(record, last, 'dates') ?? (def.id === 'title.current' ? roleDispute(record, last, 'title') : null);
      if (disputed) return { outcome: 'draft', draft: pick(last), why: disputed };
      const answer = inShape(shape, pick(last));
      // "Most recent employer" is the last one, ended or not; "current employer" may be none.
      return answer !== null && /\b(?:most recent|latest|last|previous)\b/i.test(question) ? fromRecord(r, answer, statement, [last]) : { outcome: 'draft', draft: pick(last), why: statement };
    }
    case 'notice.period': return noticeFromStart(r);
    case 'employer.worked_here': return workedAt(question, shape, { ...r.by, company: companyOf(r.cls, r.by) }, r.deps, record);
    case 'application.applied_before': return appliedBefore(r);
    case 'application.source': return heard(shape, r.by, r.deps);
    case 'education.highest':
    case 'education.degree':
    case 'education.field':
    case 'education.institution':
    case 'education.grad_year':
    case 'education.grade': return education(r, record);
    case 'certifications':
    case 'languages': return listed(r, record);
    case 'eeo.gender':
    case 'eeo.ethnicity':
    case 'eeo.veteran':
    case 'eeo.disability': {
      const pref = r.deps.profile.fact('eeoPreference');
      if (!pref?.confirmed || !/\bdecline\b/i.test(pref.value)) return null;
      const answer = shape.kind === 'text' ? pref.value
        : shape.kind === 'choice' ? shape.choices.filter((c) => /\b(?:decline|prefer not|do not wish|don'?t wish|not (?:to )?(?:say|disclose|answer|specify)|choose not)\b/i.test(c)).at(0) ?? null
        : null;
      return answer ? resting({ outcome: 'answer', answer, from: COPY.eeo, by: 'user' }, COPY.profileSays.replace('{label}', LABELS.eeoPreference.toLowerCase()).replace('{value}', pref.value)) : null;
    }
    default: return null;
  }
}

const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, six: 6 };

/**
 * A notice period from the earliest start the user confirmed, when that
 * names a length ("Can join within 1 month"): only ever a suggestion, since
 * when someone can start is not always how long their notice is.
 */
function noticeFromStart(r: Resolving): Known | null {
  const { profile } = r.deps;
  if (profile.fact('noticePeriod')?.usable) return null;
  const start = profile.fact('earliestStart');
  const m = start?.confirmed ? /\b(\d+(?:\.\d+)?|an?|one|two|three|four|six)\s*(day|week|month)s?\b/i.exec(start.value) : null;
  if (!start || !m) return null;
  const n = COUNTS[m[1].toLowerCase()] ?? Number(m[1]);
  const unit = m[2].toLowerCase();
  const length = `${n} ${unit}${n === 1 ? '' : 's'}`;
  const why = COPY.fromStart.replace('{value}', start.value);
  if (r.shape.kind === 'text') return { outcome: 'draft', draft: length, why };
  if (r.shape.kind === 'number') {
    const asked = normaliseQuestion(r.question).split(' ').map((w) => w.replace(/s$/, '')).find((w) => w in UNITS);
    const amount = asked ? Math.round((n * UNITS[unit]) / UNITS[asked] * 10) / 10 : n;
    return { outcome: 'draft', draft: String(amount), why };
  }
  if (r.shape.kind !== 'choice') return null;
  const days = n * UNITS[unit];
  const draft = fit(r.shape, length) ?? fit(r.shape, `${days} days`);
  return draft ? { outcome: 'draft', draft, why } : null;
}

/**
 * A skill a résumé would name if the user had it: one word ("Kafka") or a
 * known name ("machine learning"). "Leading teams" is not one, and its
 * absence from a résumé says nothing.
 */
function plainSkill(skill: string): boolean {
  return !skill.includes(' ') || skillForms(skill).length > 1 || KNOWN_SKILLS.includes(skill);
}

/** The fact for a field, as factFor gives one: usable, and confirmed when the field is sensitive. */
function fieldFact(profile: Profile, field: ProfileField): FactAnswer | null {
  const fact = profile.fact(field);
  if (!fact?.usable || (SENSITIVE_FIELDS.has(field) && !fact.confirmed)) return null;
  return { field, label: LABELS[field], value: fact.value, fact, asked: { field, places: [] } };
}

function totalYearsOf(r: Resolving, record: CareerRecord | null): Known | null {
  // A threshold asked of a confirmed total: "Do you have at least 5 years of experience?"
  const fact = r.deps.profile.fact('yearsExperience');
  // "4+" and "about 4" are 4.
  const n = fact?.confirmed ? yearsIn(fact.value, true) : null;
  if (n !== null && r.shape.kind === 'yes_no') {
    const answer = yearsShaped(Math.floor(n), r.question, r.shape);
    return answer ? resting({ outcome: 'answer', answer, from: 'the profile\'s years of experience', by: 'user' }, COPY.profileSays.replace('{label}', LABELS.yearsExperience.toLowerCase()).replace('{value}', fact!.value)) : null;
  }
  if (!record) return null;
  const t = totalYearsBasis(record, r.now);
  if (!t.ok) {
    if (t.estimate === null) return null;
    const draft = yearsShaped(t.estimate, r.question, r.shape) ?? nearestChoice(t.estimate, r.shape);
    return draft ? { outcome: 'draft', draft, why: COPY.estimate.replace('{years}', String(t.estimate)).replace('{why}', t.why) } : null;
  }
  const statement = COPY.totalYears.replace('{years}', String(t.years)).replace('{roles}', t.roles.map(roleSaid).join(', '));
  const answer = yearsShaped(t.years, r.question, r.shape);
  if (answer === null) {
    const near = nearestChoice(t.years, r.shape);
    return near ? { outcome: 'draft', draft: near, why: statement } : null;
  }
  return fromRecord(r, answer, statement, t.roles);
}

function skillYears(r: Resolving, record: CareerRecord | null): Known | null {
  const skill = canonicalSkill(r.cls.params.skill ?? '');
  if (!record || !skill) return null;
  const stated = record.stated.find((s) => s.skill === skill);
  if (stated) {
    const answer = yearsShaped(stated.years, r.question, r.shape);
    const statement = COPY.stated.replace('{quote}', stated.quote);
    const disputed = statedDispute(record, stated);
    if (disputed) {
      const draft = answer ?? nearestChoice(stated.years, r.shape);
      return draft ? { outcome: 'draft', draft, why: disputed } : null;
    }
    // More years with one skill than of work in all is not something to send on the document's word.
    const total = allYears(r, record);
    if (total !== null && stated.years > total + 1) {
      const draft = answer ?? nearestChoice(stated.years, r.shape);
      const why = COPY.moreThanTotal.replace('{quote}', stated.quote).replace('{total}', String(total));
      return draft ? { outcome: 'draft', draft, why } : null;
    }
    if (answer !== null) {
      const k = fromRecord(r, answer, statement, [stated]);
      STATED.add(k);
      return k;
    }
    const near = nearestChoice(stated.years, r.shape);
    return near ? { outcome: 'draft', draft: near, why: statement } : null;
  }
  const spanned = skillSpanYears(record, skill, r.now);
  if (spanned) {
    const draft = yearsShaped(spanned.years, r.question, r.shape) ?? nearestChoice(spanned.years, r.shape);
    const why = COPY.skillSpan.replace('{roles}', spanned.roles.map((x) => x.employer).join(' and ')).replace(/\{skill\}/g, skill).replace('{years}', String(spanned.years));
    return draft ? { outcome: 'draft', draft, why } : null;
  }
  if (hasSkill(record, skill) || !plainSkill(skill)) return null;
  // Never mentioned: nothing says how much, so "none" is for the user to confirm.
  const draft = yearsShaped(0, r.question, r.shape) ?? nearestChoice(0, r.shape);
  return draft ? { outcome: 'draft', draft, why: COPY.notMentioned.replace('{skill}', skill) } : null;
}

/** Years of work in all, as the profile or the résumé gives them; null when neither can say. */
function allYears(r: Resolving, record: CareerRecord): number | null {
  const fact = r.deps.profile.fact('yearsExperience');
  const n = fact?.confirmed ? yearsIn(fact.value, true) : null;
  if (n !== null) return Math.floor(n);
  const t = totalYearsBasis(record, r.now);
  return t.ok ? t.years : t.estimate;
}

function education(r: Resolving, record: CareerRecord | null): Known | null {
  if (!record?.education.length) return null;
  const top: Study | null = highestDegree(record) ?? (record.education.length === 1 ? record.education[0] : null);
  if (!top) return null;
  const statement = COPY.studied.replace('{degree}', [top.degree, top.field].filter(Boolean).join(' ') || 'study').replace('{institution}', top.institution);
  // Two of the user's documents that tell their studies differently: both are shown, neither is taken.
  const disputed = studyDispute(record, top) ?? degreeDispute(record);
  let value: string | null = null;
  switch (r.def.id) {
    case 'education.highest':
    case 'education.degree': {
      const written = [top.degree, top.field].filter(Boolean).join(' ');
      if (r.shape.kind === 'choice') {
        const level = degreeLevel(top.degree)?.level;
        const word = level === 'doctorate' ? /ph\.?\s?d|doctor/i : level === 'master' ? /master/i : level === 'bachelor' ? /bachelor/i
          : level === 'associate' ? /associate/i : level === 'diploma' ? /diploma/i : level === 'high school' ? /high school|secondary/i : null;
        const hits = word ? r.shape.choices.filter((c) => word.test(c)) : [];
        if (hits.length !== 1) return null;
        return disputed ? { outcome: 'draft', draft: hits[0], why: disputed } : fromRecord(r, hits[0], statement, [top]);
      }
      value = written || null;
      break;
    }
    case 'education.field': value = top.field || null; break;
    case 'education.institution': value = top.institution || null; break;
    case 'education.grad_year': value = top.end ? String(top.end.y) : null; break;
    case 'education.grade': value = top.grade; break;
  }
  if (!value) return null;
  const answer = inShape(r.shape, value);
  if (disputed) return { outcome: 'draft', draft: answer ?? value, why: disputed };
  return answer !== null ? fromRecord(r, answer, statement, [top]) : null;
}

function listed(r: Resolving, record: CareerRecord | null): Known | null {
  if (!record) return null;
  const items = r.def.id === 'certifications' ? record.certifications : record.languages;
  // A résumé that names no language says nothing about which ones the user speaks: that is theirs to say, not a "None" to accept.
  if (r.def.id === 'languages' && !items.length) return null;
  const topic = r.cls.params.topic ? quoteFolded(r.cls.params.topic) : '';
  const matching = topic ? items.filter((i) => quoteFolded(i.name).includes(topic) || quoteFolded(i.quote).includes(topic)) : items;
  if (r.shape.kind === 'yes_no') {
    if (matching.length) return fromRecord(r, 'Yes', matching.map((i) => i.name).join('; '), matching.slice(0, 3));
    return { outcome: 'draft', draft: 'No', why: COPY.noneListed };
  }
  if (r.shape.kind !== 'text') return null;
  if (!matching.length) return { outcome: 'draft', draft: 'None', why: COPY.noneListed };
  return fromRecord(r, matching.map((i) => i.name).join('; '), matching.map((i) => i.name).join('; '), matching.slice(0, 5));
}

/** "Have you applied to Acme before?": Yes when the ledger holds an application to Acme sent before today. */
function appliedBefore(r: Resolving): Known | null {
  const company = companyOf(r.cls, r.by);
  if (company.length < 2 || r.shape.kind === 'number' || !r.deps.jobs.list) return null;
  const today = new Date(r.now.getFullYear(), r.now.getMonth(), r.now.getDate()).toISOString();
  const current = r.by.jobId ?? (r.by.url ? r.deps.jobs.forPosting(r.by.url)?.job.canonicalId : undefined);
  const sent = r.deps.jobs.list({ status: ['applied', 'unconfirmed'], search: company, limit: 100 })
    .filter((a) => namesCompany(a.job.company, company) && a.job.canonicalId !== current && (a.submittedAt ?? a.updatedAt) < today);
  if (sent.length) {
    const yes = fit(r.shape, 'Yes');
    if (!yes) return null;
    const a = sent[sent.length - 1];
    const quote = COPY.applied.replace('{company}', a.job.company).replace('{title}', a.job.title).replace('{date}', (a.submittedAt ?? a.updatedAt).slice(0, 10));
    return {
      outcome: 'answer', answer: yes, from: COPY.ledger, by: 'fanfold', quote, statement: quote, quotes: [{ quote }],
      derived: { jobId: null, basis: { from: 'ledger', intent: r.cls.intent, applicationId: a.id, statement: quote } },
    };
  }
  const no = fit(r.shape, 'No');
  return no ? { outcome: 'draft', draft: no, why: COPY.notApplied.replace('{company}', company) } : null;
}

// ------------------------------------------------------------ worked out

const SITES: Array<[RegExp, string]> = [
  [/(^|\.)linkedin\.com$/, 'LinkedIn'], [/(^|\.)indeed\.[a-z.]+$/, 'Indeed'], [/(^|\.)naukri\.com$/, 'Naukri'],
  [/(^|\.)glassdoor\.[a-z.]+$/, 'Glassdoor'], [/(^|\.)(?:wellfound\.com|angel\.co)$/, 'Wellfound'], [/(^|\.)instahyre\.com$/, 'Instahyre'],
  [/(^|\.)(?:foundit\.in|monsterindia\.com)$/, 'foundit'], [/(^|\.)hirist\.(?:com|tech)$/, 'Hirist'], [/(^|\.)cutshort\.io$/, 'Cutshort'],
  [/(^|\.)iimjobs\.com$/, 'iimjobs'], [/(^|\.)ycombinator\.com$/, 'Y Combinator'],
];
/** Hosts that serve a company's own careers pages. */
const CAREERS = /(^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|icims\.com|jobvite\.com|bamboohr\.com|recruitee\.com|teamtailor\.com|personio\.(?:de|com)|breezy\.hr)$/;
const COMPANY_SITE = 'Company website';

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

/**
 * The site a job was found on, by name: a job board by its name; the
 * company's own careers pages (an ATS, a host naming the company even in
 * part, or the very site the form is on) as the company's website; any other
 * site by its address. Null only when there is no address.
 */
function siteName(url: string, company: string, formUrl: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const named = SITES.find(([re]) => re.test(host))?.[1];
  if (named) return named;
  const flat = host.replace(/[^a-z0-9]/g, '');
  const words = company.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !GENERIC_COMPANY.has(w));
  const own = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (atsIdentity(url) || CAREERS.test(host) || (own.length >= 3 && flat.includes(own)) || words.some((w) => flat.includes(w))) return COMPANY_SITE;
  if (formUrl && hostOf(formUrl) === host) return COMPANY_SITE;
  return host;
}

/** Words in many companies' names, which say nothing about whose site a host is. */
const GENERIC_COMPANY = new Set(['labs', 'tech', 'technologies', 'systems', 'software', 'group', 'global', 'solutions', 'works', 'company', 'corp', 'india', 'digital', 'data']);

/** "How did you hear about this job?": the site the ledger first saw it on, whatever its address says of the company. */
function heard(shape: Shape, by: Asker, deps: KnownDeps): Known | null {
  const job = (by.jobId ? deps.jobs.job(by.jobId) : null) ?? (by.url ? deps.jobs.forPosting(by.url)?.job : null);
  const first = job?.sourceUrls[0] ?? job?.url;
  if (!job || !first) return null;
  const site = siteName(first, job.company, by.url);
  if (!site) return null;
  let answer: string | null = null;
  if (shape.kind === 'text') answer = site;
  if (shape.kind === 'choice') {
    const exact = shape.choices.find((c) => folded(c) === folded(site));
    // A site known only by its address is matched by its name: "remote.example" by "Remote".
    const name = site.includes('.') ? site.split('.').slice(-2, -1)[0] ?? site : site;
    const word = site === COMPANY_SITE ? /\b(?:career|careers|website|site|corporate)\b/ : new RegExp(`\\b${escapeRe(folded(name))}\\b`);
    const hits = shape.choices.filter((c) => word.test(folded(c)));
    answer = exact ?? (hits.length === 1 ? hits[0] : null);
  }
  if (!answer) return null;
  return {
    outcome: 'answer', answer, from: 'where Fanfold found this job', by: 'fanfold', quote: first,
    derived: { jobId: jobKey({ ...by, jobId: job.canonicalId }), basis: { from: 'ledger', url: first } },
  };
}

const HEADING = /^(?:(?:professional|work|relevant|employment|career)\s+)?(experience|work history|employment(?: history)?|career history|education|skills|projects|summary|profile|certifications?|awards|publications|languages|interests|volunteering|references|achievements)\s*:?$/i;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+';
const RANGE = new RegExp(`(?:${MONTH}|\\d{1,2}/)?(?:19|20)\\d{2}\\s*(?:–|—|-|to|until)\\s*(?:(?:${MONTH}|\\d{1,2}/)?(?:19|20)\\d{2}|present|current|now|today|date)\\b`, 'i');

/** The lines under a résumé's experience heading. */
function experienceLines(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = line.length <= 40 ? HEADING.exec(line.replace(/^[#*•\s]+/, '')) : null;
    if (heading) { inside = /experience|history|employment/i.test(heading[1]); continue; }
    if (inside && line) out.push(line);
  }
  return out;
}

/** The documents the owner gave or said are theirs, with their whole text. */
async function trustedTexts(memory: KnownDeps['memory']): Promise<Array<{ id: string; title: string; text: string }>> {
  const out: Array<{ id: string; title: string; text: string }> = [];
  for (const d of memory.listDocuments().filter((doc) => doc.trusted && doc.chunks > 0)) {
    const text = await memory.documentText(d.id);
    if (text) out.push({ id: d.id, title: d.title, text: readerText(text).text });
  }
  return out;
}

/**
 * "Have you worked at Acme before?": Yes only when the user's own résumé
 * lists Acme under experience with dates; otherwise No, for them to check.
 * The career record is asked first; a résumé it has not read is read here.
 */
async function workedAt(question: string, shape: Shape, by: Asker, deps: KnownDeps, record: CareerRecord | null): Promise<Known | null> {
  const company = by.company.trim();
  if (company.length < 2 || shape.kind === 'number') return null;
  const role = record ? workedAtRole(record, company) : null;
  if (role?.start) {
    const yes = fit(shape, 'Yes');
    if (!yes) return null;
    const title = docTitle(record!, role.documentId);
    return {
      outcome: 'answer', answer: yes, from: COPY.document.replace('{title}', title), by: 'fanfold', quote: role.quote,
      derived: { jobId: null, basis: { from: 'document', documentId: role.documentId, title, quote: role.quote, question } },
    };
  }
  const docs = await trustedTexts(deps.memory);
  for (const doc of docs) {
    const lines = experienceLines(doc.text);
    for (const [i, line] of lines.entries()) {
      if (!namesCompany(line, company)) continue;
      const dated = RANGE.test(line) ? line : RANGE.test(lines[i + 1] ?? '') ? `${line} ${lines[i + 1]}` : null;
      if (!dated) continue;
      const yes = fit(shape, 'Yes');
      if (!yes) return null;
      const quote = dated.slice(0, 200);
      return {
        outcome: 'answer', answer: yes, from: COPY.document.replace('{title}', doc.title), by: 'fanfold', quote,
        derived: { jobId: null, basis: { from: 'document', documentId: doc.id, title: doc.title, quote, question } },
      };
    }
  }
  const no = fit(shape, 'No');
  return no ? { outcome: 'draft', draft: no, why: docs.length ? COPY.notEmployer.replace('{company}', company) : COPY.noResume } : null;
}

