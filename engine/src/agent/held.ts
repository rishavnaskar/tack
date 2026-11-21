/**
 * Whether a value Fanfold's own agent chose for a field about the person
 * traces to something Fanfold holds for that field (rule 1: never guess about
 * the person). The guard that asks is holdSensitive (record-actions.ts); what
 * a field asks that only a held answer fills is personAsked (intents.ts).
 */
import { sameAnswer, type Known } from '../jobs/known.ts';
import type { HeldOnly } from '../jobs/intents.ts';
import { folded } from '../jobs/wording.ts';

/**
 * The value is what Fanfold holds for the field: its answer, or its own
 * suggestion where a suggestion may go in at all, or words the user wrote in
 * this task. An address goes in only from the user's own saved answer, never
 * from the city in their profile; a yes or no about them is never taken from
 * their message, which may say yes to something else.
 */
export function traced(k: Known, typed: string, heldOnly: HeldOnly | null, said?: string): boolean {
  if (k.outcome === 'answer' && (heldOnly !== 'address' || k.answerId !== undefined) && sameValue(k.answer, typed, heldOnly)) return true;
  if (k.outcome === 'draft' && !heldOnly && sameAnswer(k.draft, typed)) return true;
  return heldOnly !== 'yes_no' && saidByUser(typed, said);
}

/** The same answer; for a phone, the same number with or without its country code. */
export function sameValue(held: string, typed: string, heldOnly: HeldOnly | null): boolean {
  if (sameAnswer(held, typed)) return true;
  if (heldOnly !== 'phone') return false;
  const digits = (v: string): string => v.replace(/\D/g, '');
  const a = digits(held);
  const b = digits(typed);
  return a.length >= 6 && b.length >= 6 && (a.endsWith(b) || b.endsWith(a));
}

/** Words the user wrote in this task, word for word: "my postcode is 10115" is theirs to type. */
export function saidByUser(typed: string, said?: string): boolean {
  if (!said) return false;
  const plain = (v: string): string => folded(v).replace(/[^\p{L}\p{N}@+]+/gu, ' ').trim();
  const value = plain(typed);
  return (value.length >= 3 || /^\d{2}$/.test(value)) && ` ${plain(said)} `.includes(` ${value} `);
}
