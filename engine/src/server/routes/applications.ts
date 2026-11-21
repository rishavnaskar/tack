/**
 * Review's two buttons on an application: approve it to be sent, and "Fill
 * it now", which fills the form on its own tab and, unless the owner's
 * standing yes covers it, stops before anything is sent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import type { RouteContext } from './context.ts';
import { applicationsView, questionGroups, queuedStates, saveEditedAnswers } from './jobs.ts';
import type { ApprovalRequest } from '../../agent/approvals.ts';
import { runTask, type AgentEvent, type RunResult } from '../../agent/loop.ts';
import type { AgentAction } from '../../agent/prompt.ts';
import { keepFilled } from '../../agent/record-actions.ts';
import { guardRun } from '../../agent/run-guard.ts';
import { CLAIM_LAPSES_MS, postingKey, type Answer, type Application, type ApplicationRow, type Job } from '../../jobs/jobs.ts';
import { isPlaceholderJob, jobFromPageData } from '../../jobs/page-title.ts';
import { clean } from '../../jobs/questions.ts';
import { SETTING as SUBMIT_WITHOUT_ASKING } from '../../jobs/standing-approval.ts';
import { sentBefore } from '../../jobs/submissions.ts';
import type { Tab } from '../../observe/runtime.ts';
import { pressActivates, type PolicyContext } from '../../policy/engine.ts';
import { unwrapUntrustedForDisplay } from '../../policy/untrusted.ts';
import { Store } from '../../store/db.ts';
import type { Observation, ObservedNode, Untrusted } from '../../types.ts';

/** What the person reads. */
const COPY = {
  noAddress: 'This job has no link to open.',
  alreadyFilling: 'Fanfold is already filling this one out.',
  cannotFill: 'This one is {status}, so there is nothing to fill out.',
  fillStopsSend: 'Fill it now stops before anything is sent, so {doing} waits for you. Approve it to send it now.',
  fillStops: 'Fill it now stops before {doing}, so it waits for you. Approve it to let Fanfold do it now.',
  thatStep: 'that step',
  /** Why "Approve all" leaves a card out. */
  heldStatus: 'It isn’t waiting for your approval.',
  heldFilling: 'Fanfold is still filling it in.',
  heldEmpty: 'Nothing is filled in yet.',
  heldDrafts: 'Some answers are Fanfold’s suggestions, for you to check first.',
  heldQuestion: 'A question is holding it up.',
  heldQuestions: '{n} questions are holding it up.',
  heldSentOnce: 'Its form was sent once already. Sending it again needs your approval on its own card.',
  refilled: 'the form is being filled again, so nothing was done',
  withdrawnSkipped: 'you skipped this job, so nothing was done',
  withdrawnFailed: 'you marked this job as not sent, so nothing was done',
  withdrawnRemoved: 'you removed this job from your list, so nothing was done',
  /** Removing an application. */
  removeGone: 'This application is no longer in your list.',
  removeBusy: 'Fanfold is {doing} this application right now. Stop it or wait for it to finish, then remove it.',
  doingFill: 'filling in',
  doingSend: 'sending',
  doingWork: 'working on',
  removeSent: 'This application was sent. Removing it deletes Fanfold’s record of it, so Fanfold won’t know you applied and might suggest or fill it again. The employer still has your application.',
  /** Kept in the effects journal, never shown: a sent application's record was removed by its owner. */
  removedTrail: 'removed from Fanfold’s list by its owner; the application itself stays with the employer',
};

const SUBMIT = /^\/api\/applications\/([\w-]+)\/submit$/;
const FILL = /^\/api\/applications\/([\w-]+)\/fill$/;
const ONE = /^\/api\/applications\/([\w-]+)$/;

/** Statuses that mean the form went to the employer. */
const SENT = new Set(['applying', 'applied', 'unconfirmed']);

/** A button whose press sends its form, by what it says. */
const SENDS = /\b(submit|send|apply|finish|complete)\b/i;

/**
 * The policy a "Fill it now" run is judged by: anything that reaches another
 * person or cannot be undone waits for the owner, whatever their standing yes
 * to applications, a grant or the approval gate would let through. The hold
 * is asked before the gate and before any grant, so neither skips it.
 */
