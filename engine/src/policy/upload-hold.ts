/**
 * Whether attaching a document waits for the owner.
 *
 * A document the owner gave Fanfold goes as the run asks. One an outside
 * agent imported is the agent's choice of file, and a page it read can make
 * that choice for it: a passport scan from Downloads attached to a stranger's
 * form. So unless it plainly names the profile's user (their own résumé), it
 * is attached only once the owner has seen which file it is.
 */
import type { Memory } from '../memory/memory.ts';

/** "names Avery Quinn", "does not mention Avery Quinn: …", or '' when no name is on the profile or the file has no text. */
export function whoseText(name: string | undefined, opening: string): string {
  const full = name?.trim();
  if (!full) return '';
  const text = opening.toLowerCase();
  const parts = full.toLowerCase().split(/\s+/).filter((p) => p.length > 1);
  if (!text || !parts.length) return '';
  return parts.every((p) => text.includes(p)) ? `names ${full}` : `does not mention ${full}: it may be someone else's or not a résumé`;
}

/** Why attaching this document waits for the owner, or null when it goes as asked. */
export function uploadHold(memory: Pick<Memory, 'documentImportedBy' | 'documentOpening' | 'listDocuments'>, profileName: string | undefined, id: string): string | null {
  const by = memory.documentImportedBy(id);
  if (!by) return null;
  const document = memory.listDocuments().find((d) => d.id === id);
  // The owner said it is theirs ("This is mine"): attaching it waits for nothing more.
  if (document?.trusted) return null;
  if (whoseText(profileName, memory.documentOpening(id)).startsWith('names ')) return null;
  return uploadHoldWhy(document?.title ?? id, by.replace(/^agent:/, ''), profileName?.trim() || null);
}

/** What the card says. */
function uploadHoldWhy(title: string, agent: string, name: string | null): string {
  return name
    ? `Attaches the file ${JSON.stringify(title)}. An outside agent (${agent}) added this file to Fanfold, not you, and it doesn't mention ${name}. `
      + 'It might belong to someone else, or not even be a résumé. Please check the file before you approve.'
    : `Attaches the file ${JSON.stringify(title)}. An outside agent (${agent}) added this file to Fanfold, not you, and your profile doesn't have a name to check against. `
      + 'Please check the file before you approve.';
}
