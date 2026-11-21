// Automated applying through the engine. Each posting gets its own engine session (its own tiled
// Chrome window) and its own agent; a batch runs them side by side and one failure stops nothing else.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from './store.ts';
import { emit } from './trace.ts';
import { ensureEngine, type EngineHandle } from './engine-proc.ts';
import { EngineError, McpClient, ownerCall } from './engine-client.ts';
import { consentText, practiceUrl, screeningQuestions, submissions, type PracticeQuestion } from './practice.ts';
import { buildKit, cachedKit } from './kit.ts';
import { postingFit } from './gap.ts';
import type { Application, ApplicationDetails, ApplyBatch, ApplyReadiness, ApplyRun, ApplyStep, Kit, Posting, Profile } from './types.ts';

export const MAX_PARALLEL = 8;
const DETAILS = 'details';
const RESUME = 'resume-file';

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

/** The demo person and sample postings apply to Tack's practice form; a real person to the real posting. */
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
  const reason = missing.length
    ? `Add your ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} under Application details on Start before applying.`
    : target === 'practice' ? 'Ready. Sample postings go to Tack\'s practice application form, never to a company.' : 'Ready. Applications are filled and submitted in Chrome without a review step.';
  return { ready: !missing.length, missing, reason, target };
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

/** Pushes the details and the résumé into the engine's profile once per change. An attached Fanfold keeps its own. */
export async function syncEngineProfile(h: EngineHandle, step: (s: string, d: string) => void, opts: { identityOnly?: boolean } = {}): Promise<void> {
  if (h.mode === 'attach') { step('profile', 'using the attached Fanfold\'s own profile and résumé'); return; }
  const d = getDetails();
  const resume = getResume();
  if (!d || (!resume && !opts.identityOnly)) throw new Error('Add your details and résumé before applying.');
  const profile = store.get<Profile>('single', 'profile');
  const fields = engineFields(d, profile);
  const want = { fields: hashOf(fields), resume: resume ? hashOf([resume.filename, resume.base64 ?? resume.text]) : '' };
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
  store.put('single', key, { fields: want.fields, resume: opts.identityOnly ? had?.resume ?? '' : want.resume });
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

/** What the engine's agent is told. Answers saved in advance are not repeated; the whole stays under the tool's limit. */
export function goalFor(o: { posting: Posting; url: string; target: 'practice' | 'live'; details: ApplicationDetails; answers: { question: string; answer: string }[]; saved?: boolean; kit?: Kit }): string {
  const { posting: p, details: d } = o;
  const facts = [
    `name ${d.fullName}`, `email ${d.email}`, d.phone && `phone ${d.phone}`, d.city && `city ${d.city}`, d.linkedin && `LinkedIn ${d.linkedin}`,
    d.workAuthorisation && `work authorisation ${d.workAuthorisation}`, d.noticePeriod && `notice period ${d.noticePeriod}`,
  ].filter(Boolean).join(', ');
  const head = [
    `Apply to the ${p.title} role at ${p.company} and submit the application. Start here: ${o.url}`,
    'The person asked for this application to be filled and sent without a review step, so do not stop to ask before submitting. Fill every field the form asks for, go through each step, and press the final Submit.',
    `Use their saved profile: ${facts}.`,
    'Upload their résumé document wherever the form asks for a résumé or CV. Choose the closest option in each dropdown.',
  ];
  if (o.saved) head.push('Their own answers to this form\'s written questions and its consent box (Yes) are already saved in Fanfold for this job: use them as they are, and tick the consent box.');
  const tail = 'When the page confirms the application was received, finish and quote the confirmation text and any reference number exactly. If the form asks something you cannot answer from this, stop and say exactly what it asked.';
  const extra: string[] = [];
  if (!o.saved && o.answers.length) {
    extra.push('For written questions use these answers:');
    for (const a of o.answers) extra.push(`- "${a.question}": ${cut(a.answer, 900)}`);
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
    if (SUBMIT.test(reason)) return push({ kind: 'submit', label: 'Pressed Submit' });
    if (NEXT.test(reason)) { formFound(); return push({ kind: 'next', label: 'Moved to the next step' }); }
    return null;
  }
  if (kind === 'ask_user') return push({ kind: 'error', label: `Stopped to ask: ${cut(reason, 140)}` });
  return null;
}

/** Status line and message out of agent_run's answer. */
export function parseRunResult(text: string): { status: string; message: string } {
  const status = text.match(/^status:\s*(\S+)/m)?.[1] ?? 'unknown';
  const message = text.split('\n').filter((l) => !/^status:|^steps:/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
  return { status, message };
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
  const b = store.get<{ id: string; startedAt: string; endedAt?: string; ms?: number; runIds: string[]; note?: string }>('apply-batch', id);
  if (!b) return undefined;
  return { id: b.id, startedAt: b.startedAt, endedAt: b.endedAt, ms: b.ms, note: b.note, runs: b.runIds.map((r) => store.get<ApplyRun>('apply-run', r)).filter((r): r is ApplyRun => !!r) };
}

export function recentRuns(limit = 24): ApplyRun[] {
  return store.list<ApplyRun>('apply-run').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

function persistBatch(b: ApplyBatch): void {
  store.put('apply-batch', b.id, { id: b.id, startedAt: b.startedAt, endedAt: b.endedAt, ms: b.ms, note: b.note, runIds: b.runs.map((r) => r.id) });
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

export interface Runner {
  /** Files the job in the engine and saves the person's answers for it, so the form fills them as theirs. */
  prepare(job: { url: string; company: string; title: string }, answers: { question: string; answer: string }[]): Promise<string[]>;
  /** A session of its own: a tab in its own Chrome window. */
  open(session: string): Promise<void>;
  /** One agent run in the session. Replaced in tests. */
  run(session: string, goal: string, onProgress: (m: string) => void): Promise<{ status: string; message: string }>;
  /** A picture of the session's page as it is now. */
  shot(session: string): Promise<Buffer | undefined>;
  close(session: string): Promise<void>;
  end(): Promise<void>;
}

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

/** The engine stopped to ask for a yes it already has: to confirm the Submit, or to tick the consent the person saved. */
export function waitsOnYes(status: string, message: string): boolean {
  return status !== 'failed' && /\b(confirm|shall i|should i|would you like|do you want|proceed|consent|tick|ready to submit|ready for (?:your )?review|press (?:the )?(?:final )?submit|approv)/i.test(message);
}

export const FOLLOW_UP = 'The person has answered: yes. They asked for this application to be sent without a review step, and their saved answer to the consent box is Yes. '
  + 'On the page that is open, tick the consent box if it is not ticked, go to the last step, and press the final Submit. '
  + 'When the page confirms it, finish and quote the confirmation and any reference number exactly. Do not ask again.';

const MAX_FOLLOW_UPS = 2;

export interface BatchDeps {
  engine?: () => Promise<EngineHandle>;
  runner?: (h: EngineHandle) => Promise<Runner>;
  kit?: (p: Posting) => Promise<Kit | undefined>;
  sync?: (h: EngineHandle, step: (s: string, d: string) => void) => Promise<void>;
}

async function kitFor(p: Posting): Promise<Kit | undefined> {
  try { return cachedKit(p.id) ?? (await buildKit(p.id)); } catch { return cachedKit(p.id); }
}

/**
 * Starts applying to these postings, all at once, and returns the batch straight away.
 * `done` settles when every run has ended.
 */
export function startBatch(postings: Posting[], deps: BatchDeps = {}): { batch: ApplyBatch; done: Promise<ApplyBatch> } {
  const t0 = Date.now();
  const batch: ApplyBatch = { id: newId('batch'), startedAt: new Date().toISOString(), runs: [] };
  for (const p of postings.slice(0, MAX_PARALLEL)) {
    const target = targetFor(p);
    batch.runs.push({
      id: newId('run'), batchId: batch.id, postingId: p.id, company: p.company, title: p.title, target,
      url: target === 'practice' ? practiceUrl(p.id) : p.url,
      session: `tack-${p.id.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 18)}-${randomUUID().slice(0, 4)}`,
      status: 'queued', steps: [], fields: 0, startedAt: batch.startedAt,
    });
  }
  batches.set(batch.id, batch);
  persistBatch(batch);
  for (const r of batch.runs) save(r);

  const done = (async () => {
    const line = (run: string, step: string, detail: string, status: 'start' | 'ok' | 'fail' = 'start') => {
      try { emit({ run, step, detail, status, ms: Date.now() - t0 }); } catch { /* best effort */ }
    };
    const fail = (run: ApplyRun, reason: string) => {
      run.status = 'failed';
      run.reason = reason;
      run.endedAt = new Date().toISOString();
      run.ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
      run.steps.push({ at: run.endedAt, kind: 'error', label: cut(reason, 200) });
      save(run);
      line('apply', run.company, `failed: ${cut(reason, 160)}`, 'fail');
    };
    line('apply', 'start', `${batch.runs.length} application${batch.runs.length === 1 ? '' : 's'} in parallel: ${batch.runs.map((r) => r.company).join(', ')}`);
    let h: EngineHandle;
    let runner: Runner | null = null;
    try {
      h = await (deps.engine ?? ensureEngine)();
      line('apply', 'engine', `${h.mode === 'own' ? 'Tack\'s engine' : 'attached Fanfold'} on port ${h.port}`);
      await (deps.sync ?? syncEngineProfile)(h, (s, d) => line('apply', s, d));
      runner = await (deps.runner ?? engineRunner)(h);
    } catch (e) {
      for (const r of batch.runs) fail(r, `The engine could not start: ${(e as Error).message}`);
      return finish();
    }
    const details = getDetails() ?? BLANK_DETAILS;
    await Promise.all(batch.runs.map(async (run) => {
      const p = store.get<Posting>('posting', run.postingId);
      if (!p) return fail(run, 'The posting is no longer in Tack.');
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      save(run);
      const tag = `apply ${run.company}`;
      try {
        const kit = await (deps.kit ?? kitFor)(p);
        const answers = run.target === 'practice' ? answersFor(screeningQuestions(p), kit, p) : [];
        // The practice form's questions are known in advance: the person's answers go in as theirs, consent included.
        const saved = run.target === 'practice' ? [...answers, { question: consentText(p), answer: 'Yes' }] : [];
        for (const n of await runner!.prepare({ url: run.url, company: p.company, title: p.title }, saved)) line(tag, 'prepare', n);
        const goal = goalFor({ posting: p, url: run.url, target: run.target, details, answers, saved: saved.length > 0, kit });
        line(tag, 'session', `${run.session}: ${run.target === 'practice' ? 'practice application' : 'live posting'} ${run.url}`);
        const progress = (msg: string) => {
          const step = onProgress(run, msg);
          if (step) { save(run); line(tag, step.kind, step.label); }
        };
        // The practice form keeps its own record, which is the proof; a live site has only the agent's word.
        const submitted = () => (run.target === 'practice' ? submissions(p.id).filter((s) => s.at >= run.startedAt).at(-1) : undefined);
        const sent = (r: { status: string; message: string }) => (run.target === 'practice' ? !!submitted() : r.status === 'done');
        await runner!.open(run.session);
        let res: { status: string; message: string };
        let shot: Buffer | undefined;
        try {
          res = await runner!.run(run.session, goal, progress);
          // Fully automated means the person's yes is already given; with approvals on, the question stays theirs.
          const auto = (process.env.TACK_APPROVALS ?? 'none').trim().toLowerCase() === 'none';
          for (let i = 0; auto && i < MAX_FOLLOW_UPS && !sent(res) && waitsOnYes(res.status, res.message); i++) {
            run.steps.push({ at: new Date().toISOString(), kind: 'note', label: 'Engine asked for a yes; answered with the standing instruction' });
            save(run);
            line(tag, 'note', `engine asked: ${cut(res.message, 140)}; answering yes`);
            res = await runner!.run(run.session, FOLLOW_UP, progress);
          }
          shot = await runner!.shot(run.session).catch(() => undefined);
        } finally {
          await runner!.close(run.session);
        }
        run.endedAt = new Date().toISOString();
        run.ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
        if (shot) { saveShot(run.id, shot); run.shot = true; }
        const sub = submitted();
        const ok = sent(res);
        if (!ok) return fail(run, res.message || `The engine ended with status ${res.status}.`);
        run.status = 'applied';
        run.reference = sub?.ref;
        run.confirmation = sub ? `Application submitted. Reference ${sub.ref}.` : cut(res.message, 300);
        run.steps.push({ at: run.endedAt, kind: 'confirm', label: sub ? `Confirmed, reference ${sub.ref}` : `Confirmed: ${cut(res.message, 140)}` });
        run.applicationId = record(run, p).id;
        save(run);
        line(tag, 'confirm', run.confirmation, 'ok');
      } catch (e) {
        fail(run, (e as Error).message);
      }
    }));
    await runner?.end().catch(() => {});
    return finish();
  })();

  function finish(): ApplyBatch {
    batch.endedAt = new Date().toISOString();
    batch.ms = Date.now() - t0;
    const ok = batch.runs.filter((r) => r.status === 'applied').length;
    batch.note = `${ok} of ${batch.runs.length} submitted in ${(batch.ms / 1000).toFixed(1)} s`;
    persistBatch(batch);
    try { emit({ run: 'apply', step: 'done', detail: batch.note, status: ok ? 'ok' : 'fail', ms: batch.ms }); } catch { /* best effort */ }
    return batch;
  }

  return { batch, done };
}
