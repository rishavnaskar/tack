/**
 * Questions an agent never relays to the user.
 *
 * The question comes from a web page, and the agent passes it on as asked: a
 * page that wants a password, a one-time code or a card number only has to
 * ask for it. The answer would be typed into a dialog, saved to the answer
 * bank and typed back into whatever form asked next. So these are refused
 * before anyone is asked, and the user enters them in the form themselves.
 *
 * Kept narrow: "Do you have a passport?" and "Have you built OTP login
 * flows?" are ordinary questions and go through.
 */

/** In order: "PAN card number" is a government ID before it is a card. */
const ASKS: Array<{ what: string; pattern: RegExp }> = [
  {
    what: 'a password',
    pattern: /\bpass(?:word|phrase|code)s?\b|\b(?:atm|card|debit|credit|bank|upi|security|secret)\s+pin\b|\bm-?pin\b/gi,
  },
  {
    what: 'a one-time or verification code',
    pattern: new RegExp(String.raw`\botp\b|\bone[\s-]time\s+(?:pass(?:word|code)?|code|pin)\b|\btwo[\s-]factor\b|\bcvv2?\b|\bcvc\b`
      + String.raw`|\b(?:verification|security|authentication|auth|confirmation|2fa|mfa|sms|login)\s+code\b|\bcode\s+(?:we\s+|was\s+|that\s+was\s+)?(?:sent|texted|emailed)\b`
      + String.raw`|\b\d+[\s-]?(?:digit|character|letter)\s+code\b`, 'gi'),
  },
  {
    what: 'a government ID number',
    pattern: new RegExp(String.raw`\bssn\b|\bsocial\s+(?:security|insurance)\s+(?:number|no\b|#)|\bpermanent\s+account\s+number\b`
      + String.raw`|\b(?:aadhaa?r|pan|passport|national\s+(?:id|identity|identification|insurance)|ni|tax\s+(?:id|identification)|tin|voter\s+id|driver'?s?\s+licen[cs]e|driving\s+licen[cs]e|sin|nric)\s*(?:card\s*)?(?:number|no\b|#)`
      + String.raw`|^\W*(?:your\s+)?(?:aadhaa?r|pan)\W*$`, 'gi'),
  },
  {
    what: 'a card, bank or account number',
    pattern: /\b(?:card|account|a\/c|acct)\s*(?:number|no\b|#)|\biban\b|\brouting\s+number\b|\bsort\s+code\b|\bifsc\b|\bswift\s+(?:code|bic)\b|\bupi\s+id\b|\bbank\s+(?:account\s+)?details\b/gi,
  },
];

/** An ID named on its own: asked for only when the words before it ask for it ("What is your PAN?"), never as in "pan-India". */
const ID_WORD = /\b(?:aadhaa?r|pan)\b(?:\s+card)?(?!\s*-)/gi;

/** Words between an ask and its object, but not "experience with": that is about the thing. */
const LEAD = String.raw`(?:(?!(?:with|about|of|on|for|using|in|around)\b)\S+\s+){0,3}$`;
/** "your bank …", "enter the …", "what is the …" right before it: the thing itself is asked for. */
const ASKED_FOR = new RegExp(String.raw`(?:\byour\s+|\b(?:enter|re-?enter|type|key\s+in|provide|share|give|input|paste|send|submit|confirm|fill\s+in|tell\s+us|what\s+is|what'?s)\s+)` + LEAD, 'i');
/** About the thing, not asking for it: experience with it, or whether they have one. */
const ABOUT = /\b(?:experience[ds]?|familiar(?:ity)?|worked|built|implemented|designed|developed|knowledge|proficien(?:t|cy)|skills?|years|projects?)\b/i;
const HAVE = /^\W*(?:do|does|did)\s+you\s+(?:have|hold|possess|own|carry)\b|^\W*have\s+you\s+(?:got|ever\s+had)\b/i;

/** What the question asks for that only the user may type, or null. */
export function secretAsked(question: string): string | null {
  const text = question.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const about = ABOUT.test(text) || HAVE.test(text);
  for (const ask of ASKS) {
    for (const m of text.matchAll(ask.pattern)) {
      if (!about || ASKED_FOR.test(text.slice(Math.max(0, m.index - 60), m.index))) return ask.what;
    }
  }
  for (const m of text.matchAll(ID_WORD)) {
    if (ASKED_FOR.test(text.slice(Math.max(0, m.index - 60), m.index))) return 'a government ID number';
  }
  return null;
}