export function fillPolicy(base: PolicyContext): PolicyContext {
  return { ...base, review: (action, observation) => base.review?.(action, observation) ?? { refuse: false, why: fillStops(action, observation) } };
}

/** Why "Fill it now" stopped, naming what it stopped before, so the card says what approving it does. */
function fillStops(action: AgentAction, observation: Observation): string {
  const node = action.ref ? observation.nodes.find((n) => n.ref === action.ref!.replace(/^@/, '')) : undefined;
  const sends = (action.kind === 'click' && (!!node?.evidence?.isSubmit || SENDS.test(said(node?.name))))
    || (action.kind === 'press' && pressActivates(action.key));
  return (sends ? COPY.fillStopsSend : COPY.fillStops).replace('{doing}', doingWords(action, node));
}

/** Page text as a person reads it on a card. */
function said(v: Untrusted | string | null | undefined): string {
  return v ? clean(unwrapUntrustedForDisplay(v as Untrusted)).slice(0, 120) : '';
}

/** The action in words, with the control's own label and, for a choice, the question it answers. */
function doingWords(action: AgentAction, node: ObservedNode | undefined): string {
  const name = said(node?.name);
  const q = (s: string): string => `“${s}”`;
  switch (action.kind) {
    case 'click': return name ? `pressing ${q(name)}` : 'pressing that button';
    case 'press': return 'pressing Enter in the form';
    case 'select': return action.value && name ? `choosing ${q(said(action.value))} for ${q(name)}` : COPY.thatStep;
    case 'check':
    case 'uncheck': {
      const group = said(node?.evidence?.group);
      if (node?.role === 'radio' && name) return group ? `choosing ${q(name)} for ${q(group)}` : `choosing ${q(name)}`;
      return name ? `${action.kind === 'check' ? 'ticking' : 'unticking'} ${q(name)}` : COPY.thatStep;
    }
    case 'fill':
    case 'type': return name ? `typing into ${q(name)}` : COPY.thatStep;
    case 'upload': return name ? `attaching a file to ${q(name)}` : 'attaching a file';
    default: return COPY.thatStep;
  }
}

/**
 * How a fill ended, for the card that started it: what it filled, the
 * questions it left for the owner, a step waiting for their approval, the
 * form sent, or nothing it could do.
 */
type FillOutcome = 'filled' | 'asked' | 'approval' | 'sent' | 'nothing';

/** A fill started from Review or Applications, and how it ended. */
interface Fill { state: 'filling' | 'done' | 'failed'; note: string | null; at: string; outcome?: FillOutcome }

/** Statuses a fill's note still speaks for: once the job is sent or set aside, the row's status says it. */
const FILL_SHOWN = new Set(['found', 'needs_review', 'queued']);

/**
 * What the agent is asked to do when the owner presses "Fill it now". Read by
 * the model, not the owner. With `send`, the owner's standing yes to their
 * applications is on, and a form with nothing required left blank is sent.
 */
export function fillGoal(job: Job, url: string, send = false): string {
  const named = `under exactly this company ("${job.company}") and title ("${job.title}"), url ${url}`;
  return [
    `Fill in the job application for ${job.company} — ${job.title} at ${url}.`,
    'Fill every field your profile and saved answers cover. Pass each question you cannot answer from them to answer_questions, '
    + 'which files it on the user\'s Review page; never guess, and never stop with ask_user to ask the form\'s questions.',
    ...(send ? [
      // The prompt's "ask before something reaches a person" would otherwise win: the owner has already answered it for their applications.
      'The user turned on "Submit applications without asking me": they want this application sent. When every field the form requires is filled, '
      + 'press the final Submit yourself. Do not stop with ask_user to confirm the Submit or to have the user review the form first: '
      + 'Fanfold checks the press itself and holds it for the user when it has to.',
      'A question left for the user that the form does not require does not stop the Submit.',
      `When a confirmation is visible, record the application ${named}, as applied; if the page is lost before one shows, record it as unconfirmed.`,
      `If a field the form requires could not be answered, do not press Submit: record the application ${named}, `
      + 'as needs_review, with every answer you filled and where it came from, and finish with done.',
    ] : [
      'Do not press the final Submit or Send: the user reviews the answers first.',
      `When the form is filled as far as you can take it, record the application ${named}, `
      + 'as needs_review, with every answer you filled and where it came from, and finish with done, not ask_user.',
    ]),
  ].join('\n');
}

