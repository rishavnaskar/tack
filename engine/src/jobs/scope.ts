/**
 * Whether an answer holds for every job or only the one that asked.
 *
 * "How did you hear about this job?", "Why this company?" and anything
 * written about one company are answered once per job and never reused for
 * another. A yes/no or a choice that only names the company asking ("Are you
 * willing to relocate to Acme's office?") is the same question at every
 * company, so the name is set aside before it is known again; having worked
 * at, applied to, or knowing someone at a company is not, and stays per company.
 */
import { canonicalJobId, postingKey } from './jobs.ts';
import { escapeRe, normaliseQuestion } from './wording.ts';

export type Scope = 'person' | 'job';

/** The job asking, as job_ask knows it. Any part may be unknown. */
export interface JobAsking {
  company: string;
  title: string;
  url: string;
  /** The ledger's id for the job, when it has one. */
  jobId?: string;
}

const ABOUT_THIS_JOB: RegExp[] = [
  /\b(?:how|where) did you (?:first )?(?:hear|learn|find out|come across|find|see)\b/i,
  /^\s*(?:job |application |candidate |referral )?source\s*[?:.]?\s*$/i,
  /\blocations?\b.*\bfor (?:this|the) (?:role|position|job|opening|opportunity)\b/i,
  /\b(?:preferred|desired)\b.*\blocations?\b.*\b(?:this|the) (?:role|position|job|opening)\b/i,
  /\bwhy (?:do you want|would you like|are you interested|are you applying|did you apply|have you applied|this|our|us|join|work)\b/i,
  /\b(?:interest(?:s|ed)?|excites?|excited|attracts?|appeals?|motivat\w*|drawn)\b.*\b(?:this|our|the) (?:role|position|company|team|job|opportunity|mission|product)\b/i,
  /\brelocat\w*\b.*\b(?:this|the) (?:role|position|job|opening)\b/i,
  /\bcover letter\b/i,
  /\bwhat (?:makes|would make) you (?:a )?(?:good|great|strong|ideal|right) (?:fit|candidate|match)\b/i,
  // An attestation or a consent is given to one employer for one application, never carried to the next.
  /\b(?:certify|attest|affirm|declare)\b.*\b(?:true|accurate|correct|complete|truthful)\b|\bto the best of (?:my|your) knowledge\b|\bsignature\b/i,
  /\b(?:consent|authori[sz]e)\b.*\b(?:to|for|us)\b|\bbackground (?:check|verification|screening)\b|\b(?:privacy (?:policy|notice)|data processing|gdpr)\b/i,
];

/** Knowing or being related to someone at the company asking. */
const KNOWS_SOMEONE = /\b(?:do|does) you know (?:anyone|anybody|someone|any(?: of the)? (?:people|employees))\b|\bknow (?:anyone|anybody|someone) (?:who )?(?:works?|working|employed|at)\b|\b(?:relatives?|family members?|friends?)\b.{0,40}\b(?:work|works|working|employed)\b|\brelated to (?:anyone|anybody|someone|an? (?:employee|current employee))\b/i;

/** Having worked at, or applied to, the company asking: a different question at each company. */
const ABOUT_THIS_COMPANY = /\b(?:worked|work(?:ing)? (?:for|at|with)|been employed|employed (?:by|at|with)|applied|interviewed|(?:former|previous|past|current) (?:employee|intern|contractor))\b/i;

const LEGAL = /[,\s]+(?:inc|incorporated|llc|ltd|limited|plc|gmbh|corp|corporation|co|pvt|private|technologies|labs)\.?$/i;

