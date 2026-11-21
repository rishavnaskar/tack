// The persisted apply queue: one job per posting, never two for the same posting or the same
// company and title, bounded retries for what may pass on its own, and a "needs you" list for
// what only the person can settle (a CAPTCHA, a sign-in, an answer, their consent).

import { randomUUID } from 'node:crypto';
import * as store from './store.ts';
import type { Application, FailureCode, Posting } from './types.ts';

export const JOB_KIND = 'apply-job';
export const ANSWER_KIND = 'remembered-answer';

export type FailureReason = FailureCode;
export type JobState = 'queued' | 'running' | 'submitted' | 'failed' | 'needs-you' | 'awaiting-approval' | 'dry-run' | 'skipped';

export const REASONS: Record<FailureReason, { label: string; retry: boolean; help: string }> = {
  'form-not-found': { label: 'Form not found', retry: true, help: 'The page had no application form Tack could reach. It is tried again later; a closed posting drops out.' },
  'login-required': { label: 'Sign-in required', retry: false, help: 'The site wants you to sign in. Sign in there once, then retry.' },
  captcha: { label: 'CAPTCHA', retry: false, help: 'The site put up a check for a person. Tack never solves these: open the posting and finish it yourself.' },
  'answer-missing': { label: 'Answer needed', retry: false, help: 'The form asked something Tack has no answer for. Answer it once here and it is remembered.' },
  'consent-needed': { label: 'Consent needed', retry: false, help: 'Turn on "Tack may tick consent boxes and submit applications on my behalf" under Application details, then retry.' },
  timeout: { label: 'Timed out', retry: true, help: 'The run took too long. It is tried again later.' },
  'site-error': { label: 'Site error', retry: true, help: 'The site or the browser failed. It is tried again later.' },
};

export interface ApplyJob {
  id: string; postingId: string; company: string; title: string; url: string; key: string;
  state: JobState; source: 'autopilot' | 'manual'; autopilotRunId?: string;
  attempts: number; maxAttempts: number; nextAt: string; createdAt: string; updatedAt: string;
  reason?: FailureReason; detail?: string; question?: string; answer?: string;
  runIds: string[]; applicationId?: string; dryRun?: boolean; fit?: number; why?: string;
}

export interface RememberedAnswer { id: string; question: string; answer: string; at: string; company?: string }

const LIVE: JobState[] = ['queued', 'running', 'submitted', 'needs-you', 'awaiting-approval'];

