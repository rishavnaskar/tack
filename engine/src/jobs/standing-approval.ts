/**
 * The person's standing yes to their own applications.
 *
 * With "Submit applications without asking me" on, an application an agent
 * has filled is sent when it reaches Submit, instead of waiting on a card. It
 * is the owner's setting alone (agents cannot reach it), and it is narrow:
 * a click that submits an application, every required field answered, on a
 * site whose own setting lets Fanfold submit, within a daily limit per site.
 * Messages, anything else that reaches a person, and the steps that are only
 * the person's (video, assessments, ID numbers, signatures) still ask.
 */
import {
  openedFormOnly, performApproved, type ApprovalRequest, type Approvals, type PerformOptions, type ResumeOutcome,
} from '../agent/approvals.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import type { ApplicationRow, Jobs } from './jobs.ts';
import { shippedDailyCap, type SitePolicies } from './site-policies.ts';
import { hostOf } from '../agent/actions.ts';
import { whenSaid } from '../policy/recipient.ts';
import { isCodeLabel } from '../connectors/mail-code.ts';
import { startsApplication } from '../policy/engine.ts';
import { detectChallenge } from '../policy/challenge.ts';
import type { Observation } from '../types.ts';

export const SETTING = 'submitWithoutAsking';
/** Noted on an approval the standing yes gave, so what came of it can be counted against the site's day. */
export const STANDING_NOTE = 'sent without asking, as the user set';
/** The same, for an Apply button that opens an application's form: on most sites pressing it sends nothing. */
export const STANDING_OPEN_NOTE = 'pressed without asking, as the user set: an Apply button, which opens the application form';
/** For a site with no cap of its own. Enough for a busy day, few enough that a loop gone wrong stops early. */
export const DAILY_LIMIT = 25;
const COUNT = 'submittedWithoutAsking';

/** Which of the two notes a press on the standing yes is approved with. */
export function standingNote(request: ApprovalRequest | null): string {
  return request && startsApplication(request.why) ? STANDING_OPEN_NOTE : STANDING_NOTE;
}

/** The standing yes, not the person, let this one go. */
export function byStanding(request: ApprovalRequest | null | undefined): boolean {
  return request?.answeredNote === STANDING_NOTE || request?.answeredNote === STANDING_OPEN_NOTE;
}

/** What the user and the agent read about the standing yes. */
export const COPY = {
  off: 'submitting without asking is off',
  notClick: 'it is not a click that submits',
  notApplication: 'it is not an application',
  check: 'a check on the page (a box to tick or a puzzle) is the user\'s to do, and Fanfold does not do these',
  signin: 'the page wants the user to sign in, which is theirs to do',
  pause: 'the site asked Fanfold to stop for now',
  /** On the card and in the result when the standing yes did not cover a Submit. */
  held: 'This was not submitted automatically because {why}.',
  /** What the agent reads once a press went on the standing yes. */
  sentAtOnce: 'The user set Fanfold to submit applications without asking, so it was sent at once.',
  openedAtOnce: 'The user set Fanfold to go ahead with their applications without asking, so it was pressed at once. It opened the application form; nothing has been sent yet.',
  pressedAtOnce: 'The user set Fanfold to submit applications without asking, so it was pressed at once.',
};

interface Settings {
  setting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
}

type Count = { day: string; bySite: Record<string, number> };

/** The ledger's sent application for the job this card would submit, when there is one. */
export function sentBefore(jobs: Pick<Jobs, 'forPosting'> | undefined, request: ApprovalRequest | null): ApplicationRow | null {
  if (!jobs || !request || request.actionKind !== 'click' || !/\bapplication\b/i.test(request.why)) return null;
  const row = jobs.forPosting(request.url);
  return row && ['applying', 'unconfirmed', 'applied'].includes(row.status) ? row : null;
}

