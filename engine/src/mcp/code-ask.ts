/**
 * The code a site asks for after this session's own application Submit.
 *
 * Some sites take an application, email a code, and want it typed back
 * before they keep it. Whether a code on a page is one of those is decided by
 * what came before it, not by how the page words it: a code asked for with no
 * application Submit from this session before it is a sign-in's or an
 * account's, and the user's to enter. So the ask is recorded when a page
 * first wants an emailed code after a Submit the user (or their standing yes)
 * let through, with what it belongs to: when the Submit was pressed, the job,
 * the site and the length the page gave. It follows the code from page to
 * page on that site, through a rejected code and a move to /verify, and ends
 * when the application is confirmed, the session leaves the site or closes,
 * or the code has long expired.
 */
import type { App } from '../app.ts';
import { confirmationIn, type ApprovalRequest } from '../agent/approvals.ts';
import { hostOf } from '../agent/actions.ts';
import { boardOf, codeEntry, emailedCodeAsk, forAccount, partOfCode } from '../connectors/mail-code.ts';
import { markUntrusted } from '../policy/untrusted.ts';
import type { Observation } from '../types.ts';
import type { Session } from './sessions.ts';

/** A code a site emails is good for about this long. */
export const CODE_ASK_MS = 30 * 60_000;
/** The mailbox's clock and this one may disagree by a few seconds. */
const CLOCKS_MS = 5_000;

export interface CodeAskRecord {
  /** The Submit, less a few seconds: mail from before it is not this code. */
  since: Date;
  /** The Submit that was let through. */
  approvalId: string;
  /** The application in the ledger, when it has one. */
  applicationId: string | null;
  /** The company, as the ledger named it when the Submit went out. */
  company: string;
  /** The board in the application's address on an application system, such as "acme". */
  board: string;
  host: string;
  /** How many characters the page first said the code has. */
  length: number | null;
  /** Codes Fanfold read from the user's mail and typed: kept from the agent for as long as the record lasts. */
  hidden: Set<string>;
  /** Waits for mail that ended with no code. */
  misses: number;
  /** When a page last wanted the code. */
  askedAt: number;
  /** The code this session last typed, the page it went into, and what that page already said against a code at the time. */
  entered?: { code: string; url: string; refusals: string[] };
}

type Ledger = Pick<App, 'approvals' | 'jobs'>;

const pressedAt = (e: ApprovalRequest): number => Date.parse(e.answeredAt ?? e.requestedAt);
const submitted = (e: ApprovalRequest): boolean => e.status === 'consumed' && e.sensitivity === 'CONTACT_EXTERNAL'
  && (e.actionKind === 'click' || e.actionKind === 'press') && /\bapplication\b/i.test(e.why);

/** What the ledger says of an application whose site still wanted its code when it was left. */
const CODE_NOT_ENTERED = 'Not finished: the site emailed a code to confirm this application, and the code was not entered before the page was left. Apply again, or enter a new code on the site.';

/**
 * This session's code ask, as of the page now in front of it: begun, carried
 * on or ended. Null when there is none.
 */
export function followCodeAsk(app: Ledger, session: Session, observation: Observation | null, now = Date.now()): CodeAskRecord | null {
  const record = session.codeAsk;
  if (!observation) return record ?? null;
  if (record) {
    const gone = hostOf(observation.url) !== record.host || now - record.since.getTime() > CODE_ASK_MS;
    // Still asking, or turning a code away: a rejected code shows its field again.
    if (!gone && codeEntry(observation) && !forAccount(observation)) {
      record.askedAt = now;
      return record;
    }
    endCodeAsk(app, session, { confirmed: !gone && confirmationIn(observation) !== null, now });
  }
  return beginCodeAsk(app, session, observation, now);
}

