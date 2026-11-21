// Automated applying through the engine. Each posting gets its own engine session (its own Chrome
// window, laid out side by side) and its own agent; a batch runs them in parallel, started a few
// seconds apart so the shared model budget is not hit at once, and one failure stops nothing else.
// A Submit goes only on the person's standing consent, through the engine's own standing approval.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.ts';
import { emit } from './trace.ts';
import { ensureEngine, type EngineHandle } from './engine-proc.ts';
import { EngineError, McpClient, ownerCall, unfence } from './engine-client.ts';
import { consentText, practiceUrl, screeningQuestions, submissions, type PracticeQuestion } from './practice.ts';
import { buildKit, cachedKit } from './kit.ts';
import { postingFit } from './gap.ts';
import * as queue from './apply-queue.ts';
import { tileWindows } from './tile.ts';
import type {
  Application, ApplicationDetails, ApplyBatch, ApplyReadiness, ApplyRun, ApplyStep, FormInspection, Kit, Posting, Profile,
} from './types.ts';

export const MAX_PARALLEL = 8;
const DETAILS = 'details';
const RESUME = 'resume-file';
const CONSENT = 'apply-consent';

export interface ResumeFile { filename: string; mime: string; base64?: string; text?: string; savedAt: string }

// ---------------------------------------------------------------- the person's details

export const BLANK_DETAILS: ApplicationDetails = { fullName: '', email: '', phone: '', city: '', linkedin: '', workAuthorisation: '', noticePeriod: '' };

export function demoDetails(): ApplicationDetails {
  return {
    fullName: 'Avery Quinn', email: 'avery.quinn@mail.example', phone: '+91 98450 01234', city: 'Bengaluru',
    linkedin: 'https://www.linkedin.com/in/avery-quinn-example', workAuthorisation: 'India: Citizen', noticePeriod: '30 days',
  };
}

export function getDetails(): ApplicationDetails | undefined {
  return store.get<ApplicationDetails>('single', DETAILS);
}

const clean = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function detailProblems(d: ApplicationDetails): Record<string, string> {
  const out: Record<string, string> = {};
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) out.email = 'That is not an email address.';
  if (d.phone && (!/^\(?\+?[\d\s()-]+$/.test(d.phone) || d.phone.replace(/\D/g, '').length < 7)) out.phone = 'Use digits, with a + and spaces if you like.';
  if (d.linkedin && !/(^|[/.])linkedin\.com(\/|$)/i.test(d.linkedin)) out.linkedin = 'Use your linkedin.com profile address.';
  return out;
}

export function saveDetails(body: any): ApplicationDetails {
  const d: ApplicationDetails = {
    fullName: clean(body?.fullName, 120), email: clean(body?.email, 200), phone: clean(body?.phone, 40), city: clean(body?.city, 120),
    linkedin: clean(body?.linkedin, 300), workAuthorisation: clean(body?.workAuthorisation, 200), noticePeriod: clean(body?.noticePeriod, 60),
    updatedAt: new Date().toISOString(),
  };
  store.put('single', DETAILS, d);
  return d;
}

export function getResume(): ResumeFile | undefined {
  return store.get<ResumeFile>('single', RESUME);
}

export function saveResume(file: Omit<ResumeFile, 'savedAt'>): void {
  store.put('single', RESUME, { ...file, savedAt: new Date().toISOString() });
}

export function demoResume(): Omit<ResumeFile, 'savedAt'> {
  const bytes = readFileSync(new URL('./demo/avery-quinn-resume.pdf', import.meta.url));
  return { filename: 'avery-quinn-resume.pdf', mime: 'application/pdf', base64: bytes.toString('base64') };
}

export function isDemo(): boolean {
  return store.get<string>('single', 'mode') === 'demo' || store.get<Profile>('single', 'profile')?.source === 'demo';
}

// ---------------------------------------------------------------- standing consent

export interface Consent { on: boolean; givenAt?: string; withdrawnAt?: string }

export const CONSENT_LABEL = 'Tack may tick consent boxes and submit applications on my behalf';

export function getConsent(): Consent {
  return store.get<Consent>('single', CONSENT) ?? { on: false };
}

export function setConsent(on: boolean, now = new Date()): Consent {
  const prev = getConsent();
  const c: Consent = on
    ? { on: true, givenAt: prev.on && prev.givenAt ? prev.givenAt : now.toISOString() }
    : { on: false, ...(prev.givenAt ? { withdrawnAt: now.toISOString() } : {}) };
  store.put('single', CONSENT, c);
  return c;
}

/** Everything for real up to, but not including, the final Submit. */
export const isDryRun = () => process.env.TACK_APPLY_DRY_RUN === '1';

/** Where the form is: Lever and Ashby keep it a page past the posting; Greenhouse shows it on the posting. */
export function applicationUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const path = u.pathname.replace(/\/$/, '');
  if (u.hostname === 'jobs.lever.co' && /^\/[^/]+\/[0-9a-f-]{20,}$/i.test(path)) u.pathname = `${path}/apply`;
  else if (u.hostname === 'jobs.ashbyhq.com' && /^\/[^/]+\/[0-9a-f-]{20,}$/i.test(path)) u.pathname = `${path}/application`;
  return u.toString();
}

/** The demo person applies to Tack's practice form; a real person always to the real posting. */
export function targetFor(p: Posting): 'practice' | 'live' {
  return isDemo() || !p.live ? 'practice' : 'live';
}

export function readiness(p?: Posting): ApplyReadiness {
  const d = getDetails();
  const missing: string[] = [];
  if (!d?.fullName) missing.push('full name');
  if (!d?.email) missing.push('email');
  if (!getResume()) missing.push('résumé');
  const target = p ? targetFor(p) : isDemo() ? 'practice' : 'live';
  const consent = getConsent();
  const dry = isDryRun();
  const reason = missing.length
    ? `Add your ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} under Application details on Start before applying.`
    : dry ? 'Dry run: every form is filled for real and then left unsent. Nothing is submitted.'
      : target === 'practice' ? 'Ready. The demo person applies to Tack\'s practice form, never to a company.'
        : consent.on ? 'Ready. Applications are filled and submitted for you in Chrome.'
          : 'Ready to fill forms. Tack stops before every Submit until you give consent under Application details.';
  return { ready: !missing.length, missing, reason, target, consent: consent.on, dryRun: dry };
}

// ---------------------------------------------------------------- engine profile

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 20);