/** What a card for a job the ledger already has as sent tells the person. */
export function secondApplicationNote(sent: ApplicationRow): string {
  const on = whenSaid(sent.submittedAt ?? sent.updatedAt);
  return `Fanfold already has this job listed as ${sent.status} on ${on}, so this looks like a second application to the same job. `
    + 'It wasn\'t sent automatically. Only approve if you want to apply again.';
}

/**
 * Why this one still needs the person, or null when the standing yes covers
 * it. `page` is what the page shows: a check on it (a box to tick, a puzzle,
 * a sign-in) is the person's to do, so nothing is sent past it on their
 * standing word.
 */
export function standingRefusal(
  store: Settings, sites: SitePolicies, request: ApprovalRequest | null, now = new Date(), jobs?: Pick<Jobs, 'forPosting'>,
  opts: { page?: Observation | null } = {},
): string | null {
  if (!store.setting(SETTING, false)) return COPY.off;
  if (!request || request.sensitivity !== 'CONTACT_EXTERNAL' || request.actionKind !== 'click') return COPY.notClick;
  if (!/\bapplication\b/i.test(request.why)) return COPY.notApplication;
  const challenge = detectChallenge(opts.page ?? null);
  if (challenge) return challenge.reason === 'signin' ? COPY.signin : challenge.reason === 'limit' || challenge.reason === 'rate' ? COPY.pause : COPY.check;
  const sent = sentBefore(jobs, request);
  if (sent) return `the ledger already has this job as ${sent.status}: it looks like a second application`;
  const form = request.form ?? [];
  // An Apply button on a posting off the catalog, with no form on the page yet, has no answers to read.
  if (!form.length && !startsApplication(request.why)) return 'nothing on the form was read';
  const blank = form.filter((f) => f.required && !String(f.value ?? '').trim());
  if (blank.length) return `${blank.length} required field${blank.length === 1 ? ' is' : 's are'} empty`;
  const site = sites.forUrl(request.url);
  if (site && site.submit !== 'auto') return `${site.label} is set to leave Submit to the user`;
  const key = site?.key ?? hostOf(request.url);
  const limit = (site && (site.defaultDailyCap || shippedDailyCap(site.key))) || DAILY_LIMIT;
  if (sentToday(store, key, now) >= limit) return `${limit} applications were already sent without asking on ${site?.label ?? key} today`;
  return null;
}

/**
 * Why the standing yes does not cover this press, or null when it does. The
 * page is looked at as it is now when the agent's own picture shows no check
 * on it: a box to tick can be drawn after the form was read.
 */
export async function standingRefusalNow(
  deps: { store: Settings; sites: SitePolicies; jobs?: Pick<Jobs, 'forPosting'> },
  request: ApprovalRequest | null, seen: Observation | null, look: () => Promise<Observation>,
): Promise<string | null> {
  const judged = (page: Observation | null): string | null => standingRefusal(deps.store, deps.sites, request, new Date(), deps.jobs, { page });
  const first = judged(seen);
  if (first || detectChallenge(seen)) return first;
  return judged(await look().catch(() => seen));
}

/** Carry out an approved press on its page. One that went out on the standing yes counts against its site's day. */
export async function carryOutCounted(
  approvals: Approvals, page: BrowserRuntime | null, id: string, opts: PerformOptions & { store: Settings; sites: SitePolicies },
): Promise<ResumeOutcome> {
  const outcome = await performApproved(approvals, page, id, opts);
  // The site's day is counted by what went out on the standing yes, not by what it let go.
  const done = approvals.get(id);
  if (sentOnStanding(done)) countStanding(opts.store, opts.sites, done!);
  return outcome;
}

/**
 * What the agent reads of a press the standing yes let go. "Sent" only when
 * it was: a press the page turned away, or one the browser never reported
 * on, is said as what it is.
 */
export function pressedOnStanding(done: ApprovalRequest | null | undefined): string {
  return openedFormOnly(done) ? COPY.openedAtOnce : done?.outcome === 'sent' ? COPY.sentAtOnce : COPY.pressedAtOnce;
}

