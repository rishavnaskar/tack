/**
 * What happens when an action needs a person.
 *
 * The model that asked for the action is never the one that approves it.
 * Either the host shows its own user a dialog on Fanfold's behalf, or the
 * request waits in Fanfold's review queue. There is no tool that approves.
 */
import { changedAfterApproval, performApproved, type ApprovalRequest } from '../agent/approvals.ts';
import type { Governed } from '../agent/governed.ts';
import type { AgentAction } from '../agent/prompt.ts';
import { describeAction, hostOf } from '../agent/actions.ts';
import type { CallContext } from './protocol.ts';
import type { Session } from './sessions.ts';
import { reviewPlace, snapshot, type FanfoldContext, type SnapshotOptions } from './context.ts';
import { fence } from '../policy/untrusted.ts';
import { followCodeAsk } from './code-ask.ts';
import { openDialog, waitForReply, type Reply } from './dialog.ts';
import {
  byStanding, carryOutCounted, finishesSubmit, heldNote, pressedOnStanding, secondApplicationNote, sentBefore, standingNote, standingRefusalNow,
} from '../jobs/standing-approval.ts';

/** What the agent reads about who let a press go. */
export const COPY = {
  userApproved: 'The user approved it',
  standing: 'The user\'s setting to submit applications without asking covered it',
};

type NeedsApproval = Extract<Governed, { status: 'needs_approval' }>;

/** At most this many answers in the host's dialog; the rest are on the card in Review. */
const DIALOG_ANSWERS = 12;
/** How long a result waits for a press the user approved in Review to be carried out there. */
const PRESS_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Carry out an approved request on the page it was asked on, and only there: none when that window is closed. */
function carryOutOnItsPage(ctx: FanfoldContext, id: string, application: string | null): ReturnType<typeof performApproved> {
  const { approvals, memory, jobs, sites, store } = ctx.app;
  const runId = approvals.get(id)?.runId;
  return carryOutCounted(approvals, runId ? ctx.app.pageForRun(runId) : null, id, { documents: memory, memory, sites, jobs, application, store });
}