export function engineFields(d: ApplicationDetails, profile?: Profile): Record<string, string> {
  const f: Record<string, string> = {
    name: d.fullName, email: d.email, phone: d.phone, location: d.city, linkedin: d.linkedin,
    workAuthorisation: d.workAuthorisation, noticePeriod: d.noticePeriod,
    ...(profile?.yearsExperience ? { yearsExperience: String(profile.yearsExperience) } : {}),
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v));
}

/** The engine's own standing yes to applications, set from the person's consent. A dry run never has it. */
export function standingYes(): boolean {
  return getConsent().on && !isDryRun();
}

/** Pushes the details, the résumé and the standing yes into the engine once per change. An attached Fanfold keeps its own. */
export async function syncEngineProfile(h: EngineHandle, step: (s: string, d: string) => void, opts: { identityOnly?: boolean } = {}): Promise<void> {
  if (h.mode === 'attach') { step('profile', 'using the attached Fanfold\'s own profile, résumé and settings'); return; }
  const d = getDetails();
  const resume = getResume();
  if (!d || (!resume && !opts.identityOnly)) throw new Error('Add your details and résumé before applying.');
  const profile = store.get<Profile>('single', 'profile');
  const fields = engineFields(d, profile);
  const want = { fields: hashOf(fields), resume: resume ? hashOf([resume.filename, resume.base64 ?? resume.text]) : '', standing: standingYes() };
  const key = `engine-sync:${h.stateDir}`;
  const had = store.get<typeof want>('single', key);
  if (had?.fields !== want.fields) {
    const send = { ...fields };
    try {
      await ownerCall(h, 'PUT', '/api/profile', { fields: send });
    } catch (e) {
      // A value the engine cannot read as its fact is left out rather than blocking the rest.
      const problems = ((e as EngineError).body as { problems?: Record<string, string> } | undefined)?.problems ?? {};
      const bad = Object.keys(problems).filter((k) => k in send);
      if (!(e instanceof EngineError) || !bad.length) throw e;
      for (const k of bad) delete send[k];
      await ownerCall(h, 'PUT', '/api/profile', { fields: send });
      step('profile', `left out ${bad.map((k) => `${k} (${problems[k]})`).join(', ')}`);
    }
    step('profile', `${Object.keys(send).length} details synced to the engine profile`);
  }
  if (resume && !opts.identityOnly && had?.resume !== want.resume) {
    const doc = resume.base64
      ? { title: resume.filename, base64: resume.base64, mime: resume.mime, resume: true }
      : { title: resume.filename, text: resume.text, mime: 'text/plain', resume: true };
    await ownerCall(h, 'POST', '/api/documents', doc, 120_000);
    step('profile', `résumé ${resume.filename} uploaded as the engine's résumé document`);
  }
  if (!opts.identityOnly && had?.standing !== want.standing) {
    await ownerCall(h, 'PUT', '/api/settings', { submitWithoutAsking: want.standing });
    step('consent', want.standing ? 'the engine may submit applications without asking (your standing consent)' : 'the engine holds every Submit: no standing consent');
  }
  store.put('single', key, { fields: want.fields, resume: opts.identityOnly ? had?.resume ?? '' : want.resume, standing: opts.identityOnly ? had?.standing ?? false : want.standing });
}

// ---------------------------------------------------------------- what the agent is told

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