/** The company's name as a question would write it: whole words, legal suffix optional. */
function companyPattern(company: string): RegExp | null {
  const name = company.trim();
  if (name.length < 2) return null;
  const names = [...new Set([name, name.replace(LEGAL, '').trim()])].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join('|')})(?:['’]s)?(?![\\p{L}\\p{N}])`, 'giu');
}

/** Whether the question names the company asking. */
export function namesCompany(question: string, company: string): boolean {
  const re = companyPattern(company);
  return !!re && re.test(question);
}

/** A closing "(Acme Senior Engineer)" naming the company or the title: it says who asked, not what. */
function asker(question: string, by: Pick<JobAsking, 'company' | 'title'>): RegExpExecArray | null {
  const tail = /\s*\(([^()]*)\)\s*[?.:]*\s*$/.exec(question);
  if (!tail) return null;
  const inside = tail[1].toLowerCase();
  const named = [by.company, by.title].map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
  return named.some((n) => inside.includes(n) || namesCompany(tail[1], by.company)) ? tail : null;
}

export function scopeOf(question: string, kind: string, by: Pick<JobAsking, 'company' | 'title'>): Scope {
  if (ABOUT_THIS_JOB.some((re) => re.test(question))) return 'job';
  if (kind === 'text' && (namesCompany(question, by.company) || asker(question, by))) return 'job';
  return 'person';
}

/** How the job is known: the ledger's id, else the id its address carries, else the address, else its company and title. */
export function jobKey(by: JobAsking): string | null {
  if (by.jobId) return by.jobId;
  const id = canonicalJobId({ company: by.company, title: by.title, url: by.url || null });
  if (!id.startsWith('job:') && !id.startsWith('url:')) return id;
  const posting = postingKey(by.url);
  if (posting) return `posting:${posting}`;
  return by.company.trim() || by.title.trim() ? id : null;
}

interface QuestionKey {
  /** The question as it is known again: its normalised wording, then `#` and the job for one about a single job. */
  key: string;
  /** The normalised wording alone. */
  norm: string;
  scope: Scope;
  /** The job a question about one job belongs to. */
  jobId: string | null;
}

/**
 * How this question is known again. A question about one job whose job is
 * not known gets a key of its own, so its answer is never reused.
 */
export function questionKey(question: string, kind: string, by: JobAsking | null, unknownJob = (): string => `?${Date.now().toString(36)}`): QuestionKey {
  const asking = by ?? { company: '', title: '', url: '' };
  // Knowing someone at a company is asked of each company: one answer per company, however it is worded.
  if (KNOWS_SOMEONE.test(question) && !ABOUT_THIS_JOB.some((re) => re.test(question))) {
    const norm = normaliseQuestion(personWording(question, asking));
    const company = normaliseQuestion(asking.company.replace(LEGAL, ''));
    return { key: `${norm}#company:${company || unknownJob()}`, norm, scope: 'person', jobId: null };
  }
  const scope = scopeOf(question, kind, asking);
  if (scope === 'job') {
    const norm = normaliseQuestion(question);
    const jobId = jobKey(asking) ?? unknownJob();
    return { key: `${norm}#${jobId}`, norm, scope, jobId };
  }
  let text = question;
  if ((kind === 'yes_no' || kind === 'choice') && !ABOUT_THIS_COMPANY.test(question)) {
    const tail = asker(text, asking);
    if (tail) text = text.slice(0, tail.index);
    const re = companyPattern(asking.company);
    if (re) text = text.replace(re, 'the company');
  }
  const norm = normaliseQuestion(text);
  return { key: norm, norm, scope, jobId: null };
}

/**
 * The question's words with the company asking set aside, whatever it asks:
 * how its meaning is looked up, so "Have you worked at Acme?" and "Have you
 * worked at Globex?" are classified once.
 */
export function personWording(question: string, by: Pick<JobAsking, 'company' | 'title'> | null): string {
  if (!by) return question;
  let text = question;
  const tail = asker(text, by);
  if (tail) text = text.slice(0, tail.index);
  const re = companyPattern(by.company);
  return re ? text.replace(re, 'the company') : text;
}

/**
 * Where an answer the user edited on an application is saved: for every
 * job, or, for a question about this one ("Why Acme?"), for it alone.
 */
export function answerPlace(question: string, job: { canonicalId: string; company: string; title: string; url?: string | null } | null): { key?: string; jobId?: string } {
  if (!job) return {};
  const k = questionKey(question, 'text', { company: job.company, title: job.title, url: job.url ?? '', jobId: job.canonicalId });
  return k.scope === 'job' && k.jobId ? { key: k.key, jobId: k.jobId } : {};
}