async function seekApproval(
  ctx: FanfoldContext, session: Session, call: CallContext, pending: NeedsApproval,
): Promise<string> {
  const { approvals, store, jobs } = ctx.app;
  let request = approvals.get(pending.approvalId);
  // A press during the code the site emailed belongs to the application that code is for, wherever the page has moved.
  const codeAsk = followCodeAsk(ctx.app, session, session.observation);
  const application = request && codeAsk?.host === hostOf(request.url) ? codeAsk.applicationId : null;
  const carryOut = async (): Promise<string> => {
    const outcome = await carryOutOnItsPage(ctx, pending.approvalId, application);
    store.setRunStatus(session.runId, 'running');
    const done = approvals.get(pending.approvalId);
    ctx.emit({ type: 'approval_answered', id: pending.approvalId, verdict: 'approve', outcome });
    return withPage(ctx, session, done);
  };

  // The site took the application, emailed a code, and the code is in: this
  // Submit sends the application that was already let go, so it goes on that.
  const finished = request?.status === 'pending' ? finishesSubmit(request, approvals.forRun(session.runId), { codeAsk }) : null;
  if (finished && approvals.approve(pending.approvalId, undefined, `finishes the application approved as ${finished.id}, with the code the site emailed`)) {
    approvals.attribute(pending.approvalId, call.client.name);
    return 'This Submit finishes the same application, which already went out with the user\'s permission: the site wanted the code it emailed, '
      + `so it was sent on that permission without asking again.\n${await carryOut()}`;
  }

  let why = pending.why.replace(/\s*Needs your approval\.?$/i, '');
  // A job the ledger has as sent already is a second application: the card says so, and nothing sends it unasked.
  const sent = request?.status === 'pending' ? sentBefore(jobs, request) : null;
  if (sent && request && !request.why.includes(secondApplicationNote(sent))) {
    why = `${why.replace(/[.\s]+$/, '')}. ${secondApplicationNote(sent)}`;
    approvals.amend(pending.approvalId, why);
    request = approvals.get(pending.approvalId);
  }
  const what = whatWaits(request);
  // The person already approved this application, the page turned the
  // press away and the answers are as they were: it goes again on that approval.
  if (request?.status === 'approved' && request.outcome === 'refused') return carryOut();
  approvals.attribute(pending.approvalId, call.client.name);

  // The person set Fanfold to send their applications without asking: not past a check on the page, which is theirs.
  const refusal = await standingFor(ctx, session, request ?? null);
  if (!refusal && approvals.approve(pending.approvalId, undefined, standingNote(request ?? null))) {
    const page = await carryOut();
    return `${pressedOnStanding(approvals.get(pending.approvalId))}\n${page}`;
  }
  // It was on and did not cover this one: the card and the agent say why, in one sentence.
  const held = heldNote(refusal);
  if (held && request && !request.why.includes(held)) {
    why = `${why.replace(/[.\s]+$/, '')}. ${held}`;
    approvals.amend(pending.approvalId, why);
    request = approvals.get(pending.approvalId);
  }

  let stillOpen = false;
  if (ctx.approvalsVia === 'host' && call.client.elicitation && call.peer.request) {
    const id = pending.approvalId;
    // The same card is in Review too: an answer there withdraws the dialog.
    const dialog = openDialog(call, {
      message: dialogText(ctx, what, why, request),
      requestedSchema: { type: 'object', properties: {} },
    }, () => approvals.get(id)?.status !== 'pending', ctx.log);
    const answer = await waitForReply(dialog, call.signal);
    if (answer === 'later') {
      // Nobody answered in time. The dialog stays open, and an answer there later is carried out as Review would.
      stillOpen = true;
      void dialog.reply.then((late) => (late ? answerLate(ctx, session, call, id, late, application) : undefined));
    } else {
      ctx.log.info('the host answered an approval', { id, action: answer?.action ?? null });
      if (answer?.action === 'accept') {
        if (approvals.approve(id, undefined, `approved in ${call.client.name}`)) return carryOut();
        const elsewhere = await answeredElsewhere(ctx, session, id);
        return elsewhere ?? carryOut();
      }
      // Only a person's explicit no is a no. A dismissed or unanswered prompt
      // (a host running unattended dismisses it at once) leaves the request
      // waiting in Review for whoever can decide.
      if (answer?.action === 'decline' && approvals.reject(id, `declined in ${call.client.name}`)) {
        store.setRunStatus(session.runId, 'running');
        ctx.emit({ type: 'approval_answered', id, verdict: 'reject' });
        return 'The user declined. It was not done. Do not try to achieve it another way; ask them what they want instead.'
          + ' If it was a job application, record it with job_record as skipped, with the user\'s reason.';
      }
    }
    // Answered in Review while the dialog was open, or the window was closed: say what really happened.
    const elsewhere = await answeredElsewhere(ctx, session, id);
    if (elsewhere) return elsewhere;
  }

  ctx.emit({
    type: 'approval_required', approvalId: pending.approvalId,
    sensitivity: pending.sensitivity, why: pending.why,
  });
  ctx.showReview();
  const waiting = [
    `Not done yet: ${what} needs the user's approval. ${why}`,
    `It is waiting as approval ${pending.approvalId} on ${reviewPlace(ctx)}.`,
  ];
  // The host's dialog was the ask, and it is still open there.
  if (stillOpen) {
    return [
      ...waiting,
      'The dialog shown in your app is still open, and an answer there counts too, but nobody has answered it: do not count on the user having seen it.',
      'Tell the user now, in a message they can see in this turn (not only in your thinking), before you call anything to wait: '
        + 'what is waiting and that link, in one message with anything else that waits on them. '
        + 'Only then call approval_status with that id. Do not try to achieve it another way.',
      'A sub-agent does not tell the user or wait here: it leaves its session open and returns to its parent at once with this id. '
        + 'The parent tells the user once every sub-agent has reported, then calls approval_status.',
    ].join('\n');
  }
  // Nobody has asked the user yet, and until the agent ends its turn nobody will: waiting only delays the ask.
  if (!ctx.endTurn.has(pending.approvalId)) ctx.endTurn.set(pending.approvalId, 'told');
  return [
    ...waiting,
    'Do not wait for it. When the user approves it there, Fanfold presses it on this page at once and records the result, whether or not you are waiting. '
      + 'Keep this session open meanwhile, and do not try to achieve it another way.',
    'If you are working on other jobs, finish them first. Then end your turn with one message the user can see (not only in your thinking), '
      + 'with anything else that waits on them in it too. In it say what is waiting and give that link as it is; '
      + 'say it is sent the moment they approve it there, that nothing more is needed from them after approving (they need not come back to say so), '
      + 'and that you will report how it went when they next write, or they can ask you for it.',
    'Do not call approval_status for it until the user has written again.',
    'A sub-agent does not tell the user or wait: it leaves its session open and returns to its parent at once with this id. '
      + 'The parent, once every sub-agent has reported, does the same for all their waiting approvals together: one message with all of them, then it ends its turn.',
  ].join('\n');
}

/** Why the standing yes does not cover this press, or null when it does: judged on the agent's picture, and on the page as it is now. */
function standingFor(ctx: FanfoldContext, session: Session, request: ApprovalRequest | null): Promise<string | null> {
  return standingRefusalNow(ctx.app, request, session.observation, () => session.page.observe());
}