/** A cover note as an answer: without its greeting and sign-off. */
export function letterBody(note: string): string {
  const lines = note.trim().split('\n').map((l) => l.trim());
  while (lines.length && (/^(hello|hi|dear)\b.*,$/i.test(lines[0]) || !lines[0])) lines.shift();
  const end = lines.findIndex((l) => /^(best|regards|kind regards|thanks|thank you|sincerely|warmly|cheers)\b[^.]*,?$/i.test(l));
  return (end >= 0 ? lines.slice(0, end) : lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A kit line in the person's own voice: "Experimentation: Built the flag service" becomes "I built the flag service". */
export function firstPerson(line: string): string {
  let t = line.replace(/^[A-Z][\w ,/&-]{0,40}:\s+/, '').trim();
  if (/^(you|i|my|we|our)\b/i.test(t)) return t.replace(/^you\b/i, 'I');
  if (/^[A-Z][a-z]+(ed|t)?\b/.test(t)) t = `I ${t[0].toLowerCase()}${t.slice(1)}`;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Answers to the written questions, from the application kit: the cover note for motivation, the matching talking points for the skill. */
export function answersFor(qs: PracticeQuestion[], kit: Kit | undefined, p: Posting): { question: string; answer: string }[] {
  const must = p.skills?.find((s) => s.importance === 'must') ?? p.skills?.[0];
  return qs.map((q) => {
    if (q.id === 'q1') {
      return { question: q.text, answer: cut(letterBody(kit?.coverNote ?? '') || `I want to work on this at ${p.company} because it builds on what I have done so far.`, 1500) };
    }
    const words = (must?.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const about = (t: string) => words.some((w) => t.toLowerCase().includes(w));
    const points = kit?.talkingPoints ?? [];
    const lines = [...points.filter(about), ...(kit?.bullets ?? []).map((b) => b.text).filter(about), ...points].map(firstPerson);
    const picked = [...new Set(lines)].slice(0, 2);
    return { question: q.text, answer: cut(picked.join(' ') || 'Happy to talk this through in an interview.', 1500) };
  });
}

export const GOAL_MAX = 3900;

export interface GoalInput {
  posting: Posting; url: string; target: 'practice' | 'live'; details: ApplicationDetails;
  answers: { question: string; answer: string }[]; saved?: boolean; consentSaved?: boolean; kit?: Kit;
  session?: string; dryRun?: boolean; remembered?: { question: string; answer: string }[];
}

/** What the engine's agent is told. Answers saved in advance are not repeated; the whole stays under the tool's limit. */
export function goalFor(o: GoalInput): string {
  const { posting: p, details: d } = o;
  const facts = [
    `name ${d.fullName}`, `email ${d.email}`, d.phone && `phone ${d.phone}`, d.city && `city ${d.city}`, d.linkedin && `LinkedIn ${d.linkedin}`,
    d.workAuthorisation && `work authorisation ${d.workAuthorisation}`, d.noticePeriod && `notice period ${d.noticePeriod}`,
  ].filter(Boolean).join(', ');
  const head = o.dryRun
    ? [
      `Fill in the application for the ${p.title} role at ${p.company} as a dry run. Start here: ${o.url}`,
      'This only tests the form: fill every field it asks for, attach the résumé, choose an option in every dropdown and go through each step, '
        + 'but do NOT press the final Submit, Send or Apply button, and do not tick a consent box. When the form is filled as far as it goes, finish with done and list the fields you filled and any you could not.',
    ]
    : [
      `Apply to the ${p.title} role at ${p.company} and submit the application. Start here: ${o.url}`,
      'The person set Tack to send their applications. Fill every field the form asks for, go through each step, and press the final Submit yourself: '
        + 'Fanfold checks that press and holds it for the person when it has to. Do not stop with ask_user to confirm the Submit.',
    ];
  head.push(`Use their saved profile: ${facts}.`);
  head.push('Upload their résumé document to the form\'s own résumé or CV field; ignore any box that offers to autofill the form from a résumé and fill the fields yourself. Choose the closest option in each dropdown.');
  head.push('If the site wants a sign-in or a new account, or shows a CAPTCHA or bot check, stop and say so. Never create an account.');
  if (o.saved) {
    head.push(`Their own answers to this form's written questions${o.consentSaved ? ' and its consent box (Yes)' : ''} are already saved in Fanfold for this job: use them as they are${o.consentSaved ? ', and tick the consent box' : ''}.`);
  }
  const tail = [
    o.dryRun ? '' : 'When the page confirms the application was received, finish and quote the confirmation text and any reference number exactly.',
    'If the form asks something you cannot answer from this, stop and say exactly what it asked.',
    o.session ? `Reference for this task: ${o.session}.` : '',
  ].filter(Boolean).join(' ');
  const extra: string[] = [];
  if (!o.saved && o.answers.length) {
    extra.push('For written questions use these answers:');
    for (const a of o.answers) extra.push(`- "${a.question}": ${cut(a.answer, 900)}`);
  }
  if (o.remembered?.length) {
    extra.push('Answers the person gave earlier, for questions worded like these:');
    for (const a of o.remembered.slice(0, 8)) extra.push(`- "${cut(a.question, 160)}": ${cut(a.answer, 300)}`);
  }
  if (o.kit) extra.push(`For any other written question, draw only on this material: ${cut(o.kit.coverNote, 600)} ${o.kit.talkingPoints.slice(0, 2).join(' ')}`);
  const room = GOAL_MAX - [...head, tail].join('\n').length - 2;
  const body = cut(extra.join('\n'), Math.max(0, room));
  return [...head, ...(body ? [body] : []), tail].join('\n');
}

// ---------------------------------------------------------------- progress into steps

const SUBMIT = /\bsubmit/i;
const NEXT = /\b(continue|next|review|proceed)\b/i;
const FILLS = new Set(['fill', 'type', 'select', 'check']);

/** Turns the engine's "step N: kind, reason" progress lines into the step list a person reads. */
export function onProgress(run: ApplyRun, message: string, now = new Date().toISOString()): ApplyStep | null {
  const m = message.match(/^step \d+:\s*([a-z_]+)(?:,\s*(.*))?$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const reason = (m[2] ?? '').trim();
  const push = (s: Omit<ApplyStep, 'at'>): ApplyStep => { const step = { at: now, ...s }; run.steps.push(step); return step; };
  const formFound = () => { if (!run.steps.some((s) => s.kind === 'form')) push({ kind: 'form', label: 'Found the application form' }); };
  if (kind === 'goto') return run.steps.some((s) => s.kind === 'open') ? null : push({ kind: 'open', label: 'Opened the application page' });
  if (FILLS.has(kind)) {
    formFound();
    run.fields++;
    const last = run.steps.at(-1);
    const label = `Filled ${run.fields} field${run.fields === 1 ? '' : 's'}`;
    if (last?.kind === 'fill') { last.label = label; last.at = now; return last; }
    return push({ kind: 'fill', label });
  }
  if (kind === 'upload') { formFound(); return push({ kind: 'upload', label: 'Uploaded the résumé' }); }
  if (kind === 'click' || kind === 'press') {
    if (SUBMIT.test(reason)) return push({ kind: 'submit', label: run.dryRun ? 'Reached the final Submit (not pressed: dry run)' : 'Reached the final Submit' });
    if (NEXT.test(reason)) { formFound(); return push({ kind: 'next', label: 'Moved to the next step' }); }
    return null;
  }
  if (kind === 'ask_user') return push({ kind: 'note', label: `Stopped: ${cut(reason, 140)}` });
  return null;
}

/** Status line and message out of agent_run's answer. */
export function parseRunResult(text: string): { status: string; message: string } {
  const status = text.match(/^status:\s*(\S+)/m)?.[1] ?? 'unknown';
  const message = text.split('\n').filter((l) => !/^status:|^steps:|^It stopped for the user\./.test(l)).join(' ').replace(/\s+/g, ' ').trim();
  return { status, message };
}

export type Hold = 'submit' | 'consent' | 'captcha' | 'login' | 'question' | 'other';

/** Why a run stopped short of done: at the Submit the gate holds, at a box only the person may tick, or elsewhere. */
export function holdOf(status: string, message: string): Hold | null {
  if (status === 'done') return null;
  const m = message.toLowerCase();
  if (/captcha|bot check|robot|human verification|verify (?:that )?you(?:'| a)re|puzzle/.test(m)) return 'captcha';
  if (/sign[ -]?in\b|log[ -]?in\b|create an account|account (?:is )?required|password/.test(m)) return 'login';
  if (status !== 'awaiting_approval') return 'other';
  if (/only you can do|which only you/.test(m)) return 'question';
  if (/submits? (?:a job |an )?application|may send an application|sends something to someone|ready (?:to|for) (?:submit|send|review)|shall i (?:press|submit|send|proceed)|press (?:the )?(?:final )?submit|confirm (?:the )?submi|needs your approval/.test(m)) return 'submit';
  // "Ready to be submitted. Please confirm if I should proceed": the agent asking for the yes the person already gave.
  if (/\bsubmi(?:t|ts|tted|tting|ssion)\b/.test(m) && /\b(confirm|proceed|go ahead|shall i|should i|would you like|ready)\b/.test(m) && !/\b(consent|privacy|agree)\b/.test(m)) return 'submit';
  if (/consent|privacy|data processing|gdpr|terms|agree/.test(m)) return 'consent';
  return 'question';
}

/** The question a stopped run asks, quoted when it quotes the form. */
export function questionIn(message: string): string {
  const q = message.match(/["“]([^"”]{8,300})["”]/);
  return q ? q[1].trim() : cut(message.replace(/\s+/g, ' ').trim(), 300);
}

/** The ref of the form's final Submit in a page snapshot. */
export function submitRef(snapshot: string): string | null {
  const found: { name: string; ref: string }[] = [];
  for (const line of snapshot.split('\n')) {
    const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
    if (!ref || !/\bbutton\b/i.test(line)) continue;
    const name = line.match(/["“]([^"”]*)["”]/)?.[1] ?? '';
    found.push({ name, ref });
  }
  const score = (n: string) => (/submit (?:my |your )?application/i.test(n) ? 3 : /^\s*submit\b/i.test(n) ? 2 : /\b(submit|send application)\b/i.test(n) ? 1 : 0);
  const best = found.filter((f) => score(f.name) > 0).sort((a, b) => score(b.name) - score(a.name))[0];
  return best?.ref ?? null;
}

// A line of the engine's snapshot: "  - textbox "Email" [ref=e14] [required]: "avery@mail.example"".
const NODE = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;
const CONTROLS = new Set(['textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'spinbutton', 'searchbox']);
const FILE_NAME = /[\w.-]+\.(?:pdf|docx?|rtf|txt)\b/i;
const GENERIC = /^(type your response|select\.*|choose\.*|cards\[|file$|upload file$)/i;

/**
 * What a form held, read from the engine's snapshot of it: one entry per question (a group of radio
 * buttons is one), whether it has a value, which required ones are blank, and whether a résumé is on it.
 */
export function inspectSnapshot(snapshot: string): FormInspection {
  const fields: (FormInspection['fields'][number] & { required: boolean })[] = [];
  const parents: { indent: number; label: string }[] = [];
  let resume = false;
  let group: { key: string; field: (typeof fields)[number] } | null = null;
  const lines = unfence(snapshot).split('\n');
  lines.forEach((line, i) => {
    const m = line.match(NODE);
    if (!m) return;
    const [, pad, role, rawLabel = '', rest] = m;
    const indent = pad.length;
    while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
    const label = rawLabel.replace(/\s*✱\s*/g, ' ').trim();
    if (!/\[ref=e\d+\]/.test(rest) || role === 'link') {
      if (role === 'paragraph' || role === 'text') {
        // Greenhouse shows an attached file as its name with a Remove button beside it.
        const named = (rest.match(/:\s*"([^"]*)"/)?.[1] ?? '').trim();
        if (FILE_NAME.test(named) && /Remove file/i.test(lines[i + 1] ?? '')) {
          resume = true;
          fields.push({ label: 'Résumé', kind: 'file', filled: true, required: false });
        }
      }
      return;
    }
    const file = /\[file\]/.test(rest);
    if (!CONTROLS.has(role) && !file) {
      if (label) parents.push({ indent, label });
      return;
    }
    // An option wrapped in a list item named after itself belongs to the question above that item.
    const own = (role === 'radio' || role === 'checkbox') && parents.at(-1)?.label === label;
    const parent = (own ? parents.at(-2)?.label : parents.at(-1)?.label) ?? '';
    // An unnamed file box outside the form ("autofill from résumé") is not one of its questions.
    if (file && !label && !/\[required\]/.test(rest)) return;
    const name = cut((!label || GENERIC.test(label) || role === 'radio' || role === 'checkbox' ? parent || label : label).replace(/\s+(Yes|No|Not Applicable)(\s+(Yes|No|Not Applicable))*$/, ''), 80) || role;
    const value = (rest.match(/\]:\s*"([^"]*)"/)?.[1] ?? '').trim();
    const checked = /\[(?:checked|selected)(?:=true)?\]/.test(rest);
    const required = /\[required\]/.test(rest);
    if (role === 'radio' || role === 'checkbox') {
      const key = `${parent}|${indent}`;
      if (group?.key === key) {
        group.field.filled ||= checked;
        group.field.required ||= required;
        return;
      }
      const field = { label: name, kind: role, filled: checked, required };
      fields.push(field);
      group = { key, field };
      return;
    }
    group = null;
    const attached = file && (FILE_NAME.test(value) || FILE_NAME.test(label));
    if (attached && /résumé|resume|\bcv\b/i.test(`${label} ${parent}`)) resume = true;
    fields.push({ label: file ? (/(résumé|resume|\bcv\b)/i.test(`${label} ${parent}`) ? 'Résumé' : name.replace(FILE_NAME, '').trim() || 'File') : name, kind: file ? 'file' : role, filled: attached || !!value || checked, required });
  });
  const left = fields.filter((f) => !f.filled);
  return {
    found: fields.length, filled: fields.length - left.length, unfilled: left.map((f) => f.label).slice(0, 20), resume,
    required: fields.filter((f) => f.required).length, requiredLeft: left.filter((f) => f.required).map((f) => f.label).slice(0, 20),
    fields: fields.slice(0, 60).map(({ required: _r, ...f }) => f),
  };
}

// ---------------------------------------------------------------- batches

const batches = new Map<string, ApplyBatch>();

const shotDir = () => join(store.stateDir(), 'apply-shots');
export const shotPath = (runId: string) => join(shotDir(), `${runId.replace(/[^\w-]/g, '')}.png`);
function saveShot(runId: string, png: Buffer): void {
  try { mkdirSync(shotDir(), { recursive: true }); writeFileSync(shotPath(runId), png); } catch { /* a missing picture costs nothing */ }
}
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

function save(run: ApplyRun): void {
  store.put('apply-run', run.id, run);
}

export function getBatch(id: string): ApplyBatch | undefined {
  const live = batches.get(id);
  if (live) return live;
  const b = store.get<{ id: string; startedAt: string; endedAt?: string; ms?: number; runIds: string[]; note?: string; dryRun?: boolean }>('apply-batch', id);
  if (!b) return undefined;
  return { id: b.id, startedAt: b.startedAt, endedAt: b.endedAt, ms: b.ms, note: b.note, dryRun: b.dryRun, runs: b.runIds.map((r) => store.get<ApplyRun>('apply-run', r)).filter((r): r is ApplyRun => !!r) };
}

export function recentRuns(limit = 24): ApplyRun[] {
  return store.list<ApplyRun>('apply-run').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

export function activeBatches(): ApplyBatch[] {
  return [...batches.values()].filter((b) => !b.endedAt);
}

/** Runs a previous process left open: they ended when it did. */
export function closeOrphanRuns(now = new Date()): number {
  let n = 0;
  for (const r of store.list<ApplyRun>('apply-run')) {
    if ((r.status !== 'running' && r.status !== 'queued') || batches.has(r.batchId)) continue;
    r.status = 'failed';
    r.reasonCode = 'site-error';
    r.reason = 'Tack stopped while this run was going; it is under Needs you to check and retry.';
    r.endedAt = now.toISOString();
    r.steps.push({ at: r.endedAt, kind: 'error', label: 'Ended when Tack stopped' });
    save(r);
    n++;
  }
  return n;
}

function persistBatch(b: ApplyBatch): void {
  store.put('apply-batch', b.id, { id: b.id, startedAt: b.startedAt, endedAt: b.endedAt, ms: b.ms, note: b.note, dryRun: b.dryRun, runIds: b.runs.map((r) => r.id) });
}

function record(run: ApplyRun, p: Posting): Application {
  const profile = store.get<Profile>('single', 'profile');
  let fit = p.fit ?? 50;
  if (p.fit == null && profile) { try { fit = postingFit(profile, p); } catch { /* keep 50 */ } }
  const at = run.endedAt ?? new Date().toISOString();
  const via = run.target === 'practice' ? 'Practice application filled and submitted by the engine' : 'Filled and submitted by the engine';
  const app: Application = {
    id: newId('app'), postingId: p.id, title: p.title, company: p.company, url: run.url,
    roleFamily: p.roleFamily ?? 'unknown', seniority: p.seniority ?? 'unknown', companySize: p.companySize ?? 'unknown',
    source: p.source || 'company-site', fit: Math.round(fit), appliedAt: at, status: 'applied', lastEventAt: at,
    events: [{ at, kind: 'applied', note: `${via}. ${run.confirmation ?? ''}`.trim() }], origin: 'fanfold',
  };
  store.put('application', app.id, app);
  return app;
}

export interface SubmitResult { pressed: boolean; opened?: boolean; held?: string; text: string }

export interface Runner {
  /** Files the job in the engine and saves the person's answers for it, so the form fills them as theirs. */
  prepare(job: { url: string; company: string; title: string }, answers: { question: string; answer: string }[]): Promise<string[]>;
  /** A session of its own: a tab in its own Chrome window. */
  open(session: string): Promise<void>;
  /** One agent run in the session. Replaced in tests. */
  run(session: string, goal: string, onProgress: (m: string) => void): Promise<{ status: string; message: string }>;
  /** Presses the form's final Submit as the host, so the engine judges it on the person's standing yes. */
  submit(session: string): Promise<SubmitResult>;
  /** What the form on the session's page holds, with the snapshot it was read from. */
  inspect(session: string): Promise<(FormInspection & { raw?: string }) | undefined>;
  /** Ends approvals the engine holds for this page (a host, or an address prefix), so nothing is left to send. */
  release(since: string, where: string): Promise<number>;
  /** A picture of the session's page as it is now. */
  shot(session: string): Promise<Buffer | undefined>;
  close(session: string): Promise<void>;
  end(): Promise<void>;
}

const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

async function engineRunner(h: EngineHandle): Promise<Runner> {
  const mcp = await new McpClient(h).connect();
  const maxSteps = Number(process.env.TACK_APPLY_MAX_STEPS) || 45;
  return {
    async prepare(job, answers) {
      const notes: string[] = [];
      if (h.ownerToken) {
        await ownerCall(h, 'POST', '/api/applications', job).catch((e: unknown) => {
          if (!(e instanceof EngineError) || e.status !== 409) notes.push(`could not file the job: ${(e as Error).message}`);
        });
      }
      for (const a of answers) {
        const r = await mcp.call('job_save_answer', { question: a.question, answer: a.answer, said_by_user: true, job });
        if (r.isError) notes.push(`answer not saved for "${cut(a.question, 60)}": ${cut(r.text, 120)}`);
      }
      return notes;
    },
    async open(session) {
      const r = await mcp.call('session_open', { name: session });
      if (r.isError) throw new Error(r.text);
    },
    async run(session, goal, progress) {
      const res = await mcp.call('agent_run', { goal, session, max_steps: maxSteps }, { onProgress: progress });
      return parseRunResult(res.text);
    },
    async submit(session) {
      const snap = await mcp.call('browser_snapshot', { session });
      const ref = submitRef(snap.text);
      if (!ref) return { pressed: false, held: 'no Submit button was found on the page', text: unfence(snap.text).slice(0, 2000) };
      const r = await mcp.call('browser_act', { session, action: 'click', ref });
      const text = unfence(r.text);
      const opened = /opened the application form; nothing has been sent/i.test(text);
      const pressed = !opened && /so it was (?:sent|pressed) at once/i.test(text);
      const held = pressed || opened ? undefined
        : text.match(/not submitted automatically because ([^\n]+?)\.(?:\s|$)/i)?.[1] ?? (r.isError ? cut(text, 240) : cut(text.split('\n')[0] ?? '', 240));
      return { pressed, opened, held, text: text.slice(0, 4000) };
    },
    async inspect(session) {
      const r = await mcp.call('browser_snapshot', { session }).catch(() => null);
      return r && !r.isError ? { ...inspectSnapshot(r.text), raw: unfence(r.text) } : undefined;
    },
    async release(since, where) {
      if (!h.ownerToken) return 0;
      const state = await ownerCall<{ approvals?: { id: string; url: string; requestedAt: string }[] }>(h, 'GET', '/api/state').catch(() => null);
      let n = 0;
      for (const a of state?.approvals ?? []) {
        const mine = !where || hostOf(a.url) === where || a.url.startsWith(where);
        if (a.requestedAt < since || !mine) continue;
        await ownerCall(h, 'POST', `/api/approvals/${encodeURIComponent(a.id)}/reject`, { note: 'Tack ended this run before anything was sent' }).then(() => n++).catch(() => {});
      }
      return n;
    },
    async shot(session) {
      const r = await mcp.call('browser_screenshot', { session }).catch(() => null);
      return r?.image ? Buffer.from(r.image.data, 'base64') : undefined;
    },
    async close(session) {
      await mcp.call('session_close', { name: session }).catch(() => null);
    },
    end: () => mcp.close(),
  };
}

/** Kept for older callers: whether a run stopped to ask for a yes the person already gave. */
export function waitsOnYes(status: string, message: string): boolean {
  return status !== 'failed' && holdOf(status, message) === 'submit';
}

export const FOLLOW_UP = 'The final Submit was pressed. If the page now confirms the application was received, finish with done and quote the confirmation and any reference number exactly. '
  + 'If the page shows errors instead, fix every field it names and press the final Submit again. Do not ask the person; nothing else is needed from them.';

export const CONSENT_FOLLOW_UP = 'The person has answered: their saved answer to this form\'s consent box is Yes, given as their standing consent. '
  + 'On the page that is open, tick the consent box, then go on and press the final Submit. When the page confirms it, quote the confirmation exactly.';

const MAX_TURNS = 4;

export interface BatchDeps {
  engine?: () => Promise<EngineHandle>;
  runner?: (h: EngineHandle) => Promise<Runner>;
  kit?: (p: Posting) => Promise<Kit | undefined>;
  sync?: (h: EngineHandle, step: (s: string, d: string) => void) => Promise<void>;
  tile?: (pages: { key: string; hosts: string[] }[]) => Promise<{ moved: number; note: string }>;
}

export interface BatchOpts {
  /** Queue job for each posting, settled when its run ends. */
  jobs?: Map<string, string>;
  dryRun?: boolean;
  /** Between session starts, so parallel runs do not hit the model at the same second. */
  staggerMs?: number;
  /** What started it, for the trace. */
  label?: string;
}

async function kitFor(p: Posting): Promise<Kit | undefined> {
  try { return cachedKit(p.id) ?? (await buildKit(p.id)); } catch { return cachedKit(p.id); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (ok()) return true;
  return ok();
}
const CONFIRMED = /\b(thank you for (?:applying|your application)|application (?:has been |was )?(?:submitted|received)|we(?:'ve| have) received your application|successfully (?:submitted|applied)|reference (?:number|no\.?)\b)/i;

/**
 * Starts applying to these postings, all at once, and returns the batch straight away.
 * `done` settles when every run has ended.
 */
export function startBatch(postings: Posting[], deps: BatchDeps = {}, opts: BatchOpts = {}): { batch: ApplyBatch; done: Promise<ApplyBatch> } {
  const t0 = Date.now();
  const dry = opts.dryRun ?? isDryRun();
  const batch: ApplyBatch = { id: newId('batch'), startedAt: new Date().toISOString(), runs: [], ...(dry ? { dryRun: true } : {}) };
  for (const p of postings.slice(0, MAX_PARALLEL)) {
    const target = targetFor(p);
    batch.runs.push({
      id: newId('run'), batchId: batch.id, postingId: p.id, company: p.company, title: p.title, target,
      url: target === 'practice' ? practiceUrl(p.id) : applicationUrl(p.url),
      session: `tack-${p.id.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 18)}-${randomUUID().slice(0, 4)}`,
      status: 'queued', steps: [], fields: 0, startedAt: batch.startedAt,
      ...(opts.jobs?.get(p.id) ? { jobId: opts.jobs.get(p.id) } : {}), ...(dry ? { dryRun: true } : {}),
    });
  }
  batches.set(batch.id, batch);
  persistBatch(batch);
  for (const r of batch.runs) {
    save(r);
    if (r.jobId) queue.markRunning(r.jobId, r.id);
  }
  const stagger = opts.staggerMs ?? (Number(process.env.TACK_APPLY_STAGGER_MS ?? 5000) || 0);

  const done = (async () => {
    const line = (run: string, step: string, detail: string, status: 'start' | 'ok' | 'fail' = 'start') => {
      try { emit({ run, step, detail, status, ms: Date.now() - t0 }); } catch { /* best effort */ }
    };
    const settleJob = (run: ApplyRun) => {
      if (!run.jobId) return;
      const out: queue.Outcome = run.status === 'applied' ? { kind: 'submitted', applicationId: run.applicationId, detail: run.confirmation }
        : run.status === 'dry-run' ? { kind: 'dry-run', detail: run.confirmation ?? 'filled, not sent' }
          : { kind: 'failed', reason: run.reasonCode ?? 'site-error', detail: run.reason ?? 'not sent', ...(run.question ? { question: run.question } : {}) };
      queue.settle(run.jobId, out);
    };
    const fail = (run: ApplyRun, reason: string, code?: queue.FailureReason, question?: string) => {
      run.status = 'failed';
      run.reason = reason;
      run.reasonCode = code ?? queue.classifyFailure(reason);
      if (question) run.question = question;
      run.endedAt = new Date().toISOString();
      run.ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
      run.steps.push({ at: run.endedAt, kind: 'error', label: `${queue.REASONS[run.reasonCode].label}: ${cut(reason, 180)}` });
      save(run);
      settleJob(run);
      line('apply', run.company, `${queue.REASONS[run.reasonCode].label.toLowerCase()}: ${cut(reason, 160)}`, 'fail');
    };
    line('apply', 'start', `${batch.runs.length} application${batch.runs.length === 1 ? '' : 's'} in parallel${dry ? ' as a DRY RUN (nothing is submitted)' : ''}: ${batch.runs.map((r) => r.company).join(', ')}`);
    let h: EngineHandle;
    let runner: Runner | null = null;
    try {
      h = await (deps.engine ?? ensureEngine)();
      line('apply', 'engine', `${h.mode === 'own' ? 'Tack\'s engine' : 'attached Fanfold'} on port ${h.port}`);
      await (deps.sync ?? syncEngineProfile)(h, (s, d) => line('apply', s, d));
      runner = await (deps.runner ?? engineRunner)(h);
    } catch (e) {
      for (const r of batch.runs) fail(r, `The engine could not start: ${(e as Error).message}`, 'site-error');
      return finish();
    }
    const details = getDetails() ?? BLANK_DETAILS;
    const consent = getConsent();
    const opened = new Set<ApplyRun>();
    let tiling: Promise<unknown> = Promise.resolve();
    const retile = () => {
      const tile = deps.tile ?? ((pages) => tileWindows(pages, { chromePath: process.env.TACK_CHROME_PATH }));
      const live = batch.runs.filter((r) => opened.has(r) && r.status === 'running');
      if (live.length < 2) return;
      tiling = tiling.then(() => tile(live.map((r) => ({ key: r.id, hosts: [r.url.split('?')[0].toLowerCase(), hostOf(r.url)] }))))
        .then((t) => { if (t && typeof t === 'object' && 'note' in t) line('apply', 'windows', String((t as { note: string }).note)); })
        .catch(() => {});
    };

    await Promise.all(batch.runs.map(async (run, i) => {
      if (i && stagger) await sleep(i * stagger);
      const p = store.get<Posting>('posting', run.postingId);
      if (!p) return fail(run, 'The posting is no longer in Tack.', 'form-not-found');
      if (run.target === 'live' && !p.live) return fail(run, 'This posting is sample data, not a real opening.', 'form-not-found');
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      save(run);
      const tag = `apply ${run.company}`;
      const job = run.jobId ? queue.getJob(run.jobId) : undefined;
      try {
        const kit = await (deps.kit ?? kitFor)(p);
        const practiceAnswers = run.target === 'practice' ? answersFor(screeningQuestions(p), kit, p) : [];
        // The practice form's questions are known in advance: the person's answers go in as theirs, consent too when given.
        const consentSaved = run.target === 'practice' && consent.on && !dry;
        const saved = [
          ...practiceAnswers,
          ...(consentSaved ? [{ question: consentText(p), answer: 'Yes' }] : []),
          ...(job?.question && job.answer ? [{ question: job.question, answer: job.answer }] : []),
        ];
        const jobRef = { url: run.url, company: p.company, title: p.title };
        for (const n of await runner!.prepare(jobRef, saved)) line(tag, 'prepare', n);
        const remembered = queue.rememberedAnswers().map((a) => ({ question: a.question, answer: a.answer }));
        const goal = goalFor({
          posting: p, url: run.url, target: run.target, details, answers: practiceAnswers, saved: practiceAnswers.length > 0, consentSaved,
          kit, session: run.session, dryRun: dry, remembered,
        });
        line(tag, 'session', `${run.session}: ${dry ? 'DRY RUN on ' : ''}${run.target === 'practice' ? 'practice application' : 'live posting'} ${run.url}`);
        const progress = (msg: string) => {
          const step = onProgress(run, msg);
          if (step) {
            save(run);
            line(tag, step.kind, step.label);
            if (step.kind === 'open' && !opened.has(run)) { opened.add(run); retile(); }
          }
        };
        // The practice form keeps its own record, which is the proof; a live site has only its confirmation page.
        const submitted = () => (run.target === 'practice' ? submissions(p.id).filter((s) => s.at >= run.startedAt).at(-1) : undefined);
        await runner!.open(run.session);
        let res: { status: string; message: string };
        let shot: Buffer | undefined;
        let pressed = false;
        let outcome: { kind: 'sent'; text: string } | { kind: 'dry'; text: string } | { kind: 'fail'; why: string; code: queue.FailureReason; question?: string } | null = null;
        try {
          res = await runner!.run(run.session, goal, progress);
          for (let turn = 0; turn < MAX_TURNS && !outcome; turn++) {
            if (submitted()) { outcome = { kind: 'sent', text: res.message }; break; }
            const hold = holdOf(res.status, res.message);
            if (!hold) {
              if (dry) outcome = { kind: 'dry', text: res.message };
              else if (run.target === 'live' && pressed) outcome = { kind: 'sent', text: res.message };
              else if (run.target === 'live' && CONFIRMED.test(res.message)) outcome = { kind: 'sent', text: res.message };
              else outcome = { kind: 'fail', why: res.message || 'The engine finished without sending the form.', code: run.target === 'practice' ? 'site-error' : queue.classifyFailure(res.message, res.status) };
              break;
            }
            if (hold === 'captcha') { outcome = { kind: 'fail', why: res.message, code: 'captcha' }; break; }
            if (hold === 'login') { outcome = { kind: 'fail', why: res.message, code: 'login-required' }; break; }
            // A dry run measures the form: wherever it stopped short of Submit, what was filled is the result.
            if (dry && (hold === 'question' || (hold === 'other' && res.status !== 'failed'))) { outcome = { kind: 'dry', text: `Stopped before Submit: ${res.message}` }; break; }
            if (hold === 'other') { outcome = { kind: 'fail', why: res.message || `The engine ended with status ${res.status}.`, code: queue.classifyFailure(res.message, res.status) }; break; }
            if (hold === 'question') { outcome = { kind: 'fail', why: res.message, code: 'answer-missing', question: questionIn(res.message) }; break; }
            if (hold === 'consent') {
              if (dry) { outcome = { kind: 'dry', text: `Stopped at the consent box, left unticked: ${res.message}` }; break; }
              if (!consent.on) { outcome = { kind: 'fail', why: `The form has a consent box and you have not given standing consent: ${res.message}`, code: 'consent-needed', question: questionIn(res.message) }; break; }
              const q = questionIn(res.message);
              for (const n of await runner!.prepare(jobRef, [{ question: q, answer: 'Yes' }])) line(tag, 'prepare', n);
              run.steps.push({ at: new Date().toISOString(), kind: 'note', label: 'Ticked the consent box on your standing consent' });
              save(run);
              line(tag, 'consent', `saved your standing consent for "${cut(q, 100)}"`);
              res = await runner!.run(run.session, CONSENT_FOLLOW_UP, progress);
              continue;
            }
            // At the final Submit, which the engine's gate holds for the person.
            if (dry) { outcome = { kind: 'dry', text: 'Filled and stopped at the final Submit, which was not pressed.' }; break; }
            if (!consent.on) { outcome = { kind: 'fail', why: 'Filled and stopped before the final Submit: you have not given standing consent to submit for you.', code: 'consent-needed' }; break; }
            run.steps.push({ at: new Date().toISOString(), kind: 'submit', label: 'Pressing Submit on your standing consent' });
            save(run);
            const s = await runner!.submit(run.session);
            if (s.pressed || s.opened) {
              pressed = s.pressed;
              line(tag, 'submit', s.pressed ? 'the engine sent it on your standing consent' : 'that opened the application form; filling it in');
              if (s.pressed && run.target === 'practice') await until(() => !!submitted(), 8000);
              if (submitted()) { outcome = { kind: 'sent', text: s.text }; break; }
              if (s.pressed && CONFIRMED.test(s.text)) { outcome = { kind: 'sent', text: (s.text.match(CONFIRMED)?.[0] ?? 'Application submitted') }; break; }
              res = await runner!.run(run.session, s.pressed ? FOLLOW_UP : goal, progress);
              continue;
            }
            outcome = { kind: 'fail', why: `The engine held the Submit: ${s.held ?? 'no reason given'}.`, code: queue.classifyFailure(s.held ?? '') };
          }
          if (!outcome) outcome = submitted() ? { kind: 'sent', text: res.message } : { kind: 'fail', why: `Stopped after ${MAX_TURNS} turns without a confirmation: ${res.message}`, code: 'timeout' };
          if (dry || run.target === 'live') {
            const seen = await runner!.inspect(run.session).catch(() => undefined);
            if (seen) {
              const { raw, ...inspection } = seen;
              run.inspection = inspection;
              // The page as the engine read it when Tack left, kept beside the picture.
              if (raw) { try { mkdirSync(shotDir(), { recursive: true }); writeFileSync(shotPath(run.id).replace(/\.png$/, '.txt'), raw); } catch { /* best effort */ } }
            }
          }
          // Held for blank required answers: the person is asked the first of them by name.
          const blank = run.inspection?.requiredLeft ?? [];
          if (outcome.kind === 'fail' && outcome.code === 'answer-missing' && blank.length && (!outcome.question || /required field/i.test(outcome.question))) {
            outcome = { ...outcome, question: blank[0], why: `${outcome.why} Required and still blank: ${blank.slice(0, 6).join('; ')}.` };
          }
          shot = await runner!.shot(run.session).catch(() => undefined);
        } finally {
          // Nothing the engine still holds for this page may go out after Tack leaves it.
          if (dry || outcome?.kind !== 'sent') await runner!.release(run.startedAt, run.target === 'practice' ? run.url : hostOf(run.url)).catch(() => 0);
          await runner!.close(run.session);
        }
        run.endedAt = new Date().toISOString();
        run.ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
        if (shot) { saveShot(run.id, shot); run.shot = true; }
        if (!outcome) return fail(run, 'The run ended without an outcome.', 'site-error');
        if (outcome.kind === 'fail') return fail(run, outcome.why, outcome.code, outcome.question);
        if (outcome.kind === 'dry') {
          run.status = 'dry-run';
          const f = run.inspection;
          run.confirmation = `DRY RUN, not submitted. ${f ? `${f.filled} of ${f.found} fields filled${f.unfilled.length ? ` (left: ${f.unfilled.slice(0, 5).join(', ')})` : ''}, résumé ${f.resume ? 'attached' : 'not seen'}. ` : ''}${cut(outcome.text, 200)}`;
          run.steps.push({ at: run.endedAt, kind: 'confirm', label: 'Dry run: filled, not submitted' });
          save(run);
          settleJob(run);
          line(tag, 'dry-run', run.confirmation, 'ok');
          return;
        }
        const sub = submitted();
        run.status = 'applied';
        run.reference = sub?.ref;
        run.confirmation = sub ? `Application submitted. Reference ${sub.ref}.` : cut(outcome.text, 300);
        run.steps.push({ at: run.endedAt, kind: 'confirm', label: sub ? `Confirmed, reference ${sub.ref}` : `Confirmed: ${cut(outcome.text, 140)}` });
        run.applicationId = record(run, p).id;
        save(run);
        settleJob(run);
        line(tag, 'confirm', run.confirmation, 'ok');
      } catch (e) {
        fail(run, (e as Error).message);
      }
    }));
    await tiling;
    await runner?.end().catch(() => {});
    return finish();
  })();

  function finish(): ApplyBatch {
    batch.endedAt = new Date().toISOString();
    batch.ms = Date.now() - t0;
    const ok = batch.runs.filter((r) => r.status === 'applied').length;
    const dryOk = batch.runs.filter((r) => r.status === 'dry-run').length;
    batch.note = dry ? `DRY RUN: ${dryOk} of ${batch.runs.length} filled and left unsent in ${(batch.ms / 1000).toFixed(1)} s`
      : `${ok} of ${batch.runs.length} submitted in ${(batch.ms / 1000).toFixed(1)} s`;
    persistBatch(batch);
    try { emit({ run: 'apply', step: 'done', detail: batch.note, status: ok || dryOk ? 'ok' : 'fail', ms: batch.ms }); } catch { /* best effort */ }
    return batch;
  }

  return { batch, done };
}

// ---------------------------------------------------------------- through the queue

export class ApplyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Queues these postings and starts them now. Ones applied to before are refused, with why. */
export function applyNow(postings: Posting[], o: { source: 'manual' | 'autopilot'; autopilotRunId?: string; deps?: BatchDeps; why?: Map<string, string> } = { source: 'manual' }):
  { batch: ApplyBatch; done: Promise<ApplyBatch>; skipped: { postingId: string; company: string; why: string }[] } | { batch: null; done: Promise<null>; skipped: { postingId: string; company: string; why: string }[] } {
  const dry = isDryRun();
  const { added, skipped } = queue.enqueue(postings, { source: o.source, autopilotRunId: o.autopilotRunId, dryRun: dry, why: o.why });
  if (!added.length) return { batch: null, done: Promise.resolve(null), skipped };
  const byId = new Map(postings.map((p) => [p.id, p]));
  const jobs = new Map(added.map((j) => [j.postingId, j.id]));
  const { batch, done } = startBatch(added.map((j) => byId.get(j.postingId)!).filter(Boolean), o.deps, { jobs, dryRun: dry });
  return { batch, done, skipped };
}

/** Runs the queue's jobs whose turn has come: retries after their backoff, and answered questions. */
export function runDue(o: { now?: Date; deps?: BatchDeps; limit?: number } = {}): { batch: ApplyBatch | null; done: Promise<ApplyBatch | null> } {
  const busy = new Set(activeBatches().flatMap((b) => b.runs.map((r) => r.postingId)));
  const due = queue.dueJobs(o.now, o.limit ?? MAX_PARALLEL).filter((j) => !busy.has(j.postingId));
  const pairs = due.map((j) => ({ j, p: store.get<Posting>('posting', j.postingId) })).filter((x): x is { j: queue.ApplyJob; p: Posting } => {
    if (x.p && !x.p.closedAt) return true;
    queue.settle(x.j.id, { kind: 'failed', reason: 'form-not-found', detail: 'The posting has closed or left Tack.' });
    return false;
  });
  if (!pairs.length) return { batch: null, done: Promise.resolve(null) };
  const { batch, done } = startBatch(pairs.map((x) => x.p), o.deps, { jobs: new Map(pairs.map((x) => [x.p.id, x.j.id])), dryRun: pairs.some((x) => x.j.dryRun) || isDryRun() });
  return { batch, done };
}