/** Company and title folded, so "Acme, Inc." and "acme inc" are one employer's one role. */
export function jobKey(company: string, title: string): string {
  const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|ltd|limited|pvt|private|gmbh|co|corp|corporation)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${fold(company)}|${fold(title)}`;
}

/** What the failure was, from what the engine said. Order matters: a CAPTCHA on a sign-in page is a CAPTCHA. */
export function classifyFailure(message: string, status = 'failed'): FailureReason {
  const m = message.toLowerCase();
  if (/captcha|recaptcha|hcaptcha|turnstile|bot check|robot|verify (?:that )?you(?:'| a)re (?:a )?human|human verification|puzzle|a box to tick/.test(m)) return 'captcha';
  if (/sign[ -]?in|log[ -]?in|create an account|account (?:is )?required|register to apply|password/.test(m)) return 'login-required';
  if (/consent|privacy (?:notice|policy)|data processing|gdpr|agree to the|terms and conditions|submitting without asking is off|leave submit to the user|turned off submitting/.test(m)) return 'consent-needed';
  if (/timed? ?out|no reply within|step limit|ran out of steps|took too long/.test(m) || status === 'step_limit') return 'timeout';
  if (/no (?:application )?form|could not find (?:the |an )?(?:application|form|apply)|no longer (?:open|accepting|available)|(?:job|posting|position|role) (?:is |has been )?(?:closed|filled|removed)|page not found|\b404\b/.test(m)) return 'form-not-found';
  if (/required|could not answer|cannot answer|can't answer|what is your|please (?:provide|tell|share|confirm)|i need (?:your|the person)|only you can|asks? (?:for|what|whether)|\?\s*$/.test(m)) return 'answer-missing';
  return 'site-error';
}

/** Wait before try `attempt` + 1: five minutes, then fifteen, then forty-five, at most six hours. */
export function backoffMs(attempt: number, base = Number(process.env.TACK_APPLY_BACKOFF_MS) || 5 * 60_000): number {
  return Math.min(6 * 3_600_000, base * 3 ** Math.max(0, attempt - 1));
}

const iso = (t: Date | number) => new Date(t).toISOString();

export function allJobs(): ApplyJob[] {
  return store.list<ApplyJob>(JOB_KIND);
}

export function getJob(id: string): ApplyJob | undefined {
  return store.get<ApplyJob>(JOB_KIND, id);
}

function save(job: ApplyJob, now: Date): ApplyJob {
  job.updatedAt = iso(now);
  store.put(JOB_KIND, job.id, job);
  return job;
}

/** Why this posting must not be applied to again, or null when it may. */
export function duplicateOf(p: Pick<Posting, 'id' | 'url' | 'company' | 'title'>, apps: Application[] = store.list<Application>('application'), jobs: ApplyJob[] = allJobs()): string | null {
  const key = jobKey(p.company, p.title);
  const app = apps.find((a) => a.postingId === p.id || (!!p.url && a.url === p.url) || jobKey(a.company, a.title) === key);
  if (app) return `already applied to ${app.title} at ${app.company} on ${app.appliedAt.slice(0, 10)}`;
  const job = jobs.find((j) => !j.dryRun && LIVE.includes(j.state) && (j.postingId === p.id || j.key === key));
  if (job) return `${job.title} at ${job.company} is already ${job.state === 'submitted' ? 'submitted' : job.state === 'needs-you' ? 'waiting on you' : 'in the queue'}`;
  return null;
}

export interface EnqueueOpts {
  source: 'autopilot' | 'manual'; now?: Date; autopilotRunId?: string; state?: 'queued' | 'awaiting-approval'; dryRun?: boolean;
  maxAttempts?: number; why?: Map<string, string>;
}

/** Adds jobs for these postings; ones Tack applied to before, or already holds, are left out with why. */
export function enqueue(postings: Posting[], o: EnqueueOpts): { added: ApplyJob[]; skipped: { postingId: string; company: string; why: string }[] } {
  const now = o.now ?? new Date();
  const apps = store.list<Application>('application');
  const jobs = allJobs();
  const added: ApplyJob[] = [];
  const skipped: { postingId: string; company: string; why: string }[] = [];
  for (const p of postings) {
    if (!o.dryRun) {
      const dup = duplicateOf(p, apps, [...jobs, ...added]);
      if (dup) { skipped.push({ postingId: p.id, company: p.company, why: dup }); continue; }
    }
    const job: ApplyJob = {
      id: `job-${now.getTime().toString(36)}${randomUUID().slice(0, 6)}`, postingId: p.id, company: p.company, title: p.title, url: p.url,
      key: jobKey(p.company, p.title), state: o.state ?? 'queued', source: o.source, attempts: 0, maxAttempts: o.maxAttempts ?? 3,
      nextAt: iso(now), createdAt: iso(now), updatedAt: iso(now), runIds: [],
      ...(o.autopilotRunId ? { autopilotRunId: o.autopilotRunId } : {}), ...(o.dryRun ? { dryRun: true } : {}),
      ...(p.fit != null ? { fit: p.fit } : {}), ...(o.why?.get(p.id) ? { why: o.why.get(p.id) } : {}),
    };
    store.put(JOB_KIND, job.id, job);
    added.push(job);
  }
  return { added, skipped };
}

/** Jobs whose turn has come, oldest first. */
export function dueJobs(now = new Date(), limit = 8): ApplyJob[] {
  return allJobs().filter((j) => j.state === 'queued' && Date.parse(j.nextAt) <= now.getTime())
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt) || a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
}

export function markRunning(id: string, runId: string, now = new Date()): ApplyJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  job.state = 'running';
  job.attempts++;
  job.runIds.push(runId);
  return save(job, now);
}

export type Outcome =
  | { kind: 'submitted'; applicationId?: string; detail?: string }
  | { kind: 'dry-run'; detail: string }
  | { kind: 'failed'; reason: FailureReason; detail: string; question?: string };

/** Where a job goes after a run: done, tried again later, or waiting on the person. */
export function settle(id: string, out: Outcome, now = new Date()): ApplyJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  delete job.question;
  if (out.kind === 'submitted') {
    job.state = 'submitted';
    delete job.reason;
    job.detail = out.detail;
    if (out.applicationId) job.applicationId = out.applicationId;
  } else if (out.kind === 'dry-run') {
    job.state = 'dry-run';
    job.detail = out.detail;
  } else {
    job.reason = out.reason;
    job.detail = out.detail;
    if (out.question) job.question = out.question;
    const again = REASONS[out.reason].retry && job.attempts < job.maxAttempts;
    job.state = again ? 'queued' : REASONS[out.reason].retry ? 'failed' : 'needs-you';
    if (again) job.nextAt = iso(now.getTime() + backoffMs(job.attempts));
  }
  return save(job, now);
}

/** Jobs that were running when Tack stopped. Whether the form went is unknown, so the person decides. */
export function recoverInterrupted(now = new Date()): ApplyJob[] {
  const out: ApplyJob[] = [];
  for (const j of allJobs()) {
    if (j.state !== 'running') continue;
    j.state = j.dryRun ? 'failed' : 'needs-you';
    j.reason = 'site-error';
    j.detail = 'Tack stopped while this application was in progress, so it may or may not have gone. Check your mail or the company\'s site, then retry or dismiss it.';
    out.push(save(j, now));
  }
  return out;
}

export function needsYou(): ApplyJob[] {
  return allJobs().filter((j) => j.state === 'needs-you' || j.state === 'awaiting-approval').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export class QueueError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The person's answer to what stopped a form: kept for every later form, and the job goes again. */
export function answerJob(id: string, answer: string, now = new Date()): { job: ApplyJob; remembered: RememberedAnswer } {
  const job = getJob(id);
  if (!job) throw new QueueError(404, `no job ${id}`);
  const text = answer.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!text) throw new QueueError(400, 'the answer is empty');
  if (!job.question) throw new QueueError(409, 'this job is not waiting on a question');
  const remembered = remember(job.question, text, job.company, now);
  job.answer = text;
  job.state = 'queued';
  job.nextAt = iso(now);
  job.maxAttempts = Math.max(job.maxAttempts, job.attempts + 1);
  delete job.reason;
  return { job: save(job, now), remembered };
}

/** Back in the queue now: after a sign-in, a CAPTCHA done by hand, consent turned on, or a crash checked. */
export function retryJob(id: string, now = new Date()): ApplyJob {
  const job = getJob(id);
  if (!job) throw new QueueError(404, `no job ${id}`);
  if (!['needs-you', 'failed', 'awaiting-approval'].includes(job.state)) throw new QueueError(409, `this job is ${job.state}`);
  if (!job.dryRun) {
    const dup = duplicateOf(job, undefined, allJobs().filter((j) => j.id !== id));
    if (dup) throw new QueueError(409, `Not applying twice: ${dup}.`);
  }
  job.state = 'queued';
  job.nextAt = iso(now);
  job.maxAttempts = Math.max(job.maxAttempts, job.attempts + 1);
  return save(job, now);
}

export function skipJob(id: string, now = new Date()): ApplyJob {
  const job = getJob(id);
  if (!job) throw new QueueError(404, `no job ${id}`);
  if (job.state === 'running' || job.state === 'submitted') throw new QueueError(409, `this job is ${job.state}`);
  job.state = 'skipped';
  return save(job, now);
}

export function remember(question: string, answer: string, company?: string, now = new Date()): RememberedAnswer {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 300);
  const id = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || randomUUID();
  const r: RememberedAnswer = { id, question: q, answer: answer.slice(0, 2000), at: iso(now), ...(company ? { company } : {}) };
  store.put(ANSWER_KIND, id, r);
  return r;
}

export function rememberedAnswers(): RememberedAnswer[] {
  return store.list<RememberedAnswer>(ANSWER_KIND);
}

export function forget(id: string): void {
  store.del(ANSWER_KIND, id);
}

/** Applications the autopilot sent on this local day, plus the ones it is still working on. */
export function sentToday(now = new Date(), source: ApplyJob['source'] = 'autopilot'): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return allJobs().filter((j) => j.source === source && !j.dryRun && (j.state === 'submitted' || j.state === 'running' || j.state === 'queued')
    && Date.parse(j.createdAt) >= day.getTime()).length;
}

export function summary(now = new Date()): Record<JobState, number> & { today: number } {
  const out = { queued: 0, running: 0, submitted: 0, failed: 0, 'needs-you': 0, 'awaiting-approval': 0, 'dry-run': 0, skipped: 0, today: sentToday(now) };
  for (const j of allJobs()) out[j.state]++;
  return out;
}
