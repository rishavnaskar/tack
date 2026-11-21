/**
 * Questions Fanfold answers only with the user's own word.
 *
 * Demographics, salary, a criminal record, health, relatives at the company,
 * references, attestations, consents and signatures: a wrong answer to one of
 * these harms the user in a way a wrong start date does not. Each is
 * recognised here by its wording alone, before any model reads the question,
 * and that verdict outranks whatever a model or a host says the question is.
 * The answer itself then comes only from a confirmed fact or the user's own
 * saved answer.
 *
 * Kept on the cautious side: a question about building a background-check
 * service is asked rather than answered, which costs the user one click.
 */

/** The intent each sensitive kind of question is filed under. */
export type SensitiveIntent =
  | 'eeo.gender' | 'eeo.ethnicity' | 'eeo.veteran' | 'eeo.disability'
  | 'legal.criminal' | 'legal.attestation' | 'legal.consent' | 'health' | 'references'
  | 'referral.know_anyone' | 'salary.other';

/** In order: "authorise a background check" is a consent before it is anything else. */
const KINDS: Array<{ intent: SensitiveIntent; pattern: RegExp }> = [
  { intent: 'legal.criminal', pattern: /\b(?:convicted|convictions?|felony|felonies|misdemeanou?rs?|criminal|arrested|pending charges|offen[cs]es?)\b/i },
  {
    intent: 'legal.attestation',
    pattern: /\b(?:certify|attest|affirm|declare|acknowledge)\b.*\b(?:true|accurate|correct|complete|truthful|information|understand)\b|\bto the best of (?:my|your) knowledge\b|\bsignature\b|\b(?:e-?)?sign (?:here|below|your name)\b|\btype your (?:full |legal )?name\b.*\b(?:sign|signature|acknowledg\w*|confirm\w*)\b/i,
  },
  {
    intent: 'legal.consent',
    pattern: /\b(?:consent|authori[sz]e)\b.*\b(?:to|for|us)\b|\b(?:agree|accept)\b.*\b(?:terms|policy|policies|notice|privacy|processing|background|retain|retention|store|storage|collect\w*)\b|\bbackground (?:check|verification|screening|investigation)\b|\b(?:privacy (?:policy|notice)|data (?:processing|protection)|gdpr)\b/i,
  },
  { intent: 'eeo.disability', pattern: /\bdisabilit(?:y|ies)\b|\bdisabled\b|\bhandicap\w*/i },
  { intent: 'health', pattern: /\b(?:medical|health)\b.*\b(?:condition|conditions|issue|issues|problem|history|restriction)\b|\bdrug (?:test|screen\w*)\b|\bvaccinat\w*|\bpregnan\w*|\billness\w*|\baccommodations?\b/i },
  { intent: 'eeo.veteran', pattern: /\bveterans?\b|\bmilitary (?:service|status)\b|\barmed forces\b/i },
  { intent: 'eeo.ethnicity', pattern: /\b(?:race|racial|ethnicity|ethnic|hispanic|latino|latina|latinx)\b/i },
  { intent: 'eeo.gender', pattern: /\b(?:gender|sex|sexual orientation|transgender|lgbt\w*)\b/i },
  { intent: 'references', pattern: /\breferees?\b|\breferences?\b(?!\s*(?:number|no\b|id\b|code))/i },
  {
    intent: 'referral.know_anyone',
    pattern: /\b(?:relatives?|related to|family members?|spouse|know anyone|know anybody|know someone|acquainted|friends? (?:who )?(?:work|works|working))\b|\breferred by\b|\bemployee referral\b/i,
  },
  { intent: 'salary.other', pattern: /\b(?:salary|salaries|ctc|compensation|pay|package|remuneration|wages?|stipend|lpa|lakhs?|bonus)\b/i },
];

/** The sensitive kind this question is, by its words, or null. */
export function sensitiveAsked(question: string): SensitiveIntent | null {
  const text = question.normalize('NFKC').replace(/\s+/g, ' ');
  return KINDS.find((k) => k.pattern.test(text))?.intent ?? null;
}

/** Whether two intents are the same kind of thing: a salary question classified as the current salary is still a salary question. */
export function sameFamily(a: string, b: string): boolean {
  const family = (id: string): string => (id.startsWith('legal.') ? 'legal' : id.split('.')[0]);
  return a === b || family(a) === family(b);
}

/**
 * Text that talks to whoever reads it rather than asking the applicant
 * something. A question like that is asked, never classified by a model.
 */
const INSTRUCTS = [
  /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:instructions?|previous|prior|above|rules?|guidelines|system|prompt)\b/i,
  /\b(?:system prompt|developer message|you are (?:an? )?(?:ai|assistant|language model|llm|bot)|as an ai\b)/i,
  /\b(?:note|message|instructions?) (?:to|for) (?:the |any )?(?:ai|assistant|bot|llm|agent|model)\b/i,
  /\b(?:classify|categori[sz]e|label|mark) (?:this|it|the question) as\b/i,
  /\b(?:respond|reply|answer|output|say)\b.{0,30}\b(?:yes|true|approved)\b.{0,40}\b(?:all|every|any|regardless|always)\b/i,
  /\b(?:reveal|print|repeat|show)\b.{0,30}\b(?:your|the) (?:prompt|instructions|api key|system)\b/i,
];

export function instructsModel(question: string): boolean {
  const text = question.normalize('NFKC').replace(/\s+/g, ' ');
  return INSTRUCTS.some((re) => re.test(text));
}