/**
 * The sentence for the card and the result when the standing yes was on and
 * did not cover this Submit; null when there is nothing to say (it is off,
 * the press is not an application's, or the card already says it is a second one).
 */
export function heldNote(refusal: string | null): string | null {
  if (!refusal || [COPY.off, COPY.notClick, COPY.notApplication].includes(refusal) || /second application/.test(refusal)) return null;
  return COPY.held.replace('{why}', refusal);
}

/** A code a site emails is good for about this long; a Submit after that starts again. */
const CODE_STEP_MS = 30 * 60_000;

/**
 * The earlier Submit this press finishes, when it does. Some sites take the
 * application, email a code, and want the code typed in and Submit pressed
 * again: that second press sends the same application, which the person (or
 * their standing yes) already let go, so it goes on that permission. It is
 * kept narrow. The session is in the middle of the code the site asked for
 * after that Submit (its code ask, which follows the code from page to page
 * on one site); the press is from the same session, on that site, and sends
 * the code's form with the code in it; and apart from the code, the form
 * holds nothing the earlier card did not show. Anything else is a new decision.
 */
export function finishesSubmit(
  request: ApprovalRequest, earlier: ApprovalRequest[],
  opts: { codeAsk: { host: string; since: Date } | null; now?: Date },
): ApprovalRequest | null {
  const ask = opts.codeAsk;
  if (!ask || request.sensitivity !== 'CONTACT_EXTERNAL' || request.actionKind !== 'click' || hostOf(request.url) !== ask.host) return null;
  const form = request.form ?? [];
  const codes = form.filter((f) => isCodeLabel(f.label));
  if (!codes.length || codes.some((f) => !f.value.trim())) return null;
  if (form.some((f) => f.required && !String(f.value ?? '').trim())) return null;
  const now = (opts.now ?? new Date()).getTime();
  const pressed = (e: ApprovalRequest): number => Date.parse(e.answeredAt ?? e.requestedAt);
  // The Submit the code was asked after, or one that already finished it on its permission and had its code turned away.
  return earlier.find((e) => e.id !== request.id && e.runId === request.runId
    && e.status === 'consumed' && e.outcome === 'sent'
    && e.sensitivity === 'CONTACT_EXTERNAL' && e.actionKind === 'click' && /\bapplication\b/i.test(e.why)
    && hostOf(e.url) === ask.host && pressed(e) >= ask.since.getTime()
    && now - pressed(e) <= CODE_STEP_MS
    && form.every((f) => isCodeLabel(f.label) || (e.form ?? []).some((g) => g.label === f.label && g.value === f.value))) ?? null;
}

/**
 * Whether a press the standing yes let go counts against its site's day: it
 * went out, or may have. One that only opened the application's form, or was
 * never carried out, or that the page turned away, sent nothing.
 */
export function sentOnStanding(request: ApprovalRequest | null | undefined): boolean {
  if (!request || !byStanding(request) || request.status !== 'consumed') return false;
  return request.outcome === 'unknown' || (request.outcome === 'sent' && !openedFormOnly(request));
}

/** Count one sent under the standing yes, against its site's day. */
export function countStanding(store: Settings, sites: SitePolicies, request: ApprovalRequest, now = new Date()): void {
  const key = sites.forUrl(request.url)?.key ?? hostOf(request.url);
  const day = now.toISOString().slice(0, 10);
  const count = store.setting<Count | null>(COUNT, null);
  const bySite = count?.day === day ? { ...count.bySite } : {};
  bySite[key] = (bySite[key] ?? 0) + 1;
  store.setSetting(COUNT, { day, bySite });
}

function sentToday(store: Settings, key: string, now: Date): number {
  const count = store.setting<Count | null>(COUNT, null);
  return count?.day === now.toISOString().slice(0, 10) ? count.bySite[key] ?? 0 : 0;
}
