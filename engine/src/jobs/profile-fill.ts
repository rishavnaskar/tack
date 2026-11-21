/**
 * The profile fills itself from a document the user gives Fanfold.
 *
 * Contact details are read by pattern from the top of the document, with no
 * model; with one, the rest is read too. A value written word for word in a
 * document the owner gave (their name, email, phone, location, links) can go
 * in forms at once, marked with where it came from. Everything else is a
 * proposal for the user to confirm. A document an agent added is not read at
 * all until the owner says it is theirs. Nothing here fails an import.
 */
import type { ModelLike } from '../agent/loop.ts';
import type { Memory } from '../memory/memory.ts';
import type { Logger } from '../lib/log.ts';
import { hasCvSections, namedLikeACv } from '../policy/import-hold.ts';
import { whoseText } from '../policy/upload-hold.ts';
import { extractProfile } from './extract-profile.ts';
import { factProblem, type Profile, type ProfileField, type ProfileFields } from './profile.ts';
import { headerLocation, nameIn, properName, sameName } from './profile-documents.ts';
import { appearsIn } from './wording.ts';
import { readerText } from '../memory/document-instructions.ts';
import { plainReason } from '../model/limiter.ts';

/** Fields a document can state word for word. */
const VERBATIM_FIELDS: ReadonlySet<ProfileField> = new Set(['name', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio']);

/** Fields no document answers for the user: they say how to answer the voluntary questions themselves. */
const NEVER_FROM_DOCUMENTS: ReadonlySet<string> = new Set(['eeoPreference']);

/** Why a document was not read into the profile, for the user. */
const COPY = {
  noText: 'it doesn’t have any text Fanfold can read',
  notYours: 'it doesn’t have your name on it',
  notCv: 'it doesn’t look like a résumé, CV or cover letter',
  notTrusted: 'an agent added this, and you have not confirmed it is yours',
  someoneElse: 'it carries the name {name}, not yours',
};

/** What Fanfold decided about whose a document is (profile-documents.ts). */
export interface Ownership {
  otherName(documentId: string): string | null;
  mineAnyway(documentId: string): boolean;
}

export interface FillResult {
  /** Fields this document states that forms can use at once. */
  usable: ProfileField[];
  /** Fields this document states that wait for the user to confirm them. */
  proposed: ProfileField[];
  /** Why it was not read, when it was not. */
  skipped: string | null;
  costUsd: number;
  /** Whether Fanfold's model read it: it answered, it failed and patterns alone read it, or there is no model (or nothing to read). */
  model: 'answered' | 'failed' | 'none';
  /** What the provider said when the model failed, in plain words. */
  problem: string | null;
}

/** Where contact details sit: at the top of a résumé, never among its references. */
const TOP = 1500;

/** Email, phone, LinkedIn and GitHub, as written at the top of the document. */
export function contactFacts(text: string): ProfileFields {
  const top = text.slice(0, TOP);
  const out: ProfileFields = {};
  const email = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i.exec(top)?.[0];
  if (email) out.email = email;
  for (const m of top.matchAll(/(?<![\w+])(?:\+|\()?\d[\d\s().-]{6,18}\d(?!\w)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (/\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/.test(m[0])) continue;
    if (digits.length >= 10 && digits.length <= 15) { out.phone = m[0].trim(); break; }
  }
  const linkedin = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%-]+\/?/i.exec(top)?.[0];
  if (linkedin) out.linkedin = linkedin;
  const github = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}(?![\w-]|\/\w)\/?/i.exec(top)?.[0];
  if (github) out.github = github;
  return out;
}

/** Why a document should not be read as the user's own, or null when it should. */
function notTheirs(profile: Profile, title: string, text: string): string | null {
  const name = profile.fact('name')?.value;
  if (name) return whoseText(name, text.slice(0, 3000)).startsWith('names ') ? null : COPY.notYours;
  return namedLikeACv(title) || hasCvSections(text) ? null : COPY.notCv;
}

/** The name and town at the head of a résumé, read by pattern so a person with no model still gets them. */
export function headerFacts(text: string): ProfileFields {
  const out: ProfileFields = {};
  const name = nameIn(text);
  if (name) out.name = name;
  const location = headerLocation(text);
  if (location) out.location = location;
  return out;
}

export async function fillProfile(
  deps: { memory: Pick<Memory, 'listDocuments' | 'documentText'>; profile: Profile; model: ModelLike | null; log?: Logger; owners?: Ownership },
  documentId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<FillResult> {
  const result: FillResult = { usable: [], proposed: [], skipped: null, costUsd: 0, model: 'none', problem: null };
  const doc = deps.memory.listDocuments().find((d) => d.id === documentId);
  // A document the owner has not said is theirs is kept, and nothing more: no reader, no model, no proposal.
  if (doc && !doc.trusted) return { ...result, skipped: COPY.notTrusted };
  // Somebody else's résumé is never read into the user's profile, until they say it is theirs anyway.
  const other = deps.owners?.otherName(documentId);
  if (other) return { ...result, skipped: COPY.someoneElse.replace('{name}', other) };
  const whole = doc ? await deps.memory.documentText(documentId) : null;
  // Lines that give a reader orders are not facts about anyone, and no reader below sees them.
  const text = whole ? readerText(whole).text : null;
  if (!doc || !text?.trim()) return { ...result, skipped: COPY.noText };
  const skip = deps.owners?.mineAnyway(documentId) ? null : notTheirs(deps.profile, doc.title, text);
  if (skip) return { ...result, skipped: skip };

  const basis = { documentId, title: doc.title };
  const write = (fields: ProfileFields): void => {
    for (const [field, raw] of Object.entries(fields) as Array<[ProfileField, string]>) {
      // A name is kept one way however a document or a model capitalises it: "AVERY QUINN" is Avery Quinn.
      const value = field === 'name' && raw?.trim() ? properName(raw) : raw?.trim();
      if (!value || NEVER_FROM_DOCUMENTS.has(field) || factProblem(field, value)) continue;
      const had = deps.profile.fact(field);
      // The name the profile already holds is not swapped for another spelling of it, or for what a later document says.
      const keep = field === 'name' && had && had.source !== 'extract' && had.source !== 'agent';
      if (!keep) {
        const exact = VERBATIM_FIELDS.has(field) && appearsIn(value, text);
        deps.profile.set({ [field]: value }, { confirmed: false, source: doc.trusted && exact ? 'document' : 'extract', basis });
      }
      const now = deps.profile.fact(field);
      if (!now || !(now.value === value || (field === 'name' && sameName(now.value, value)))) continue;
      (now.usable ? result.usable : result.proposed).push(field);
    }
  };

  const found = { ...headerFacts(text), ...contactFacts(text) };
  write(found);
  if (deps.model) {
    try {
      // The answer limiter gives it its own 25 s; a failure is tried again in the background (app.ts), so a busy provider costs this reading only.
      const read = await extractProfile(deps.model, [{ title: doc.title, text }], { signal: opts.signal });
      result.costUsd = read.costUsd;
      result.model = 'answered';
      // What the patterns found is as written; a model may tidy it.
      write(Object.fromEntries(Object.entries(read.fields).filter(([f]) => !(f in found))));
    } catch (err) {
      deps.log?.warn('could not read the profile from a document', { err, documentId });
      result.model = 'failed';
      result.problem = plainReason(err);
    }
  }
  return result;
}
