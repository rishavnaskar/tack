/**
 * How far the user is with setting Fanfold up: signed up (their name and
 * email), a model for Fanfold's own agent, their résumé, and the things
 * almost every form asks. Nothing waits on it; it says what is still
 * missing, so the app and a host can remind them.
 */

import type { Memory } from '../memory/memory.ts';
import { LABELS, type Profile, type ProfileField } from './profile.ts';

/** What every form asks, so setup is not complete without them. */
const SETUP_REQUIRED = ['name', 'email', 'phone', 'location', 'workAuthorisation', 'sponsorship', 'noticePeriod', 'yearsExperience', 'salaryExpectation'] as const;
/** Asked often enough to offer, never needed to finish. */
const SETUP_OPTIONAL = ['earliestStart', 'currentSalary', 'linkedin', 'github', 'portfolio', 'alsoOpenTo', 'eeoPreference'] as const;

/** The settings key that keeps when the reminders come back. */
export const SNOOZE_SETTING = 'setup.snoozedUntil';

/** What the person reads. */
export const COPY = {
  resume: 'Résumé',
  model: 'Gemini key',
};

/**
 * A question that fills each detail when the user's answer to it is saved
 * (job_save_answer), worded so Fanfold knows which detail it asks for.
 */
export const SETUP_QUESTIONS: Partial<Record<ProfileField, string>> = {
  name: 'What is your full name?',
  email: 'What is your email address?',
  phone: 'What is your phone number?',
  location: 'What is your current location?',
  workAuthorisation: 'What is your work authorisation?',
  sponsorship: 'Will you need visa sponsorship now or in the future?',
  noticePeriod: 'What is your notice period?',
  yearsExperience: 'How many years of total experience do you have?',
  salaryExpectation: 'What is your expected salary?',
  earliestStart: 'What is your earliest start date?',
  currentSalary: 'What is your current salary?',
  linkedin: 'What is your LinkedIn profile URL?',
  github: 'What is your GitHub profile URL?',
  portfolio: 'What is your portfolio website?',
  alsoOpenTo: 'What other locations are you open to?',
};

/**
 * How a host writes the answer to the two questions whose answers are
 * choices, so job_save_answer can save them as entries (work-rights.ts).
 */
export const SETUP_FORMATS: Partial<Record<ProfileField, string>> = {
  workAuthorisation: 'Save the work authorisation as one line per country the user can work in, written "<country>: <status>", the status one of: '
    + 'Citizen; Permanent resident; Work visa tied to an employer; Work permit not tied to an employer; Student visa with work rights; '
    + 'Free movement or treaty right; Refugee or asylum status; Not authorised; Other: <what it is>. Add the visa\'s name in brackets and "until MM/YYYY" '
    + 'when the user gives them, for example "United States: Work visa tied to an employer (H-1B), until 06/2027". Never pick a status the user did not say.',
  sponsorship: 'Save sponsorship as one line per country, "<country>: No", "<country>: In future" or "<country>: Now", and one line for every other country: '
    + '"Anywhere else: I would need sponsorship" or "Anywhere else: I prefer not to apply where I\'d need it".',
};

interface SetupItem {
  key: string;
  label: string;
  required: boolean;
  done: boolean;
  value: string | null;
  /** Set when a value exists but the user has not confirmed it (read from a document or an agent). */
  unconfirmed: boolean;
  /** The question whose saved answer fills it, for a detail an answer can fill. */
  ask?: string;
  /** How that answer is written, for a detail kept as choices. */
  format?: string;
}

export interface SetupState {
  /** The person gave their name and email themselves; one read from a document waits for them to save it. */
  signedUp: boolean;
  /** Every required item done, the résumé included. */
  complete: boolean;
  /** Out of the required fields, the Gemini key and the résumé. */
  required: { done: number; total: number };
  /** Labels of the required items not done, in order. */
  missing: string[];
  /** The résumé first, then the required fields (the Gemini key straight after the email), then the optional ones. */
  items: SetupItem[];
  resume: { id: string; title: string } | null;
  /** Reminders stay hidden until then. */
  snoozedUntil: string | null;
  /** The key-free link that opens setup, filled in by the server; null here. */
  link: string | null;
}

/** `modelConfigured`: Fanfold's own agent has a model, from the person's own key or from .env. */
export function setupState(deps: { profile: Profile; memory: Pick<Memory, 'listDocuments'>; modelConfigured: boolean; snoozedUntil?: string | null; now?: Date }): SetupState {
  const now = deps.now ?? new Date();
  const facts = new Map(deps.profile.facts().map((f) => [f.field, f]));
  const item = (key: ProfileField, required: boolean): SetupItem => {
    const f = facts.get(key);
    // EEO is a choice of how to answer such questions, so any choice will do.
    const done = key === 'eeoPreference' ? !!f : !!f?.usable;
    const ask = SETUP_QUESTIONS[key];
    const format = SETUP_FORMATS[key];
    return { key, label: LABELS[key], required, done, value: f?.value ?? null, unconfirmed: !!f?.usable && !f.confirmed, ...(ask ? { ask } : {}), ...(format ? { format } : {}) };
  };
  // The one document chosen as the résumé. A profile from before one was chosen takes its newest readable file of the owner's.
  const docs = deps.memory.listDocuments();
  const chosen = deps.profile.resumeId();
  const resume = chosen !== undefined ? docs.find((d) => d.id === chosen && d.trusted) ?? null
    : docs.filter((d) => d.chunks > 0 && d.trusted).sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0] ?? null;
  const fields = SETUP_REQUIRED.map((k) => item(k, true));
  const signUp = fields.findIndex((i) => i.key === 'email') + 1;
  const items: SetupItem[] = [
    { key: 'resume', label: COPY.resume, required: true, done: !!resume, value: resume?.title ?? null, unconfirmed: false },
    ...fields.slice(0, signUp),
    // Alpha only: the person's own Gemini key goes when plans arrive. Its value is never here.
    { key: 'model', label: COPY.model, required: true, done: deps.modelConfigured, value: null, unconfirmed: false },
    ...fields.slice(signUp),
    ...SETUP_OPTIONAL.map((k) => item(k, false)),
  ];
  const required = items.filter((i) => i.required);
  const done = required.filter((i) => i.done).length;
  const until = deps.snoozedUntil ? Date.parse(deps.snoozedUntil) : NaN;
  return {
    signedUp: !!facts.get('name')?.confirmed && !!facts.get('email')?.confirmed,
    complete: done === required.length,
    required: { done, total: required.length },
    missing: required.filter((i) => !i.done).map((i) => i.label),
    items,
    resume: resume ? { id: resume.id, title: resume.title } : null,
    snoozedUntil: until > now.getTime() ? deps.snoozedUntil! : null,
    link: null,
  };
}