/** The action that waits, as the agent was first told of it. */
function whatWaits(request: ApprovalRequest | null | undefined): string {
  return request
    ? `${request.actionKind}${request.targetName ? ` "${request.targetName}"` : ''} on ${hostOf(request.url)}`
    : 'an action';
}

/**
 * The first look at an approval the agent was told to end its turn on, while
 * it still waits. Fanfold carries it out the moment the user approves, so a
 * wait here only keeps the user from hearing of it.
 */
export function firstLookText(ctx: FanfoldContext, request: ApprovalRequest): string {
  return [
    `Not answered yet: ${whatWaits(request)} is waiting as approval ${request.id} on ${reviewPlace(ctx)}.`,
    'The user must be told before anything else, and waiting here does not help: Fanfold sends it the moment they approve it there, whether or not you are waiting.',
    'End your turn now with one message the user can see, with anything else that waits on them in it too (if you are in the middle of other jobs, finish those first). '
      + 'In it name what is waiting and give that link as it is; say it is sent the moment they approve it there, '
      + 'that nothing more is needed from them after approving, and that you will report how it went when they next write.',
    'Do not call approval_status again until the user has replied, or until your other work is finished and you are about to report to them. '
      + 'A sub-agent does not tell the user: it returns to its parent at once with this id.',
  ].join('\n');
}

/**
 * How it stands when it was not answered in the host's dialog: approved or
 * rejected in Review meanwhile, or ended with its window. Null while it still
 * waits. A press approved in Review is given a moment to be carried out there.
 */
async function answeredElsewhere(ctx: FanfoldContext, session: Session, id: string): Promise<string | null> {
  const until = Date.now() + PRESS_MS;
  let now = ctx.app.approvals.get(id);
  while (now && (now.status === 'performing' || (now.status === 'approved' && !now.outcome)) && Date.now() < until) {
    await sleep(200);
    now = ctx.app.approvals.get(id);
  }
  if (!now || now.status === 'pending') return null;
  if (now.status === 'rejected') {
    return 'The user rejected it in Fanfold\'s Review. It was not done. Do not try to achieve it another way.'
      + ' If it was a job application, record it with job_record as skipped, with the user\'s reason.';
  }
  if (now.status === 'expired') return endedText(now);
  return `The user approved it in Fanfold's Review. ${await withPage(ctx, session, now)}`;
}

/**
 * The host's dialog was answered after the call stopped waiting for it. The
 * user's word still counts: carried out on its page, or turned down, as
 * Review would. The agent hears of it from approval_status.
 */
async function answerLate(ctx: FanfoldContext, session: Session, call: CallContext, id: string, reply: Reply, application: string | null): Promise<void> {
  const { approvals, store } = ctx.app;
  ctx.log.info('the host answered an approval late', { id, action: reply.action ?? null });
  try {
    if (reply.action === 'accept' && approvals.approve(id, undefined, `approved in ${call.client.name}`)) {
      const carry = (): ReturnType<typeof performApproved> => carryOutOnItsPage(ctx, id, application);
      const outcome = await (ctx.sessions.list().includes(session) ? ctx.sessions.exclusive(session, carry) : carry());
      store.setRunStatus(session.runId, 'running');
      ctx.emit({ type: 'approval_answered', id, verdict: 'approve', outcome });
    } else if (reply.action === 'decline' && approvals.reject(id, `declined in ${call.client.name}`)) {
      store.setRunStatus(session.runId, 'running');
      ctx.emit({ type: 'approval_answered', id, verdict: 'reject' });
    }
  } catch (err) {
    ctx.log.warn('a late answer in the host\'s dialog could not be carried out', { id, err });
  }
}

/** An approval that ended without being carried out, such as one whose window was closed. */
export function endedText(request: ApprovalRequest): string {
  if (request.outcome !== 'not_done' || !request.outcomeDetail) {
    return 'The request expired unanswered, as when Fanfold was closed before the user answered. It was not done. '
      + 'If the job still needs doing, open it again in a session of yours and start over.';
  }
  return `Not done: ${request.outcomeDetail}. It cannot be approved any more. If the job still needs doing, open it again in a session of yours and start over.`;
}

/**
 * The host's dialog says what the card in Review says: which job, and the
 * answers going with it, so the person can decide there as well.
 */
