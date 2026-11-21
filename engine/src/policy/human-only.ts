/**
 * Parts of an application only the person can do.
 *
 * A recorded video answer, an assessment or coding test, a take-home task:
 * no profile answer covers these, and an agent that submits around them sends
 * an application that is missing the part the employer cared about most. So
 * before anything is submitted, the controls on the page are checked for one,
 * and if there is one the application is filled, left unsent, and handed to
 * the person with the reason.
 *
 * Only the controls are read (field labels, buttons, links), not the job
 * description around them, which talks about "tests" and "video calls" in
 * ways that ask nothing of the applicant today.
 */
import { unwrapUntrustedForDisplay } from './untrusted.ts';
import { sameForm } from './structure.ts';
import type { Observation, ObservedNode } from '../types.ts';

const VIDEO_VENDORS = /\b(hirevue|spark ?hire|willo|myinterview|vidcruiter|hireflix|talview)\b/i;
const TEST_VENDORS = /\b(hackerrank|hackerearth|codility|codesignal|testgorilla|coderbyte|criteria ?corp|pymetrics|devskiller|qualified\.io|karat|mettl|testdome|imocha|vervoe|harver)\b/i;

/** Up to two words between a verb and what it asks for: "complete the technical exercise", "upload your coding challenge". */
const BETWEEN = String.raw`\s+(the |this |our |an? |your )?([\w'’-]+\s+){0,2}`;

const ASKS: Array<{ what: string; pattern: RegExp }> = [
  {
    what: 'a recorded video',
    pattern: new RegExp(String.raw`\b(record|upload|submit|film|attach)\b[^.?!]{0,40}\bvideo\b|\bvideo (interview|answer|response|introduction|intro|pitch)s?\b`
      + String.raw`|\bone[- ]way video\b|` + VIDEO_VENDORS.source, 'i'),
  },
  {
    what: 'a recorded audio answer',
    pattern: /\brecord (an? |your )?(audio|voice)( answer| response| message| note)?\b/i,
  },
  {
    what: 'an assessment or test',
    pattern: new RegExp(String.raw`\b(take|complete|start|begin|launch)${BETWEEN}(assessment|test|quiz|challenge|exercise)\b`
      + String.raw`|\b(upload|submit|attach)${BETWEEN}(challenge|exercise)\b`
      + String.raw`|\b(coding|technical|skills?|online|cognitive|personality|aptitude) (assessment|test)\b`
      + String.raw`|\b(challenge|exercise) (solution|submission)\b|` + TEST_VENDORS.source, 'i'),
  },
  {
    what: 'a take-home task',
    pattern: new RegExp(String.raw`\btake[- ]home (task|assignment|exercise|project|challenge|test|solution|submission)\b`
      + String.raw`|\b(complete|submit|upload|attach)${BETWEEN}(assignment|case study|work sample)s?\b`, 'i'),
  },
];

/**
 * Asks that are the person's however they are phrased, a tick box included:
 * a government or bank number, an account of their own, and a signature or
 * legal waiver. The everyday "I certify this is true" is not among them.
 */
const GOVERNMENT_ID = {
  what: 'a government ID or bank number',
  pattern: /\b(social security( number)?|ssn|social insurance( number)?|national insurance( number)?|ni number|national id( number)?|aadhaa?r|tax (id|identification) number|bank account( number)?|sort code|routing number|iban)\b|\b(passport|pan( card)?|sin|(driver['’]?s?|driving) licen[cs]e)\s*(number|no\b|#)/i,
};
const ACCOUNT = {
  what: 'an account of your own',
  pattern: /\b(create (an |your )?account|choose a password|create (a )?password|confirm (your )?password|verification code (sent|we sent))\b/i,
};
const SIGNATURE = {
  what: 'your signature on a legal statement',
  pattern: /^\W*(your |applicant['’]?s? |candidate['’]?s? )?(full |legal )*(e-?|electronic |digital )?signature\b|\b(e-?signature|electronic signature|sign (here|below)|type your (full )?(legal )?name (to|as) (sign|your signature)|under penalty of perjury|consent to (a )?background check|background check (authori[sz]ation|consent)|arbitration agreement|drug (test|screen)ing? consent)\b/i,
};
const PERSONAL = [GOVERNMENT_ID, ACCOUNT, SIGNATURE];

/** Answer choices are not asks: a "Video interview" option is a preference. */
const CHOICES = new Set(['radio', 'checkbox', 'option', 'menuitemradio', 'menuitemcheckbox', 'switch']);

/** "Are you willing to complete a coding test?" asks a question, not for the test itself. */
const WILLING = /\b(are|would|will|can|do) you (be )?(willing|able|open|comfortable|happy|prepared|available)\b|\bwilling to\b/i;
const aboutIt = (text: string): boolean => WILLING.test(text) && (text.includes('?') || /^\W*(are|would|will|can|do) you\b/i.test(text));

const words = (node: ObservedNode): string =>
  [node.name, node.text].filter(Boolean).map((t) => unwrapUntrustedForDisplay(t!)).join(' ');

function found(asks: Array<{ what: string; pattern: RegExp }>, text: string): { what: string; evidence: string } | null {
  const ask = asks.find((a) => a.pattern.test(text));
  return ask ? { what: ask.what, evidence: text.slice(0, 120) } : null;
}

/**
 * What the form being submitted asks that only the person can do, or null.
 * With the submit control given, a video, a test or a task counts only in its
 * own form; a link counts when it names an assessment vendor or asks for one
 * in so many words. A government number or a signature counts anywhere on
 * the page, marked optional or not.
 */
export function humanOnly(observation: Observation | null, submit?: ObservedNode | null): { what: string; evidence: string } | null {
  if (!observation) return null;
  const scoped = submit?.evidence?.inForm ? submit : null;
  for (const node of observation.nodes) {
    const ev = node.evidence;
    if (!ev) continue;
    const text = words(node);
    if (!text || aboutIt(text)) continue;
    let hit: { what: string; evidence: string } | null;
    if (node.role === 'link') {
      const asks = VIDEO_VENDORS.test(text) || TEST_VENDORS.test(text) || /^\W*(take|complete|start|begin|launch|record)\s/i.test(text);
      hit = asks ? found(ASKS, text) : null;
    } else if (scoped && !sameForm(node, scoped)) {
      hit = found([GOVERNMENT_ID, SIGNATURE], text);
    } else if (ev.inputType === 'password') {
      // A password box is an account being made, whatever its label says.
      hit = { what: 'an account of your own', evidence: text.slice(0, 120) };
    } else {
      const choice = CHOICES.has(node.role) || ev.control === 'select';
      hit = found(choice || /\(optional\)/i.test(text) ? PERSONAL : [...ASKS, ...PERSONAL], text);
    }
    if (hit) return hit;
  }
  return null;
}
