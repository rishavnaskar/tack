/** Sessions for parallel work and sandboxes, and the status of a waiting approval. */
import type { Tool } from '../protocol.ts';
import { reviewPlace, type FanfoldContext } from '../context.ts';
import { endedText, firstLookText, withPage } from '../approval.ts';
import { hostOf } from '../../agent/actions.ts';
import { postingKey } from '../../jobs/jobs.ts';
import { CODE_ASK_MS } from '../code-ask.ts';
import { COPY, sessionName, type Session, type Wait } from '../sessions.ts';
import { detectChallenge } from '../../policy/challenge.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** An approval younger than this was only just pressed: the user has not been asked yet. */
const JUST_PRESSED_MS = 2 * 60_000;
/** A question still unanswered after this long no longer keeps the window it was asked from. */
const QUESTION_HOLDS_MS = 6 * 60 * 60_000;
/** The user's answers are in: the filled form is kept this long for the agent sent back to finish it. */
export const answeredHold = { ms: 10 * 60_000 };
/** A check on a session's page keeps its window this long for the user, as an emailed code does. */
const CHECK_HOLDS_MS = CODE_ASK_MS;
/** A job recorded as one of these needs nothing more from the form it was filled in. */
const FINISHED: ReadonlySet<string> = new Set(['skipped', 'applied', 'unconfirmed', 'failed']);

/**
 * Questions still open that were asked from this session: by a job it has
 * claimed, or from a page it has shown, since it opened. Questions are kept
 * once however many forms ask them, with the last few jobs that did. None
 * once every job it claimed is recorded as skipped or sent.
 */
function askedFrom(ctx: FanfoldContext, session: Session, now = Date.now(), status: 'open' | 'answered' = 'open'): number[] {
  const opened = Date.parse(session.openedAt);
  const claimed = ctx.app.jobs.list({ limit: 500 }).filter((a) => a.runId === session.runId);
  if (claimed.length && claimed.every((a) => FINISHED.has(a.status))) return [];
  const places = new Set([...(session.seen ?? []), session.observation?.url ?? '', ...claimed.flatMap((a) => [a.url, a.job.url, ...a.job.sourceUrls])]
    .map((u) => postingKey(u)).filter((k): k is string => !!k));
  const companies = new Set(claimed.map((a) => a.job.company.trim().toLowerCase()).filter(Boolean));
  // An answer that came after its agent left the form waiting holds it a while for the agent sent back; declined, nothing comes back for it.
  const recent = (q: { answeredAt: string | null }): boolean => {
    if (status === 'open') return true;
    const at = Date.parse(q.answeredAt ?? '');
    return session.keptAt !== undefined && at >= session.keptAt && now - at <= answeredHold.ms;
  };
  return ctx.app.questions.list(status).filter(recent).filter((q) => q.askedBy.some((by) => {
    const at = Date.parse(by.at);
    if (!(at >= opened) || now - at > QUESTION_HOLDS_MS) return false;
    const key = postingKey(by.url);
    return (!!key && places.has(key)) || companies.has(by.company.trim().toLowerCase());
  })).map((q) => q.id);
}

/**
 * Whether the page this session last showed holds a check that is the
 * user's to do. Remembered from when it was first seen, so a kept window
 * does not wait on it for ever.
 */
function checkWaits(session: Session, now = Date.now()): boolean {
  if (session.observation) {
    const challenge = detectChallenge(session.observation);
    if (challenge && (challenge.reason ?? 'check') === 'check') session.checkSince ??= now;
    else delete session.checkSince;
  }
  return session.checkSince !== undefined && now - session.checkSince <= CHECK_HOLDS_MS;
}