function dialogText(ctx: FanfoldContext, what: string, why: string, request: ApprovalRequest | null): string {
  const lines = [`Fanfold wants to ${what}.`];
  const job = request ? ctx.app.jobs.forPosting(request.url)?.job : null;
  const named = job ? `${job.company} — ${job.title}` : request?.pageTitle;
  if (named) lines.push(named);
  lines.push('', why);
  const form = request?.form ?? [];
  if (form.length) {
    lines.push('', 'It sends:');
    for (const f of form.slice(0, DIALOG_ANSWERS)) {
      const value = f.value ? f.value.replace(/\s+/g, ' ').slice(0, 80) : '(blank)';
      lines.push(f.label ? `- ${f.label.slice(0, 80)}: ${value}` : `- ${value}`);
    }
    if (form.length > DIALOG_ANSWERS) lines.push(`…and ${form.length - DIALOG_ANSWERS} more, on the card in Fanfold's Review.`);
  }
  lines.push('', 'Allow it?');
  return lines.join('\n');
}

/** What came of an approval the user gave, or their standing yes, in words the host's model can act on. */
function approvedText(request: ApprovalRequest): string {
  const detail = request.outcomeDetail ?? 'no reason was given';
  // Said as it was: a press on the standing yes is never "the user approved it".
  const who = byStanding(request) ? COPY.standing : COPY.userApproved;
  if (request.status === 'performing') return `${who} and it is being carried out now. Call approval_status again in a moment.`;
  switch (request.outcome) {
    case 'refused':
      return `${who} and Fanfold pressed it, but ${detail}. `
        + 'With the same answers it goes on this approval; if the answers change, the user is asked again.';
    case 'unknown':
      return `${who} and Fanfold pressed it, but ${detail}. Take a snapshot, and tell the user.`;
    case 'not_done':
      // There is no card left to approve: only pressing it again puts the form as it is now in front of the user.
      if (changedAfterApproval(request.outcomeDetail)) {
        return `${who}, but it was not carried out: ${detail}. There is nothing for them to approve until you press it again. `
          + 'Take a snapshot, check the form holds what the user wants, and press it again: that puts a new card in Review. Tell the user it is waiting for them again.';
      }
      return `${who}, but it was not carried out: ${detail}. Take a snapshot and check where things stand.`;
    default:
      return request.status === 'approved'
        ? `${who}, and it has not been carried out yet. Call approval_status again in a moment.`
        : `${who} and it was carried out.`;
  }
}

/** The outcome, and the page after it when something was pressed. */
export async function withPage(ctx: FanfoldContext, session: Session | undefined, request: ApprovalRequest | null): Promise<string> {
  if (!request) return 'That approval is gone.';
  const filed = request.status === 'consumed' ? ctx.app.jobs.forPosting(request.url) : null;
  const text = approvedText(request)
    + (filed && (filed.status === 'applied' || filed.status === 'unconfirmed')
      ? ` Fanfold's ledger has ${fence(filed.job.company)} — ${fence(filed.job.title)} as ${filed.status}.` : '');
  const pressed = request.status === 'consumed' || request.outcome === 'refused';
  return pressed && session ? `${text}\n${await snapshot(ctx, session)}` : text;
}

/** Turn the outcome of a governed action into what the host's model reads. */
export async function reportGoverned(
  ctx: FanfoldContext, session: Session, call: CallContext, action: AgentAction, governed: Governed,
  view: SnapshotOptions | null,
): Promise<{ text: string; ok: boolean }> {
  const label = describeAction(action);
  const after = async (): Promise<string> => (view ? `\n${await snapshot(ctx, session, view)}` : '');

  switch (governed.status) {
    case 'ok':
      return {
        ok: true,
        text: `done: ${label}${governed.result.detail ? ` (${governed.result.detail})` : ''}${governed.result.navigated ? ' (the page navigated)' : ''}${await after()}`,
      };
    case 'failed':
      // Decided before anything was sent, so the refs are what went wrong.
      return {
        ok: false,
        text: `FAILED ${governed.failure}: ${governed.detail || 'the target could not be used'}. Nothing was sent to the page. `
          + `Refs come from the latest snapshot; here is the current one.\n${await snapshot(ctx, session, view ?? {})}`,
      };
    case 'unknown':
      return {
        ok: false,
        text: `OUTCOME UNKNOWN: ${governed.detail}. `
          + (governed.stop
            ? 'It may have reached someone or changed something outside this page. Do not repeat it. Take a snapshot, check what happened, and tell the user.'
            : 'Take a snapshot and check before doing anything else; do not assume it worked or did not.'),
      };
    case 'needs_approval':
      return { ok: false, text: await seekApproval(ctx, session, call, governed) };
    case 'prepare':
      ctx.emit({ type: 'application', applicationId: governed.applicationId, status: 'prepared' });
      return {
        ok: false,
        text: `Not pressed, by design: ${governed.why}. Everything else on the form can be filled. `
          + 'Tell the user it is ready for them to submit.',
      };
    case 'refused':
      return { ok: false, text: `Refused: ${governed.why}` };
  }
}
