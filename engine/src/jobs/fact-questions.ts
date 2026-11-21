/**
 * What a fact the user wrote in their own words means for a yes-or-no
 * question. Which field a question asks for, by its wording, is the intent
 * registry's to say (intents.ts).
 */
import { countryIn } from './countries.ts';
import type { ProfileField } from './profile.ts';

interface Meaning {
  /** The answer to the question the field asks, "are you authorised?" or "do you need sponsorship?"; null when the sentence does not say plainly. */
  polarity: 'yes' | 'no' | null;
  /** The country the sentence is about, when it names one. */
  country?: string;
}

/** What says no, read first and set aside, so "do not need" is not read as "need". */
const SAYS_NO: Partial<Record<ProfileField, RegExp>> = {
  workAuthorisation: /\b(?:not|never) (?:legally )?(?:authori[sz]ed|eligible|permitted|entitled|allowed)\b|\b(?:need|needs|require|requires|will need|would need)(?: a)? (?:visa|work permit|sponsorship)\b|\b(?:do|does) not have (?:the )?right\b|\bno right\b|\bnot a (?:citizen|permanent resident)\b|^\s*no\b/gi,
  sponsorship: /\b(?:do|does|will|would) not (?:need|require)\b|\b(?:don'?t|doesn'?t|won'?t|wouldn'?t|never) (?:need|require)\b|\bnot (?:needed|required|necessary)\b|\bno need\b|\bnone\b|\bno\b/gi,
};
/** What says yes, in what is left. */
const SAYS_YES: Partial<Record<ProfileField, RegExp>> = {
  workAuthorisation: /\b(?:authori[sz]ed|citizen|citizenship|permanent resident|eligible|have the right|has the right|right to work|green card|work permit holder|yes)\b/i,
  sponsorship: /\b(?:need|needs|require|requires|will need|would need|yes)\b/i,
};

/**
 * What a work authorisation or sponsorship sentence means, read in code:
 * "Indian citizen; authorised to work in India" is yes, about India; "No
 * sponsorship needed" is no. A sentence that says both, or neither, is null,
 * and a question about it waits for the user. Other fields mean nothing here.
 */
export function meaningOf(field: ProfileField, value: string): Meaning {
  const no = SAYS_NO[field];
  const yes = SAYS_YES[field];
  if (!no || !yes) return { polarity: null };
  const text = value.normalize('NFKC').replace(/[’]/g, "'").trim();
  no.lastIndex = 0;
  const negative = no.test(text);
  no.lastIndex = 0;
  const positive = yes.test(text.replace(no, ' '));
  const country = countryIn(text);
  return { polarity: negative === positive ? null : negative ? 'no' : 'yes', ...(country ? { country } : {}) };
}
