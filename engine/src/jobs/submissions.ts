/**
 * Sending applications the user approved in Review.
 *
 * Approving is the user's decision, made once. So an approved application is
 * submitted under a grant minted for that one application and that one use,
 * and the Submit click does not come back to them a second time. Several can
 * be approved together: they queue here and go out a few at a time, each on
 * its own tab.
 *
 * Where the form is still open and waiting on exactly that click, the click
 * is carried out there, on the answers the user saw. Where the form is still
 * open on its own page, the submit continues on it. Otherwise the form is
 * filled again from the approved answers.
 */
import { confirmationIn, performApproved, type ApprovalRequest } from '../agent/approvals.ts';
import { runTask, type AgentEvent, type RunResult } from '../agent/loop.ts';
import { keepFilled } from '../agent/record-actions.ts';
import { guardRun } from '../agent/run-guard.ts';
import type { App } from '../app.ts';
import type { BrowserRuntime, Tab } from '../observe/runtime.ts';
import { whenSaid } from '../policy/recipient.ts';
import { postingKey, type Answer, type Application, type ApplicationRow, type Job } from './jobs.ts';
import type { Profile } from './profile.ts';
import type { Questions } from './questions.ts';
import { folded } from './wording.ts';

const GRANT_MINUTES = 30;
/** Approved applications sent at the same time, each on its own tab. */
const AT_ONCE = 2;

/** Read by the agent that submits, and by the person on the card. */
export const COPY = {
  continueHere: 'The form is already open in this tab and filled as far as Fanfold could take it. Continue from where it stands; do not start it again.',
  /** On the card: approving the application never sends a form a second time. */
  notAgain: 'Not sent again: this form was already sent on {when}. To send it a second time, approve the card that says so on Review.',
  /** On the card: the run's own Submit went, and no confirmation was read after it. */
  sentNoConfirmation: 'Submitted after your approval. The page didn’t show a confirmation, so check it.',
  /** Why the earlier card is withdrawn when the submit fills the form again. */
  refilled: 'answers you gave on Review are put into the form first, so this card is replaced',
  /** Why a run's second press is withdrawn once its first went. */
  pressedTwice: 'the application had already been sent by the same run, so it was not sent again',
};

/**
 * Every answer the user gave for this job: on its card, and to the questions
 * it asked on Review. What they said on the card wins for the same question.
 */
export function userAnswersFor(deps: { questions: Questions; profile: Profile }, row: ApplicationRow): Answer[] {
  const keys = new Set([row.url, row.job.url, ...row.job.sourceUrls].map((u) => postingKey(u)).filter(Boolean));
  const askedHere = (q: { jobId: string | null; askedBy: Array<{ jobId?: string | null; url?: string | null }> }): boolean =>
    q.jobId === row.jobId || q.askedBy.some((a) => a.jobId === row.jobId || (!!a.url && keys.has(postingKey(a.url))));
  const said = deps.questions.list('answered', 2000).filter(askedHere).flatMap((q) => {
    const theirs = deps.profile.userAnswer(q.norm);
    return theirs ? [{ question: q.question, answer: theirs.answer, source: 'BANK' }] : [];
  });
  const card = new Set(row.answers.map((a) => folded(a.question)));
  return [...row.answers, ...said.filter((a) => !card.has(folded(a.question)))];
}

interface Pending {
  id: string;
  /** The user changed an answer in Review, so a form filled earlier is out of date. */
  edited: boolean;
}

export class Submissions {
  readonly #app: App;
  readonly #waiting: Pending[] = [];
  readonly #running = new Set<string>();

  constructor(app: App) {
    this.#app = app;
  }

