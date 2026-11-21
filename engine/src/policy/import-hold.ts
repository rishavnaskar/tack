/**
 * Whether a file an outside agent imports can be read at once.
 *
 * The agent chooses the path, and a page it read can choose for it: a
 * private document whose path the page knows, imported, read back and typed
 * into a form. What an agent is normally asked to add is the user's own
 * résumé, CV or cover letter, so that goes through without a question.
 * Anything else is kept, but nothing reads it until the user allows it.
 */
import type { Memory } from '../memory/memory.ts';
import { chunkText } from '../memory/retrieval.ts';
import { whoseText } from './upload-hold.ts';

/**
 * A file named as a résumé, CV or cover letter, accents and case aside:
 * "Résumé 2026.pdf", "Avery_Quinn_CV.pdf", "AveryQuinnCV.docx",
 * "cover-letter-acme.pdf".
 */
export function namedLikeACv(file: string): boolean {
  const plain = file.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /(^|[^a-z0-9])(resume|cv|curriculum[^a-z0-9]*vitae|cover[^a-z0-9]*letter)([^a-z0-9]|$)/.test(plain);
}

/** A line that is only a résumé heading: "EXPERIENCE", "Work history", "## Skills & tools", "Education:". */
const HEADING = /^(?:(?:professional|work|relevant|technical|core|key|career|academic)\s+)?(experience|work history|employment(?: history)?|education|skills|projects|summary|certifications?)(?:\s*(?:&|and|\/)\s*[a-z ]{1,24})?$/;

/** Headings that name the same section. */
const SAME: Record<string, string> = {
  'work history': 'experience', employment: 'experience', 'employment history': 'experience', certification: 'certifications',
};

/** Two résumé headings or more, one of them experience or education, which nearly every résumé has. */
export function hasCvSections(text: string): boolean {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const bare = line.toLowerCase().replace(/^[\s#*•·>|\d.)–—-]+/, '').replace(/[\s:.|–—-]+$/, '');
    const heading = HEADING.exec(bare)?.[1];
    if (heading) found.add(SAME[heading] ?? heading);
  }
  return found.size >= 2 && (found.has('experience') || found.has('education'));
}

const SALUTATION = /^\s*(dear\b|to whom it may concern)/im;
const SIGN_OFF = /^\s*(yours sincerely|yours faithfully|yours truly|sincerely|kind regards|best regards|warm regards|regards|best wishes|respectfully|with thanks|thank you)\b[^\n]{0,3}$/gim;

/** A letter signed with this name: a salutation, and the name just after a sign-off. A letter to the user is not one. */
export function signedBy(text: string, name: string): boolean {
  if (!SALUTATION.test(text)) return false;
  return [...text.matchAll(SIGN_OFF)].some((m) =>
    whoseText(name, text.slice(m.index + m[0].length, m.index + m[0].length + 120)).startsWith('names '));
}

/**
 * Why a file an agent imports waits for the user's OK, or null when it is
 * plainly their own: it names them, and it reads as a résumé, CV or cover
 * letter by its file name or its text. `file` is the name on disk, never a
 * title the agent chose.
 */
export function importHold(name: string | undefined, file: string, text: string): string | null {
  const full = name?.trim();
  if (!full) return 'the profile has no name to check it against';
  const signed = signedBy(text, full);
  const theirs = signed || whoseText(full, chunkText(text).slice(0, 2).join('\n')).startsWith('names ');
  const cv = signed || namedLikeACv(file) || hasCvSections(text);
  if (theirs && cv) return null;
  const not = [theirs ? '' : `does not mention ${full}`, cv ? '' : 'does not look like a résumé, CV or cover letter'];
  return `it ${not.filter(Boolean).join(' and ')}`;
}

/** What an agent is told about a file that waits for the user's OK. */
export function waitingText(title: string, cannot: string): string {
  return `${JSON.stringify(title)} is waiting for the user's OK in Fanfold, so it cannot be ${cannot} yet. `
    + 'Tell the user they can allow it under Documents on the Profile page of Fanfold\'s own window. Do not try to reach it another way.';
}

/** Why an upload has no document to attach. */
export function unattachable(memory: Pick<Memory, 'documentHeld' | 'uploadableDocuments'> | undefined, id: string | undefined): string {
  const held = id ? memory?.documentHeld(id) : null;
  if (held) return waitingText(held.title, 'attached');
  const available = memory?.uploadableDocuments() ?? [];
  return available.length
    ? `no imported document with id ${JSON.stringify(id ?? '')}. Available: ` + available.map((d) => `${d.id} (${d.title})`).join(', ')
    : 'nothing can be uploaded: no imported document still has its original file on disk';
}