function beginCodeAsk(app: Ledger, session: Session, observation: Observation, now: number): CodeAskRecord | null {
  const ask = emailedCodeAsk(observation);
  if (!ask) return null;
  // The latest application this session sent, on this site, not long ago, and not one an earlier ask already followed.
  const submit = app.approvals.forRun(session.runId).find((e) => submitted(e) && e.outcome === 'sent');
  if (!submit || hostOf(submit.url) !== hostOf(observation.url)) return null;
  const at = pressedAt(submit);
  // A Submit in the same millisecond as the end of the last ask is the one that ask followed.
  if (!(now - at <= CODE_ASK_MS) || at <= (session.codeAskEnded ?? -Infinity)) return null;
  const filed = app.jobs.forPosting(submit.url);
  session.codeAsk = {
    since: new Date(at - CLOCKS_MS), approvalId: submit.id, applicationId: filed?.id ?? null,
    company: filed?.job.company ?? '', board: boardOf(submit.url), host: hostOf(observation.url),
    length: ask.length, hidden: new Set(), misses: 0, askedAt: now,
  };
  return session.codeAsk;
}

/**
 * The ask is over. Left while the site still wanted its code, with no Submit
 * after the last time it asked (the session closed or went elsewhere, or the
 * code expired), the application did not go through: the ledger says it
 * needs the user, and why, rather than leaving it unconfirmed.
 */
export function endCodeAsk(app: Ledger, session: Session, opts: { confirmed?: boolean; now?: number } = {}): void {
  const record = session.codeAsk;
  if (!record) return;
  session.codeAsk = undefined;
  session.codeAskEnded = opts.now ?? Date.now();
  if (opts.confirmed || !record.applicationId) return;
  // The Submit that began the ask is not one made after it, however close together the two were.
  if (app.approvals.forRun(session.runId).some((e) => e.id !== record.approvalId && submitted(e) && pressedAt(e) >= record.askedAt)) return;
  if (app.jobs.application(record.applicationId)?.status !== 'unconfirmed') return;
  try {
    app.jobs.transition(record.applicationId, 'needs_review', { confirmation: CODE_NOT_ENTERED });
  } catch {
    // The ledger is a record of what happened; failing to write it does not change what happened.
  }
}

/**
 * A session with a code ask is about to close (the ask ran out, or its
 * window was let go): its page is read once more first. When the user typed
 * the code in themselves the page says the application went through, and the
 * ledger records it as applied with what the page said, not as needing them.
 */
export async function settleCodeAsk(app: Ledger, session: Session, opts: { timeoutMs?: number } = {}): Promise<void> {
  const record = session.codeAsk;
  if (!record) return;
  let timer: NodeJS.Timeout | undefined;
  const observation = await Promise.race([
    session.page.observe().catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.timeoutMs ?? 5_000); }),
  ]).finally(() => clearTimeout(timer));
  if (session.codeAsk !== record || !observation || hostOf(observation.url) !== record.host) return;
  if (codeEntry(observation) && !forAccount(observation)) return;
  const confirmation = confirmationIn(observation);
  if (!confirmation) return;
  endCodeAsk(app, session, { confirmed: true });
  if (!record.applicationId || app.jobs.application(record.applicationId)?.status !== 'unconfirmed') return;
  try {
    app.jobs.transition(record.applicationId, 'applied', { confirmation });
  } catch {
    // The ledger is a record of what happened; failing to write it does not change what happened.
  }
}

/** The application a press on this site finishes, when the session it was asked in is in the middle of a code ask there. */
export function codeAskApplication(sessions: Session[], runId: string, url: string, now = Date.now()): string | null {
  const record = sessions.find((s) => s.runId === runId)?.codeAsk;
  return record && record.host === hostOf(url) && now - record.since.getTime() <= CODE_ASK_MS ? record.applicationId : null;
}

/** The page as the agent may see it while a code Fanfold read from mail is in it: every field of the code shows as "[the code]". */
export function withCodeHidden(record: CodeAskRecord | null, observation: Observation): Observation {
  if (!record?.hidden.size) return observation;
  return { ...observation, nodes: observation.nodes.map((n) => (n.value && partOfCode(n) ? { ...n, value: markUntrusted('[the code]') } : n)) };
}

/** Text for the agent with every code Fanfold read from mail taken out, however the page wrote it back. */
export function hideCodes(record: CodeAskRecord | null | undefined, text: string): string {
  let out = text;
  // A code is letters and digits only, so it is safe to search for as it is.
  for (const code of record?.hidden ?? []) out = out.replace(new RegExp(code, 'gi'), '[the code]');
  return out;
}