/**
 * Whether a run's last words ask the user for something the form needs.
 * "Ready to submit" is not a question, and a bot check or a sign-in is the
 * page asking for them, which Review cannot answer.
 */
export function asksTheUser(message: string): boolean {
  const m = message.trim();
  if (!m || /\b(captcha|bot check|robot|verify (?:that )?you(?:'| a)re human|sign[- ]?in|log[- ]?in|password)\b/i.test(m)) return false;
  if (/\b(ready|about) to (?:be )?submit|\b(?:review|check) (?:it |the form |the application )?(?:and|then|before) (?:you )?submit|\bconfirm (?:if|whether|that) (?:i|fanfold) (?:should|may|can)\b|\bshould i (?:proceed|submit|go ahead)\b/i.test(m)) return false;
  return /\?\s*$/.test(m) || /\b(please (?:provide|give|tell|share|enter|send|confirm your)|what is your|which (?:of|one)|i need your|your [a-z ]{2,30} (?:is|are) (?:needed|required|missing))\b/i.test(m);
}

export class ApplicationActions {
  readonly #ctx: RouteContext;
  /** "Fill it now", by application id, kept so the card that started one can say how it went. */
  readonly #fills = new Map<string, Fill>();

  constructor(ctx: RouteContext) {
    this.#ctx = ctx;
    // A job set aside takes what waited on it along: an approval for its form can no longer be given.
    ctx.app.jobs.onChange((a) => { if (a.status === 'skipped' || a.status === 'failed') this.#withdraw(a); });
  }

  /** End every approval still waiting for this application's form. */
  #withdraw(a: Application): void {
    const { app } = this.#ctx;
    const row = app.jobs.row(a.id);
    if (!row) return;
    const ended = this.#waitingOn(row)
      .filter((p) => app.approvals.end(p.id, a.status === 'skipped' ? COPY.withdrawnSkipped : COPY.withdrawnFailed));
    if (ended.length) this.#ctx.emit({ type: 'application_changed' });
  }

  /** Approvals still waiting for this application's form: its run's, its kept page's, or one on its posting. */
  #waitingOn(row: ApplicationRow, onPosting = true): ApprovalRequest[] {
    const { app } = this.#ctx;
    const keys = new Set([row.url, row.job.url, ...row.job.sourceUrls].map((u) => postingKey(u)).filter(Boolean));
    const kept = app.applicationPage(row.id);
    return app.approvals.pending()
      .filter((p) => (!!row.runId && p.runId === row.runId) || (!!kept && app.pageForRun(p.runId) === kept) || (onPosting && keys.has(postingKey(p.url))));
  }

  /** Answer one of these routes. False means "not mine". */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/api/applications' && req.method === 'GET') {
      // Each row says why "Approve all" leaves it out, when it does.
      const view = applicationsView(this.#ctx, url);
      const held = this.#holds();
      sendJson(res, { ...view, applications: view.applications.map((a) => ({ ...a, held: held(a) })) });
      return true;
    }
    const submit = url.pathname.match(SUBMIT);
    if (submit && req.method === 'POST') {
      await this.#submit(req, res, submit[1]);
      return true;
    }
    const fill = url.pathname.match(FILL);
    if (fill && req.method === 'POST') {
      this.#fillNow(res, fill[1]);
      return true;
    }
    // The owner's alone: no MCP tool reaches it, and an agent's key reaches nothing but /mcp.
    const one = url.pathname.match(ONE);
    if (one && req.method === 'DELETE') {
      await this.#remove(req, res, one[1]);
      return true;
    }
    return false;
  }

  /** What Fanfold is doing to this application right now, in words, or null when nothing is at it. */
  #busy(row: ApplicationRow): string | null {
    const { app } = this.#ctx;
    if (this.#fills.get(row.id)?.state === 'filling') return COPY.doingFill;
    const queue = app.submissions.status();
    if (queue.running.includes(row.id) || queue.waiting.includes(row.id)) return COPY.doingSend;
    // A run still at it: sending it, or one that claimed it and has moved on it within the claim lapse, not waiting on the owner.
    if (!row.runId || app.store.getRun(row.runId)?.status !== 'running') return null;
    if (row.status === 'applying') return COPY.doingSend;
    const waits = app.approvals.pending().some((p) => p.runId === row.runId);
    return row.status === 'queued' && !waits && Date.now() - Date.parse(row.updatedAt) <= CLAIM_LAPSES_MS ? COPY.doingWork : null;
  }

  /**
   * Remove an application from the list, in one transaction: its row (and
   * older skips of the same job the list shows as it), the answers on its
   * card, questions only its job asked, its waiting approvals (withdrawn),
   * and, for one that was sent, Fanfold's record of that, which needs
   * `sent: true` and is written to the effects journal. The page kept for it
   * closes. Saved answers and profile facts are not touched.
   */
  async #remove(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const { app } = this.#ctx;
    const row = app.jobs.row(id);
    if (!row) return sendJson(res, { error: COPY.removeGone }, 404);
    const body = await readBody(req, Bodies.RemoveApplication);
    const doing = this.#busy(row);
    if (doing) return sendJson(res, { error: COPY.removeBusy.replace('{doing}', doing) }, 409);
    const sent = SENT.has(row.status);
    // `field: sent` is how the page knows to ask the second time, in the same dialog.
    if (sent && body.sent !== true) return sendJson(res, { error: COPY.removeSent, field: 'sent' }, 409);
    let questions: number[] = [];
    const removed = app.jobs.remove(id, (rows, jobRemoved) => {
      const ids = new Set(rows.map((r) => r.id));
      // On its posting only once the job itself goes: another row of the same job may still be waiting on it.
      const waiting = new Map(rows.flatMap((r) => this.#waitingOn(r, jobRemoved)).map((p) => [p.id, p]));
      for (const p of waiting.values()) app.approvals.end(p.id, COPY.withdrawnRemoved);
      if (jobRemoved) questions = app.questions.forgetJob({ jobId: row.jobId, urls: [row.url, row.job.url, ...row.job.sourceUrls] });
      // What Fanfold worked out from this record ("you applied there before") rests on nothing now.
      for (const d of app.profile.derivedAnswers(-1)) {
        if (d.basis.from === 'ledger' && typeof d.basis.applicationId === 'string' && ids.has(d.basis.applicationId)) app.profile.forgetDerived(d.id);
      }
      if (sent) {
        // The journal keeps that a sent application's record was removed; nothing in it is ever deleted.
        const effect = {
          runId: row.runId ?? 'owner', stepIdx: -1, kind: 'application_removed', target: row.url ?? row.job.url ?? row.jobId,
          content: JSON.stringify({ applicationId: row.id, jobId: row.jobId, company: row.job.company, title: row.job.title, status: row.status, submittedAt: row.submittedAt, confirmation: row.confirmation, removedAt: new Date().toISOString() }),
        };
        const key = Store.idempotencyKey(effect);
        app.store.intendEffect(key, effect);
        app.store.settleEffect(key, 'committed', COPY.removedTrail);
      }
    });
    if (!removed) return sendJson(res, { error: COPY.removeGone }, 404);
    for (const r of removed.rows) {
      this.#fills.delete(r.id);
      await app.takeApplicationPage(r.id)?.close().catch(() => {});
    }
    // Pages kept for the approvals just withdrawn go too, once nothing else waits on them.
    app.settleKeeps();
    this.#ctx.emit({ type: 'application_changed' });
    if (questions.length) this.#ctx.emit({ type: 'question_closed', ids: questions });
    sendJson(res, { removed: removed.rows.map((r) => r.id), questions: questions.length, record: sent });
  }

  /** How each "Fill it now" went, for the page's state, while its job still waits on it. */
  fills(): Record<string, Fill> {
    const shown: Record<string, Fill> = {};
    for (const [id, f] of this.#fills) {
      const status = this.#ctx.app.jobs.application(id)?.status;
      if (f.state === 'filling' || (status && FILL_SHOWN.has(status))) shown[id] = f;
    }
    return shown;
  }

  /**
   * Why "Approve all" leaves an application out, or null when nothing holds
   * it: every answer is the owner's own, no question of its job is open, no
   * fill is running on it, and approving it could not send its form twice.
   */
  #holds(): (row: ApplicationRow) => string | null {
    const { app } = this.#ctx;
    const { places } = questionGroups(this.#ctx, app.questions.list('open', 500));
    const open = new Map<string, number>();
    for (const place of places.values()) {
      for (const j of place.jobs) if (j.applicationId) open.set(j.applicationId, (open.get(j.applicationId) ?? 0) + 1);
    }
    const pending = app.approvals.pending();
    return (row) => {
      if (row.status !== 'needs_review') return COPY.heldStatus;
      if (this.#fills.get(row.id)?.state === 'filling') return COPY.heldFilling;
      const n = open.get(row.id) ?? 0;
      if (n) return n === 1 ? COPY.heldQuestion : COPY.heldQuestions.replace('{n}', String(n));
      if (!row.answers.length) return COPY.heldEmpty;
      if (row.answers.some((a) => a.source !== 'PROFILE' && a.source !== 'BANK')) return COPY.heldDrafts;
      const kept = app.applicationPage(row.id);
      const waiting = pending.filter((p) => p.runId === row.runId || (!!kept && app.pageForRun(p.runId) === kept));
      if (waiting.some((p) => sentBefore(app.approvals.forRun(p.runId, 50), p))) return COPY.heldSentOnce;
      return null;
    };
  }

  /**
   * Approve an application from Review. It joins the queue and this answers
   * at once, so approving ten in a row does not wait on the first. With
   * `all` ("Approve all"), one that something holds is refused, with why.
   */
  async #submit(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const app = this.#ctx.app;
    const row = app.jobs.row(id);
    if (!row) return sendJson(res, { error: 'no such application' }, 404);
    const body = await readBody(req, Bodies.SubmitApplication);
    if (body.all) {
      const held = this.#holds()(row);
      if (held) return sendJson(res, { error: held }, 409);
    }
    const answers: Answer[] = body.answers
      ? body.answers.map((a) => ({ question: a.question, answer: a.answer, source: a.source ?? 'DRAFT' }))
      : row.answers;
    const edited = answers.length !== row.answers.length
      || answers.some((a, i) => a.answer !== row.answers[i]?.answer);
    if (body.saveToBank) saveEditedAnswers(this.#ctx, row, answers);
    sendJson(res, app.submissions.enqueue(id, answers, edited), 202);
  }

  /**
   * "Fill it now": the form is filled on its own tab and stops before
   * Submit, so a row with nothing filled becomes one with answers to review.
   * On the owner's standing yes it is sent instead, when the yes covers it.
   * Answers at once; how it went arrives as events and stays in the state.
   */
  #fillNow(res: ServerResponse, id: string): void {
    const { app, log } = this.#ctx;
    const row = app.jobs.application(id);
    if (!row) return sendJson(res, { error: 'no such application' }, 404);
    const job = app.jobs.job(row.jobId);
    const target = row.url ?? job?.url ?? null;
    if (!job || !target) return sendJson(res, { error: COPY.noAddress }, 409);
    if (this.#fills.get(id)?.state === 'filling') return sendJson(res, { error: COPY.alreadyFilling }, 409);
    // A queued job started and left (nobody at it past the claim lapse) is resumed here, as "Resume" on Review asks.
    const left = row.status === 'queued' && queuedStates(this.#ctx)({ ...row, job }) === 'started';
    if (!['found', 'skipped', 'failed', 'needs_review'].includes(row.status) && !left) {
      return sendJson(res, { error: COPY.cannotFill.replace('{status}', row.status.replace('_', ' ')) }, 409);
    }
    // It waits in Review while it is filled, which is where its answers will be.
    if (row.status !== 'needs_review') {
      try {
        app.jobs.transition(id, 'needs_review');
      } catch (err) {
        return sendJson(res, { error: (err as Error).message }, 409);
      }
    }
    this.#fills.set(id, { state: 'filling', note: null, at: new Date().toISOString() });
    this.#ctx.emit({ type: 'application_changed' });
    sendJson(res, { started: true }, 202);

    void this.#fill(id, row.workerId, job, target)
      .catch((err: unknown) => ({ ok: false, message: (err as Error).message, outcome: undefined }))
      .then((r) => {
        this.#fills.set(id, { state: r.ok ? 'done' : 'failed', note: r.message, at: new Date().toISOString(), ...(r.outcome ? { outcome: r.outcome } : {}) });
        if (!r.ok) log.warn('could not fill an application', { applicationId: id, reason: r.message });
        this.#ctx.emit({ type: 'fill_finished', applicationId: id, ok: r.ok, message: r.message, outcome: r.outcome ?? null });
        this.#ctx.emit({ type: 'application_changed' });
      });
  }

  async #fill(id: string, workerId: string | null, job: Job, target: string): Promise<{ ok: boolean; message: string; outcome?: FillOutcome }> {
    const app = this.#ctx.app;
    // Filled again: what waited on the last fill's form goes with it, as that page gives way to the new one.
    const was = app.jobs.application(id)?.runId ?? null;
    const kept = app.applicationPage(id);
    for (const p of app.approvals.pending()) {
      if ((!!was && p.runId === was) || (!!kept && app.pageForRun(p.runId) === kept)) app.approvals.end(p.id, COPY.refilled);
    }
    let tab: Tab | null = null;
    try {
      tab = await app.openTab();
      await guardRun(tab.page, { sites: app.sites, log: app.log }).goto(target);
      // A job added by its address is known by a stand-in name until its page names it: by its own job data, else its heading and site.
      let named = job;
      const host = (() => { try { return new URL(target).hostname.replace(/^www\./, ''); } catch { return ''; } })();
      if (isPlaceholderJob(job, host, target)) {
        const read = jobFromPageData(await tab.page.jobPosting?.().catch(() => null) ?? null, target);
        if (read) {
          app.jobs.retitle(job.canonicalId, read);
          named = { ...job, ...read };
          this.#ctx.emit({ type: 'application_changed' });
        }
      }
      const send = app.store.setting(SUBMIT_WITHOUT_ASKING, false);
      const context = await app.runContext();
      const result = await runTask({
        ...context, delegate: undefined,
        goal: fillGoal(named, target, send),
        page: tab.page, policy: send ? app.policy() : fillPolicy(app.policy()), recordAs: workerId,
        maxSteps: 30, taskType: 'job_application',
        onEvent: (event: AgentEvent) => {
          // What the run records about this job goes on this row, whatever it calls the job.
          if (event.type === 'run_started') app.jobs.bindRun(event.runId, id);
          this.#ctx.emit({ type: 'submission_step', applicationId: id, event });
        },
      });
      const outcome = await this.#settleFill(id, named, target, result, context.answering);
      // Stopped at something that needs the owner, or filled and waiting in Review: the page stays open, on the form, for it.
      if (result.status === 'awaiting_approval' || app.applicationWaits(id)) {
        app.parkRun(result.runId, tab, id);
        tab = null;
      }
      return { ok: result.status === 'done' || result.status === 'awaiting_approval', message: result.message, outcome };
    } finally {
      await tab?.close().catch(() => {});
    }
  }

  /**
   * What a fill leaves behind, whether or not the run recorded it: what it
   * filled goes on the card, and a question it stopped to ask goes on Review
   * with the job's other questions.
   */
  async #settleFill(id: string, job: Job, target: string, result: RunResult, answering: Parameters<typeof keepFilled>[0]['answering']): Promise<FillOutcome> {
    const app = this.#ctx.app;
    await keepFilled({ jobs: app.jobs, profile: app.profile, memory: app.memory, answering }, result.runId, id, target)
      .catch((err: unknown) => this.#ctx.log.warn('could not keep what a fill filled', { applicationId: id, err }));
    let asked = false;
    const message = result.pendingAction?.kind === 'ask_user' ? result.pendingAction.message ?? result.message : '';
    if (result.status === 'awaiting_approval' && message && asksTheUser(message)) {
      try {
        app.questions.ask({ question: message, kind: 'text' }, { company: job.company, title: job.title, url: target, jobId: job.canonicalId });
        this.#ctx.emit({ type: 'question_asked', ids: [] });
        asked = true;
      } catch (err) {
        this.#ctx.log.warn('could not file a question a fill asked', { applicationId: id, err });
      }
    }
    const row = app.jobs.row(id);
    if (row && ['applied', 'unconfirmed'].includes(row.status)) return 'sent';
    if (result.status === 'awaiting_approval' && app.approvals.pending().some((p) => p.runId === result.runId)) return 'approval';
    if (asked) return 'asked';
    if (row?.answers.length) return 'filled';
    const open = row ? questionGroups(this.#ctx, app.questions.list('open', 500)).groups.some((g) => g.job?.applicationId === id) : false;
    return open ? 'asked' : 'nothing';
  }
}