  /** Queue an approved application. Returns at once; the outcome arrives as events. */
  enqueue(id: string, answers: Answer[], edited: boolean): { queued: true; ahead: number } {
    if (!this.#app.jobs.application(id)) throw new Error('no such application');
    if (this.#running.has(id) || this.#waiting.some((p) => p.id === id)) {
      return { queued: true, ahead: this.#waiting.findIndex((p) => p.id === id) + 1 };
    }
    this.#app.jobs.transition(id, 'queued', { answers });
    this.#waiting.push({ id, edited });
    this.#app.emit({ type: 'application_changed' });
    const ahead = this.#waiting.length - 1 + this.#running.size;
    this.#pump();
    return { queued: true, ahead };
  }

  status(): { running: string[]; waiting: string[] } {
    return { running: [...this.#running], waiting: this.#waiting.map((p) => p.id) };
  }

  /** Settles when nothing is queued or running. For tests. */
  async idle(): Promise<void> {
    while (this.#running.size || this.#waiting.length) await new Promise((r) => setTimeout(r, 5));
  }

  #pump(): void {
    while (this.#running.size < AT_ONCE && this.#waiting.length) {
      const next = this.#waiting.shift()!;
      this.#running.add(next.id);
      void this.#submit(next)
        .catch((err) => {
          this.#app.log.error('submission failed', { component: 'submissions', applicationId: next.id, err });
          this.#settle(next.id, 'needs_review', `Not submitted: ${(err as Error).message}`);
        })
        .finally(() => {
          this.#running.delete(next.id);
          this.#app.emit({ type: 'application_changed' });
          this.#pump();
        });
    }
  }

  async #submit(pending: Pending): Promise<void> {
    const row = this.#app.jobs.row(pending.id);
    if (!row) return;
    // What the user said for this job anywhere on Review goes into the form, not only what its card showed.
    const answers = userAnswersFor(this.#app, row);
    if (!pending.edited && await this.#finishWaitingForm(row, answers)) return;
    await this.#fillAndSubmit({ ...row, answers }, row.job);
  }

  /**
   * The earlier run stopped at Submit and its page is still open: press it
   * there, when the form as its card showed it already holds every answer the
   * user gave. A card that would send the form a second time is never
   * pressed from here: that is the user's to approve on the card itself.
   */
  async #finishWaitingForm(application: Application, answers: Answer[]): Promise<boolean> {
    const runId = application.runId;
    const kept = this.#app.applicationPage(application.id);
    const pending = this.#app.approvals.pending();
    const approval = (kept ? pending.find((a) => this.#app.pageForRun(a.runId) === kept) : undefined)
      ?? (runId && this.#app.parkedRuns().includes(runId) ? pending.find((a) => a.runId === runId) : undefined);
    const page = approval ? this.#app.pageForRun(approval.runId) : null;
    if (!approval || !page) return false;
    const sent = sentBefore(this.#app.approvals.forRun(approval.runId, 50), approval);
    if (sent) {
      this.#settle(application.id, 'needs_review', COPY.notAgain.replace('{when}', whenSaid(sent)));
      return true;
    }
    // An answer given on Review after the form stopped is not in it yet: the form is filled again, and this card gives way.
    if (missingFrom(approval, answers)) {
      this.#app.approvals.end(approval.id, COPY.refilled);
      return false;
    }

    this.#app.approvals.approve(approval.id, undefined, 'approved in Review');
    const outcome = await performApproved(this.#app.approvals, page, approval.id, {
      documents: this.#app.memory, memory: this.#app.memory, sites: this.#app.sites,
    });
    this.#app.emit({ type: 'approval_answered', id: approval.id, verdict: 'approve', outcome });
    // Pressed and turned away, or pressed with no telling whether it went:
    // filling the form again from the start could send it a second time.
    if (!outcome.performed && outcome.reason === 'refused_by_page') {
      this.#settle(application.id, 'needs_review', `Not submitted: ${outcome.detail}`);
      return true;
    }
    if (!outcome.performed && outcome.reason === 'unknown') {
      this.#settle(application.id, 'unconfirmed', `Pressed after your approval, but ${outcome.detail}`);
      return true;
    }
    if (!outcome.performed) return false;

    const confirmation = await confirmationOn(page);
    this.#settle(application.id, confirmation ? 'applied' : 'unconfirmed',
      confirmation ?? 'Submitted after your approval. The page didn’t show a confirmation, so check it.');
    return true;
  }

  async #fillAndSubmit(application: Application, job: Job): Promise<void> {
    const url = application.url ?? job.url ?? null;
    const caller = `review:${application.id}`;
    const grant = url ? this.#app.capabilities.grant({
      label: `Approved in Review: ${job.company} — ${job.title}`,
      workerId: caller, domains: [new URL(url).hostname], sensitivities: ['CONTACT_EXTERNAL'],
      maxUses: 1, expiresAt: new Date(Date.now() + GRANT_MINUTES * 60_000).toISOString(),
    }) : null;

    // The form filled earlier, still open where it stopped: the submit continues there.
    let tab: Tab | null = this.#app.takeApplicationPage(application.id);
    let result: RunResult;
    try {
      // A kept page the user closed meanwhile is gone: the form is opened again in a new tab.
      const kept = tab ? await tab.page.observe().then(() => true, () => false) : false;
      if (tab && !kept) {
        await tab.close().catch(() => {});
        tab = null;
      }
      if (!tab) {
        const browser = await this.#app.startBrowser();
        if (!browser.openTab) throw new Error('this browser cannot open more tabs');
        tab = await browser.openTab();
        if (url) await guardRun(tab.page, { sites: this.#app.sites, log: this.#app.log }).goto(url);
      }
      result = await runTask({
        ...(await this.#app.runContext()), delegate: undefined,
        goal: goalFor(application, job, url, kept),
        page: tab.page, policy: this.#app.policy(caller), recordAs: application.workerId,
        maxSteps: 30, taskType: 'job_application',
        approved: application.answers.map(({ question, answer }) => ({ question, answer })),
        onEvent: (event: AgentEvent) => {
          // What the run records about this job goes on this row, whatever it calls the job.
          if (event.type === 'run_started') this.#app.jobs.bindRun(event.runId, application.id);
          this.#app.emit({ type: 'submission_step', applicationId: application.id, event });
        },
      });
    } catch (err) {
      await tab?.close().catch(() => {});
      throw err;
    } finally {
      // One application, one use. Whatever is left of the grant goes with the run.
      if (grant) this.#app.capabilities.revoke(grant.id, 'the submission it was minted for has ended');
    }
    // What the run typed goes on the application, whether or not it recorded it.
    await keepFilled({ jobs: this.#app.jobs, profile: this.#app.profile, memory: this.#app.memory, answering: this.#answering() }, result.runId, application.id, url)
      .catch((err: unknown) => this.#app.log.warn('could not keep what a submission filled', { applicationId: application.id, err }));

    let after = this.#app.jobs.application(application.id);
    if (after?.status === 'queued') {
      // The agent may have recorded the outcome under a slightly different
      // name for the job. It is the same application: carry the outcome over.
      const twin = this.#app.jobs.list({ runId: result.runId, status: ['applied', 'unconfirmed', 'prepared'] })
        .find((r) => r.id !== application.id);
      if (twin) {
        this.#app.jobs.transition(twin.id, 'skipped', { skipReason: 'recorded again by the run that submitted it' });
        after = this.#app.jobs.transition(application.id, twin.status, { confirmation: twin.confirmation });
      }
    }
    // The run's own Submit went, then it asked to press the same control on the same page again: the
    // form was sent, and that is the outcome. The second press is withdrawn, so approving nothing can
    // send it twice. A press on a step after it (a confirm page) is a new step, and waits as it is.
    const pressed = this.#app.store.steps(result.runId)
      .filter((s) => s.sensitivity === 'CONTACT_EXTERNAL' && Number(s.allowed) === 1 && s.outcome === 'ok');
    const again = this.#app.approvals.pending()
      .filter((p) => p.runId === result.runId && pressed.some((s) => s.url === p.url && (s.target_name ?? null) === p.targetName));
    if ((after?.status === 'queued' || after?.status === 'needs_review') && again.length) {
      for (const p of again) this.#app.approvals.end(p.id, COPY.pressedTwice);
      const confirmation = await confirmationOn(tab.page);
      this.#settle(application.id, confirmation ? 'applied' : 'unconfirmed', confirmation ?? COPY.sentNoConfirmation);
      if (this.#app.applicationWaits(application.id)) this.#app.parkRun(result.runId, tab, application.id);
      else await tab.close().catch(() => {});
      return;
    }
    if (result.status === 'awaiting_approval') {
      if (after?.status === 'queued') this.#settle(application.id, 'needs_review', `Waiting for you: ${result.message}`);
      this.#app.parkRun(result.runId, tab, application.id);
      return;
    }
    if (after?.status === 'queued') {
      // The agent finished without saying what happened. That is not "applied".
      if (result.status === 'done') {
        this.#settle(application.id, 'unconfirmed', `The run ended without recording an outcome: ${result.message}`);
      } else {
        this.#settle(application.id, 'needs_review', `Not submitted: ${result.message}`);
      }
    }
    // Back in Review, or sent with no confirmation seen: the form stays open for the user. Sent, or anything else: it closes.
    if (this.#app.applicationWaits(application.id)) this.#app.parkRun(result.runId, tab, application.id);
    else await tab.close().catch(() => {});
  }

  #answering(): { questions: Questions; intents: App['intents']; careers: App['careers']; model: App['answerModel'] } {
    return { questions: this.#app.questions, intents: this.#app.intents, careers: this.#app.careers, model: this.#app.answerModel };
  }

  #settle(id: string, status: 'applied' | 'unconfirmed' | 'needs_review', note: string): void {
    try {
      this.#app.jobs.transition(id, status, { confirmation: note });
    } catch (err) {
      this.#app.log.warn('could not record the outcome of a submission', { applicationId: id, err });
    }
  }
}

function goalFor(application: Application, job: Job, url: string | null, kept = false): string {
  return [
    `Submit the application to ${job.company} — ${job.title}${url ? ` at ${url}` : ''}.`,
    ...(kept ? [COPY.continueHere] : []),
    `Record its outcome under exactly this company ("${job.company}") and title ("${job.title}")${job.location ? `, location "${job.location}"` : ''}${job.url ? `, url ${job.url}` : ''}.`,
    'The user reviewed and approved these answers; use them exactly as written:',
    ...application.answers.map((a) => `- ${a.question}: ${a.answer}`),
    'When the form is submitted and a confirmation is visible, record the application as applied. '
    + 'If the page is lost before a confirmation, record it as unconfirmed and stop.',
  ].join('\n');
}

/**
 * When this card would send its form a second time, when the first went: it
 * was raised knowing of an earlier contact, or the same run already sent the
 * same control on the same page.
 */
export function sentBefore(runApprovals: ApprovalRequest[], card: ApprovalRequest): string | null {
  const first = runApprovals.find((a) => a.id !== card.id && a.status === 'consumed' && (a.outcome === 'sent' || a.outcome === 'unknown')
    && a.url === card.url && a.actionKind === card.actionKind && a.targetName === card.targetName);
  if (first) return first.answeredAt ?? first.requestedAt;
  // The contact mark is "<when first>+<how many since>".
  return card.priorContactAt ? card.priorContactAt.replace(/\+\d+$/, '') : null;
}

/** An answer the user gave that the card's form shows blank or otherwise: the form must take it before it is sent. */
function missingFrom(card: ApprovalRequest, answers: Answer[]): boolean {
  const form = card.form ?? [];
  return answers.some((a) => {
    const field = form.find((f) => folded(f.label) === folded(a.question));
    return !!field && folded(field.value) !== folded(a.answer);
  });
}

/** What the page says once an application has gone through, if it says anything. */
async function confirmationOn(page: BrowserRuntime): Promise<string | null> {
  // An unreadable page is an unconfirmed submission, which is what null means.
  return page.observe().then(confirmationIn, () => null);
}