/** What keeps a session open for the user besides an approval: an answer owed to a form in it, the code its site emailed, or a check on its page. */
function waitsIn(ctx: FanfoldContext, session: Session): Wait[] {
  const waits: Wait[] = [];
  if (checkWaits(session)) waits.push({ kind: 'check', why: COPY.checkWaits });
  const code = session.codeAsk;
  if (code && Date.now() - code.since.getTime() <= CODE_ASK_MS) {
    waits.push({
      kind: 'code',
      why: 'the site is waiting for the code it emailed, and the application has not gone through without it: call browser_code in this session to enter it',
    });
  }
  const asked = askedFrom(ctx, session);
  if (asked.length) {
    waits.push({
      kind: 'question',
      why: `${asked.length === 1 ? 'a question' : `${asked.length} questions`} asked from its form (${asked.map((id) => `question ${id}`).join(', ')}) `
        + `${asked.length === 1 ? 'is' : 'are'} not answered yet, and the form stays filled for when ${asked.length === 1 ? 'it is' : 'they are'}`,
    });
  }
  else if (askedFrom(ctx, session, Date.now(), 'answered').length) {
    waits.push({ kind: 'answered', why: COPY.answeredWaits });
  }
  return waits;
}

export function sessionTools(ctx: FanfoldContext): Tool[] {
  ctx.sessions.alsoWaitsOn((session) => waitsIn(ctx, session));

  const open: Tool = {
    name: 'session_open',
    title: 'Open another browser session',
    description:
      'Open a second place to work, so several things can happen at once. By default it is a new tab in the user\'s browser, sharing their sign-ins. '
      + 'With sandbox: true it is a separate, empty browser with none of the user\'s cookies or sign-ins, deleted when closed; '
      + 'use that for sites the user has no account on, or work that should leave nothing behind. '
      + 'Pass the returned name as `session` to the browser tools. Calls on different sessions run in parallel. '
      + 'A session is this connection\'s own: another agent connected to Fanfold cannot see or use it, and may use the same name for its own. '
      + 'At most 8 tab sessions and 3 sandboxes are open at once, counting every agent\'s together.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 32, description: 'Optional. Lowercase letters, digits, "-" or "_".' },
        sandbox: { type: 'boolean', description: 'A separate empty browser instead of a tab in the user\'s.' },
        visible: { type: 'boolean', description: 'For a sandbox: show its window. Default hidden.' },
      },
    },
    run: async (args, call) => {
      const session = await ctx.sessions.open({
        name: typeof args.name === 'string' ? args.name : undefined,
        sandbox: args.sandbox === true,
        visible: args.visible === true,
        by: call.caller,
      });
      return session.kind === 'sandbox'
        ? `opened sandbox session "${session.name}": an empty browser with no sign-ins. Close it with session_close when done.`
        : `opened session "${session.name}": a new tab in the user's browser, with their sign-ins. Close it with session_close when done.`;
    },
  };

  const list: Tool = {
    name: 'session_list',
    title: 'List browser sessions',
    description: 'Every open session, what kind it is, and where it is.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    run: async (_args, call) => {
      const sessions = ctx.sessions.list(call.caller);
      if (!sessions.length) return 'no session is open yet. "main" opens the first time a browser tool is used.';
      return sessions.map((s) => {
        const at = s.observation ? hostOf(s.observation.url) || 'a blank page' : 'not looked at yet';
        return `${s.name} (${s.kind}) — ${at}, ${s.step} step(s)${ctx.sessions.isKept(s) ? ', kept open for the user' : ''}`;
      }).join('\n');
    },
  };

  const close: Tool = {
    name: 'session_close',
    title: 'Close a browser session',
    description:
      'Close a session opened with session_open. A sandbox and everything in it is deleted. '
      + 'A session that still waits on the user (an approval, an answer to a question asked from its form, a code the site emailed, or a bot check on its page) is kept instead, '
      + 'with its page as it is, and closes by itself once nothing in it waits; the result says so.',
    inputSchema: {
      type: 'object', required: ['name'], additionalProperties: false,
      properties: { name: { type: 'string', maxLength: 32 } },
    },
    run: async (args, call) => {
      const name = sessionName(String(args.name)) || String(args.name);
      const open = ctx.sessions.find(name, call.caller);
      // Its page as it is, when the agent holds no picture of it: a check on it keeps the window for the user.
      if (open && open.kind !== 'main' && !open.observation) {
        await ctx.sessions.exclusive(open, async () => { open.observation = await open.page.observe(); }).catch(() => {});
      }
      const waiting = open?.codeAsk?.applicationId;
      const { closed, kept } = await ctx.sessions.closeUnlessWaiting(name, call.caller);
      if (kept.length) {
        return [
          `Kept "${name}" open instead of closing it: ${kept.map((w) => w.why).join('; and ')}.`,
          'It closes by itself once nothing in it waits on the user. To finish it, keep using the same session name: '
            + 'whoever finishes it closes it with session_close as usual.',
        ].join('\n');
      }
      if (!closed) return `no session named ${JSON.stringify(args.name)} was open`;
      // Closing it left the site waiting on its emailed code: endCodeAsk filed the application as the user's.
      const left = waiting ? ctx.app.jobs.application(waiting) : null;
      return left?.status === 'needs_review'
        ? `closed ${String(args.name)}. The site was still waiting for the code it emailed, so that application did not go through: Fanfold's ledger lists it as needing the user. Tell the user.`
        : `closed ${String(args.name)}`;
    },
  };

  const approval: Tool = {
    name: 'approval_status',
    title: 'Check a waiting approval',
    description:
      'Whether the user has answered an approval that an earlier action is waiting on, and how it went. '
      + 'Fanfold carries the action out the moment the user approves it, so tell the user first and call this when they next write, to report the outcome. '
      + 'It may wait a little for the answer. Only the user can approve: in your app\'s own dialog when it shows one, or in Fanfold\'s Review queue.',
    inputSchema: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: {
        id: { type: 'string', maxLength: 64 },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 50, description: 'How long to wait for an answer. Default 20.' },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (args, call) => {
      const id = String(args.id);
      const first = ctx.app.approvals.get(id);
      // The first look right after the press comes before the user has been told: waiting then only delays telling them.
      if (first?.status === 'pending' && ctx.endTurn.get(id) === 'told') {
        ctx.endTurn.set(id, 'looked');
        if (Date.now() - Date.parse(first.requestedAt) < JUST_PRESSED_MS) return firstLookText(ctx, first);
      }
      const deadline = Date.now() + (typeof args.wait_seconds === 'number' ? args.wait_seconds : 20) * 1000;
      for (;;) {
        const request = ctx.app.approvals.get(id);
        if (!request) throw new Error(`no approval with id ${id}`);
        // Approved and still being carried out: the answer is a moment away.
        if (request.status === 'pending' || request.status === 'performing') {
          if (Date.now() >= deadline || call.signal.aborted) {
            if (request.status === 'performing') return 'The user approved it and it is being carried out now. Call approval_status again in a moment.';
            return `Still waiting for the user. It is on ${reviewPlace(ctx)}, and people often take a few minutes. `
              + 'If you have not told the user yet, tell them now, with that link. '
              + 'Fanfold sends it the moment they approve it there, so there is no need to keep checking: carry on with something that does not depend on it, '
              + 'or end your turn, and call approval_status again when the user next writes; a sub-agent returns to its parent with the id instead of waiting.';
          }
          await sleep(1000);
          continue;
        }
        const session = ctx.sessions.list().find((s) => s.runId === request.runId);
        if (session) ctx.app.store.setRunStatus(session.runId, 'running');
        if (request.status === 'rejected') {
          return 'The user rejected it. It was not done. Do not try to achieve it another way.'
            + ' If it was a job application, record it with job_record as skipped, with the user\'s reason.';
        }
        if (request.status === 'expired') return endedText(request);
        return session ? ctx.sessions.exclusive(session, () => withPage(ctx, session, request)) : withPage(ctx, undefined, request);
      }
    },
  };

  return [open, list, close, approval];
}
