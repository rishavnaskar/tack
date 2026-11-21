/**
 * The inner loop: observe → choose → check → act → record.
 *
 * Hand-rolled and typed rather than a graph framework, because the loop is
 * genuinely simple and per-step overhead is paid on every one of 30–100 steps.
 *
 * The order of the middle two stages is the important part. Policy runs
 * between the model and the browser, on every action, with no path around it.
 * The model proposes; it never authorises.
 */

import { randomUUID } from 'node:crypto';
import type { Completion, CompleteOptions } from '../model/client.ts';
import { Store } from '../store/db.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import { renderObservation, snapshotNotes } from '../observe/render.ts';
import { fenceBlock, unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { decide, type PolicyContext } from '../policy/engine.ts';
import { uploadHold } from '../policy/upload-hold.ts';
import { unattachable } from '../policy/import-hold.ts';
import type { RateGovernor } from '../workers/governor.ts';
import { labelActivity } from '../workers/classify-action.ts';
import { deriveRecipient, recipientChanged, repeatContactWhy } from '../policy/recipient.ts';
import { openedFormOnly, type ApprovalRequest, type Approvals, type ResumeOutcome } from './approvals.ts';
import { buildStepMessages, ACTION_SCHEMA, CONNECTOR_KINDS, RECORD_KINDS, STEP_MAX_TOKENS, type AgentAction } from './prompt.ts';
import { availableTools, type AgentTools } from './tools.ts';
import type { Tier } from '../model/pricebook.ts';
import type { ActionResult, Observation, ObservedNode, Sensitivity } from '../types.ts';
import { Memory } from '../memory/memory.ts';
import { openObjectiveIfAsked, bank, rowsAsFindings, describeBanked, readPagesAtOnce } from './collect.ts';
import { renderThread, type ConversationTurn } from './conversation.ts';
import { toActionRequest, describeTarget, describeAction, relocate, noBrowserObservation, needsBrowser, hostOf } from './actions.ts';
import { tryReplay } from './skill-pick.ts';
import { runConnectorAction } from './connector-actions.ts';
import { holdSensitive, runRecordAction, recordPrepared, typedAnswer } from './record-actions.ts';
import { FormQueue, pageChoices, type Fill } from './form-pass.ts';
import { ACTUATING, NO_EFFECT_FAILURES, REACHES_OUTSIDE, NEEDS_REASSERT } from './effect-rules.ts';
import { inRun } from '../lib/run-scope.ts';
import { challengeMessage, challengeNotice, detectChallenge, pausedUntil } from '../policy/challenge.ts';
import { parkedPages } from './run-pages.ts';
import { siteGuide } from '../jobs/site-guides.ts';
import { runDelegateAction, type Delegator } from './delegate-action.ts';
import type { DelegateEvent } from './delegate.ts';
import { Objectives, type Objective, type Progress } from './objective.ts';
import type { Jobs, ApplicationStatus } from '../jobs/jobs.ts';
import type { Profile } from '../jobs/profile.ts';
import type { Questions } from '../jobs/questions.ts';
import type { QuestionIntents } from '../jobs/intents.ts';
import type { CareerRecords } from '../jobs/career.ts';
import type { Workers } from '../workers/worker.ts';
import type { SitePolicies } from '../jobs/site-policies.ts';
import { carryOutCounted, heldNote, pressedOnStanding, standingNote, standingRefusalNow } from '../jobs/standing-approval.ts';
import { shielded } from '../policy/navigable.ts';
import { RunGuard, RunHalt, type HaltReason, type RunGuardOptions } from './run-guard.ts';

/**
 * Only the part of the model client the loop needs. Narrow on purpose: it
 * keeps the loop testable against a scripted model, and it is a reminder that
 * the loop asks for one structured decision and nothing else.
 */
export interface ModelLike {
  completeJson<T>(opts: CompleteOptions & { schema: NonNullable<CompleteOptions['schema']> }): Promise<Completion<T>>;
  /** A second answer-tier model, tried once when the first is busy or broken. */
  readonly answerFallback?: string | null;
}

export type AgentEvent =
  | { type: 'run_started'; runId: string; goal: string }
  | { type: 'observed'; step: number; url: string; nodes: number; tokens: number; ms: number }
  | { type: 'chose'; step: number; action: AgentAction; tier: Tier; ms: number; costUsd: number }
  /** `failure` is said for the person; `code` is the failure as the runtime named it. */
  | { type: 'acted'; step: number; ok: boolean; failure?: string; code?: string; ms: number }
  | { type: 'approval_required'; step: number; action: AgentAction; sensitivity: Sensitivity; why: string; approvalId?: string }
  | { type: 'rate_limited'; step: number; platform: string; action: string; why: string }
  | { type: 'documents_used'; step: number; titles: string[] }
  | { type: 'browser_opened'; step: number }
  | { type: 'progress'; step: number; found: number; target: number | null; added: number }
  | { type: 'fanout'; step: number; url: string; rows: number; error?: string; done: number; total: number }
  | { type: 'delegated'; step: number; event: DelegateEvent }
  | { type: 'worker_proposed'; step: number; workerId: string; name: string }
  | { type: 'application'; step: number; applicationId: string; status: ApplicationStatus; company: string; title: string }
  | { type: 'question_asked'; step: number; ids: number[]; fresh: number; company: string; title: string }
  | { type: 'finished'; status: RunOutcome; message: string; steps: number; costUsd: number };

export type RunOutcome =
  | 'done' | 'failed' | 'awaiting_approval' | 'step_limit' | 'rate_limited'
  /** Out of steps with the objective unmet, and still making progress. Resume. */
  | 'continuing';

export interface RunResult {
  runId: string;
  /** Set when the run was collecting toward a target. */
  progress?: Progress;
  status: RunOutcome;
  message: string;
  steps: number;
  costUsd: number;
  pendingAction?: AgentAction;
  /** Set when a site's pause or a sleeping display ended the run, not the task itself. */
  halted?: HaltReason;
}

export interface RunTaskOptions {
  goal: string;
  /**
   * The thread this task belongs to, oldest turn first.
   *
   * Shown to the model on every step. A run without it knows only its own
   * goal, so an answer to a question the agent has just asked arrives as a
   * sentence with no task in it.
   */
  conversation?: ConversationTurn[];
  /** Recorded on the run, so a thread can be reassembled from the database. */
  conversationId?: string;
  /**
   * Where collected rows are banked, deduped, and counted against a target.
   * Without it a run cannot know what an earlier one already found.
   */
  objectives?: Objectives;
  /**
   * The browser, or a function that produces one.
   *
   * A thunk means a task that only needs a connector never starts Chrome:
   * "What's on my calendar tomorrow" should not open a browser window.
   */
  page: BrowserRuntime | (() => Promise<BrowserRuntime>);
  model: ModelLike;
  store: Store;
  maxSteps?: number;
  policy?: PolicyContext;
  /** Tier for routine step selection. */
  tier?: Tier;
  /** Tier used after a failure, when the cheap read of the page was not enough. */
  recoveryTier?: Tier;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** When present, a blocked action is queued for review rather than dropped. */
  approvals?: Approvals;
  /**
   * When present, an active skill for the current site is attempted before
   * the model loop. This is the speed story: a hot path costs one model call
   * to select the skill and none to execute it.
   */
  memory?: Memory;
  /**
   * Enforced BEFORE each action, not summarised afterwards. A limit checked
   * after the fact is a report.
   */
  governor?: RateGovernor;
  /** Narrows which lessons are recalled. '*' means do not filter. */
  taskType?: string;
  /**
   * Non-browser actions. Only the ones actually present are offered to the
   * model, and anything else is refused — a connector that is not set up must
   * fail as unavailable rather than look like a broken browser action.
   */
  tools?: AgentTools;
  /**
   * Whether the user's documents may be consulted. 'auto' retrieves only on
   * a strong match; 'off' never touches them.
   */
  documents?: 'auto' | 'off';
  /** Jobs and applications. Without it record_application is refused. */
  jobs?: Jobs;
  /** Profile facts and the answer bank. Read on job tasks, written by the record actions. */
  profile?: Profile;
  /**
   * What answer_questions needs: the questions waiting for the user, each
   * wording's classification, the career records, and the model that may
   * classify, check and draft. Without `questions` the action is refused.
   */
  answering?: { questions: Questions; intents?: QuestionIntents; careers?: CareerRecords; model?: ModelLike | null };
  /** Where propose_worker lands. The proposal is never enabled from here. */
  workers?: Workers;
  /** Public job-board reads. Injectable for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Runs sub-agents in parallel. Absent for a sub-agent itself, so a
   * delegation is one level deep.
   */
  delegate?: Delegator;
  /** Stop once the run has cost this much. Checked before each model call. */
  budgetUsd?: number;
  /**
   * Which worker the applications this run records belong to, when that is
   * not the caller the policy is judged for. A submission approved in Review
   * runs under its own one-use grant but updates the worker's own row.
   */
  recordAs?: string | null;
  /** The answers the user approved on this application's Review card: their word for this form, whatever else Fanfold holds. */
  approved?: Array<{ question: string; answer: string }>;
  /**
   * Whether the goal is the user's own words (default), so a value it gives
   * is theirs to type. A sub-agent's goal was written by the lead model, and
   * only the conversation it carries counts.
   */
  goalFromUser?: boolean;
  /**
   * The document that is the user's résumé (the app's resumeDocument), which
   * the form pass attaches to a form's résumé field. Without it, nothing is
   * attached for the model.
   */
  resume?: () => { id: string; title: string } | null;
  /** Pace, pauses and display checks; the ones MCP sessions share unless a test gives its own. */
  guard?: RunGuardOptions;
  /** The job-site catalog the owner's standing yes is judged by; the policy's own when absent. */
  sites?: SitePolicies;
  /**
   * Every Submit waits for the person, whatever their standing yes to their
   * applications: a worker set to review everything, or one run once to be shown.
   * As a function, each Submit whose page it is true for: a site the worker is not given.
   */
  askFirst?: boolean | ((url: string) => boolean);
}

/** What the loop itself tells the model, and the person. */
export const COPY = {
  checkKept: 'This page shows a check for you to finish, so Fanfold keeps it open for you.',
  checkLeft: 'NOTE: the tab this task started in shows a check {host} put up for the user, left there by something earlier. '
    + 'It stays as it is, for the user. This task now works in a new, empty tab: do not switch back to that one.',
  otherKept: 'Another conversation’s task is waiting for you on this page, so Fanfold keeps it open for you.',
  askedStep: 'Waiting for your answer on Review: "{question}".',
  heldStep: 'Not typed into "{question}": Fanfold types only what it holds from you.',
  waitingOnReview: 'Waiting for your answer on Review: {questions}.',
  andMore: ', and {n} more',
  siteErrorNote: 'NOTE: the site answered that with an error page (HTTP {status}). What was sent did not go through: read the page and say so; never report it as done or sent.',
  siteErrorDone: 'The site answered with an error (HTTP {status}), so this probably didn’t go through.',
  noSite: 'No site answers at that address: it may not exist. Say so plainly; it tells you nothing about what the site has.',
  threeFailures: 'Fanfold stopped after three consecutive failures. The last: {last}',
  unknownOutcome: 'Fanfold stopped: the browser failed in the middle of a step, so it’s not clear if it went through. Check the page in the Fanfold window before trying again.',
  maySent: 'Fanfold stopped: the browser failed while it was doing that step, so whether it went through is unknown. Check the page in the Fanfold window before trying again.',
};

/** A message that already says something went wrong. */
const MENTIONS_ERROR = /\b(?:error|errors|fail|failed|failure|didn['’]t|did not|not go through|unsuccessful|rejected|refused)\b|\b[45]\d\d\b/i;

/** What a failed browser step means, said to the person. */
export function failureSaid(failure: string | undefined, detail = ''): string {
  const net = /net::ERR_([A-Z_]+)/.exec(detail)?.[1];
  if (net) return NET[net] ?? 'The page couldn’t be reached.';
  switch (failure) {
    case 'STALE_STATE': return 'The page changed before Fanfold could act, so it looked again.';
    case 'UNKNOWN_REF': return 'That part of the page was no longer there.';
    case 'TARGET_DRIFT': return 'That part of the page changed before Fanfold could act on it.';
    case 'NOT_ACTIONABLE': return 'That part of the page couldn’t be used: it was hidden, covered or turned off.';
    case 'NAVIGATION_LOST': return 'The page moved on while Fanfold was acting.';
    case 'TAB_LOST': return 'The tab Fanfold was working in closed.';
    case 'TIMEOUT': return 'The page took too long to answer.';
    case 'TRANSPORT_LOST': return 'The browser closed unexpectedly, so Fanfold opened it again.';
    case 'CDP_ERROR': return 'The browser couldn’t do that step.';
    default: return 'That step didn’t work.';
  }
}

const NET: Record<string, string> = {
  NAME_NOT_RESOLVED: 'That address couldn’t be reached: no site answers at it.',
  CONNECTION_REFUSED: 'Nothing answered at that address.',
  CONNECTION_TIMED_OUT: 'The site took too long to answer.',
  TIMED_OUT: 'The site took too long to answer.',
  INTERNET_DISCONNECTED: 'This computer is offline.',
  ADDRESS_UNREACHABLE: 'That address couldn’t be reached.',
  CERT_COMMON_NAME_INVALID: 'The site’s security certificate isn’t valid, so it wasn’t opened.',
  CERT_DATE_INVALID: 'The site’s security certificate has expired, so it wasn’t opened.',
  CERT_AUTHORITY_INVALID: 'The site’s security certificate isn’t valid, so it wasn’t opened.',
};

/** A navigation that failed because no site answers at the address. */
const unreachable = (detail?: string): boolean => /net::ERR_(?:NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_REFUSED)/.test(detail ?? '');

/** Goals that are about jobs read the profile at step 0. */
const JOB_GOAL = /\b(job|jobs|role|roles|position|positions|apply|applying|application|applications|hiring|career|careers|résumé|resume|cv|recruit|opening|openings|vacanc)/i;

/** The user's résumé, when there is one and its file can be attached. */
function theResume(resume: RunTaskOptions['resume'], memory: Memory | undefined): { id: string; title: string } | null {
  const cv = resume?.() ?? null;
  return cv && memory?.uploadableDocument(cv.id) ? cv : null;
}

/** A task that applies for a job: the form pass fills its form first. */
const APPLYING = /\b(?:apply|applying|application)\b/i;

/** The options of the radio group or the ticked boxes a field belongs to: its buttons do not carry them. */
function groupOptions(observation: Observation, field: ObservedNode): string[] | undefined {
  const group = field.evidence?.group;
  if (!group || (field.role !== 'radio' && field.role !== 'checkbox')) return undefined;
  return observation.nodes.filter((n) => n.role === field.role && n.evidence?.group === group && n.name)
    .map((n) => unwrapUntrustedForDisplay(n.name!)).slice(0, 20);
}

/** answer_questions with each question the page offers options for given its kind and options, so its answer must be one of them. */
function withPageChoices(action: AgentAction, observation: Observation): AgentAction {
  let data: { questions?: unknown } | null = null;
  try { data = JSON.parse(action.data ?? '') as { questions?: unknown }; } catch { return action; }
  if (!data || !Array.isArray(data.questions)) return action;
  const questions = data.questions.map((q: unknown) => {
    if (!q || typeof q !== 'object' || typeof (q as { question?: unknown }).question !== 'string') return q;
    const offered = pageChoices(observation, (q as { question: string }).question);
    return offered ? { ...q, kind: offered.kind, choices: offered.choices } : q;
  });
  return { ...action, data: JSON.stringify({ ...data, questions }) };
}

/** Steps from the limit at which the model is told to wrap up. */
const WRAP_UP_MARGIN = 3;

/** Failures in a row after which the run gives up. */
const MAX_CONSECUTIVE_FAILURES = 3;

export function runTask(opts: RunTaskOptions): Promise<RunResult> {
  const runId = randomUUID();
  // Whatever runs the loop (a chat task, a worker, a host's agent_run), it never reads Fanfold's own window.
  const given = opts.page;
  const guard = new RunGuard({ sites: opts.policy?.sites, ...opts.guard });
  // The page as given, before it is wrapped for this run: what earlier runs did in it is known by it.
  const raw: { page: BrowserRuntime | null } = { page: typeof given === 'function' ? null : given };
  const page = typeof given === 'function'
    ? async () => shielded(guard.wrap(raw.page = await given()))
    : shielded(guard.wrap(given));
  // Stopped by its caller, or by Fanfold closing (stopRuns).
  const stop = new AbortController();
  const passOn = (): void => stop.abort(opts.signal?.reason);
  if (opts.signal?.aborted) passOn();
  else opts.signal?.addEventListener('abort', passOn, { once: true });
  const going = { stop, store: opts.store };
  inFlight.add(going);
  return inRun(runId, () => runLoop({ ...opts, page, signal: stop.signal }, runId, guard, raw)).finally(() => {
    inFlight.delete(going);
    opts.signal?.removeEventListener('abort', passOn);
  });
}

/** Runs going in this process, by the store they record in, so closing Fanfold can stop its own with a reason. */
const inFlight = new Set<{ stop: AbortController; store: Store }>();

/** Why a run was stopped from outside its caller: Fanfold closing. Its message is the run's last word. */
export class RunsStopped extends Error {}

/** Stop every run recording in `store`, each ending with `why`. Returns how many were going. */
export function stopRuns(store: Store, why: string): number {
  const mine = [...inFlight].filter((r) => r.store === store);
  for (const r of mine) r.stop.abort(new RunsStopped(why));
  return mine.length;
}

/** How many runs recording in `store` are going. */
export function runsGoing(store: Store): number {
  return [...inFlight].filter((r) => r.store === store).length;
}

/** What a stopped run says: its caller's Stop is a cancel; Fanfold closing says so. */
const stoppedWith = (signal?: AbortSignal): string => (signal?.reason instanceof RunsStopped ? signal.reason.message : 'cancelled');

/** Which conversation's run last worked in each page, so a task never carries on with another conversation's work. */
const lastWork = new WeakMap<object, { conversationId: string; runId: string }>();

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/**
 * A Submit the owner's standing yes covers, let go and carried out in the run:
 * approved, pressed and counted as a host's is (mcp/approval.ts), and held to
 * the rate caps as every outbound action of a run is. What came of it, or why
 * it still waits for the person.
 */
async function sendOnStanding(
  deps: { store: Store; sites: SitePolicies; jobs?: Jobs; approvals: Approvals; memory?: Memory; governor?: RateGovernor },
  request: ApprovalRequest, page: BrowserRuntime, observation: Observation, action: AgentAction, sensitivity: Sensitivity, runId: string,
): Promise<{ outcome: ResumeOutcome } | { refusal: string | null }> {
  const refusal = await standingRefusalNow(deps, request, observation, () => page.observe());
  if (refusal) return { refusal };
  const { governor, approvals, memory } = deps;
  const activity = labelActivity(action, observation, sensitivity);
  const claim = governor && activity.outbound ? governor.reserve(activity.platform, activity.action, runId) : null;
  if (claim && !claim.ok) return { refusal: claim.why };
  const settle = (outcome: 'committed' | 'released' | 'unknown'): void => { if (claim) governor!.settle(claim.id, outcome); };
  if (!approvals.approve(request.id, undefined, standingNote(request))) {
    settle('released');
    return { refusal: null };
  }
  let outcome: ResumeOutcome;
  try {
    outcome = await carryOutCounted(approvals, page, request.id, { documents: memory, memory, sites: deps.sites, jobs: deps.jobs, store: deps.store });
  } catch (err) {
    // Thrown before anything was pressed.
    settle('released');
    throw err;
  }
  settle(outcome.performed ? 'committed' : outcome.reason === 'unknown' ? 'unknown' : 'released');
  return { outcome };
}

async function runLoop(opts: RunTaskOptions, runId: string, guard: RunGuard, raw: { page: BrowserRuntime | null } = { page: null }): Promise<RunResult> {
  const {
    goal, model, store,
    maxSteps = 30,
    policy = {},
    tier = 'plan',
    recoveryTier = 'plan',
    onEvent = () => {},
    signal,
    approvals,
    memory,
    governor,
    taskType = '*',
    documents = 'auto',
    tools,
    conversationId,
    objectives,
    jobs,
    profile,
    workers,
    answering,
  } = opts;

  // Rendered once: the thread does not change while a run is in flight, and
  // re-flattening it on all thirty steps would be work done thirty times.
  const conversation = renderThread(opts.conversation ?? []);

  // Opened before any work happens: a crash must leave a visible record.
  store.openRun(runId, goal, conversationId ?? null);
  onEvent({ type: 'run_started', runId, goal });

  const ctxCapabilities = policy.capabilities;
  const recordAs = opts.recordAs !== undefined ? opts.recordAs : policy.workerId ?? null;
  // On an application, a Submit the owner's standing yes covers goes in the run, as a host's does.
  const sites = opts.sites ?? policy.sites;
  const standing = taskType === 'job_application' && opts.askFirst !== true && approvals && sites
    ? { store, sites, jobs, approvals, memory, governor } : null;
  const askFirst = typeof opts.askFirst === 'function' ? opts.askFirst : (): boolean => false;
  // Resolved the first time a browser action is actually chosen.
  let page: BrowserRuntime | null = typeof opts.page === 'function' ? null : opts.page;
  const openBrowser = async (): Promise<BrowserRuntime> => {
    if (!page) page = typeof opts.page === 'function' ? await opts.page() : opts.page;
    return page;
  };
  const history: string[] = [];
  // On a job application run, what Fanfold holds goes into the form before the model is asked (form-pass.ts).
  // A chat task that is an application gets the same pass: the form is filled from what Fanfold holds, never left to the model's guesses.
  const applying = taskType === 'job_application' || (taskType === '*' && APPLYING.test(`${goal}\n${(opts.conversation ?? []).filter((t) => t.role === 'user').map((t) => t.text).join('\n')}`));
  const form = applying && jobs && profile && answering
    ? new FormQueue({
      jobs, profile, memory, questions: answering.questions, intents: answering.intents, careers: answering.careers,
      model: answering.model, approved: opts.approved, strict: true, signal,
      resume: theResume(opts.resume, memory),
    })
    : null;
  // What the user wrote for this task, in the goal and the conversation: a value they gave is theirs to type.
  const userWords = [...(opts.goalFromUser === false ? [] : [goal]), ...(opts.conversation ?? []).filter((t) => t.role === 'user').map((t) => t.text)].join('\n');
  let consecutiveFailures = 0;
  let totalCost = 0;
  let step = 0;
  let skillAttempted: string | null = null;
  let replayConsidered = false;
  let challengeNoted = false;
  /** This run has acted in its page: a check seen before that was left there by something earlier. */
  let touched = false;
  /** Questions this run filed for the person: its reply names them, so the chat shows what waits. */
  const askedHere = new Set<string>();
  /** The HTTP status of the error page the site answered this run's last press with, until a later page loads. */
  let siteError: number | null = null;
  const usedLessons: string[] = [];
  /** Where the run got to, for a message that has to be written after the loop. */
  let lastUrl = '';
  const toolNames = availableTools(tools);
  let docContext: Array<{ title: string; text: string }> = [];
  // Only on tasks about jobs: a profile is personal data and a task about
  // the weather has no business seeing it.
  const profileText = profile && JOB_GOAL.test(goal) ? profile.renderForPrompt() : '';

  // Resumed from the thread when one is already open, so a second run
  // continues the first one's count instead of starting again at zero.
  let objective: Objective | null =
    objectives && conversationId ? objectives.active(conversationId) : null;
  if (objective) store.setRunObjective(runId, objective.id);
  let addedThisRun = 0;

  const finish = (status: RunOutcome, said: string, pendingAction?: AgentAction, halted?: HaltReason): RunResult => {
    if (touched && raw.page && conversationId) lastWork.set(raw.page, { conversationId, runId });
    const waiting = [...askedHere].slice(0, 5).map((q) => `"${q}"`).join(', ') + (askedHere.size > 5 ? COPY.andMore.replace('{n}', String(askedHere.size - 5)) : '');
    const message = askedHere.size && (status === 'done' || status === 'awaiting_approval') ? `${said}\n\n${COPY.waitingOnReview.replace('{questions}', waiting)}` : said;
    // Whether a lesson helped is only knowable once the run ends. Recorded
    // against every lesson consulted, which is what shadow promotion needs.
    if (memory) {
      for (const id of new Set(usedLessons)) {
        memory.markLessonUsed(id, status === 'done');
        memory.recordLessonShadowRun(id, status === 'done');
      }
    }
    store.closeRun(
      runId,
      status === 'step_limit' || status === 'rate_limited' ? 'failed' : status === 'continuing' ? 'continued' : status,
      status === 'done' ? message : undefined,
      status === 'done' ? undefined : message,
    );
    const progress = objective && objectives ? objectives.progress(objective.id) ?? undefined : undefined;
    if (progress && status === 'done') objectives!.close(objective!.id, 'done');
    onEvent({ type: 'finished', status, message, steps: step, costUsd: totalCost });
    return { runId, status, message, steps: step, costUsd: totalCost, pendingAction, progress, ...(halted ? { halted } : {}) };
  };

  try {
    // A step the form pass supplies is not one of the model's: the run gets one more for each.
    for (step = 0; step < maxSteps + (form?.taken ?? 0); step++) {
      if (signal?.aborted) return finish('failed', stoppedWith(signal));
      if (opts.budgetUsd !== undefined && totalCost >= opts.budgetUsd) {
        return finish('rate_limited', `spend cap reached: this run has cost ${money(totalCost)} of the ${money(opts.budgetUsd)} it was allowed`);
      }

      // ---------------------------------------------------------- observe
      // With no browser open yet, the model is shown an empty page rather
      // than one being started for it. If it then chooses a browser action,
      // the browser is opened below and the next step observes for real.
      let observation = page ? await guard.observe(page, { interactive: false }) : noBrowserObservation();

      // ------------------------------------------------------- bot checks
      // A page that is nothing but a bot check ends the run: the site asked
      // for a person. One embedded in a usable page is noted once, and the
      // policy engine refuses any action on the check itself.
      let challenge = page ? detectChallenge(observation) : null;
      // One left from before this run is the person's to finish where it is:
      // the run goes on in a new tab, rather than every later task stopping at it.
      if (challenge?.kind === 'interstitial' && page && !touched && page.leaveTab) {
        const left = await page.leaveTab({ until: new Date(Date.now() + parkedPages.limitMs), why: COPY.checkKept }).catch(() => false);
        if (left) {
          history.push(COPY.checkLeft.replace('{host}', hostOf(observation.url)));
          observation = await guard.observe(page, { interactive: false });
          challenge = detectChallenge(observation);
        }
      }
      // A page another conversation's task left is that task's, not this one's to carry on with.
      const before = raw.page && !touched && conversationId ? lastWork.get(raw.page) : undefined;
      if (page && before && before.conversationId !== conversationId && !/^(?:about:|$)/.test(observation.url)) {
        touched = true;
        const waits = store.getRun(before.runId)?.status === 'awaiting_approval';
        const left = waits && page.leaveTab
          ? await page.leaveTab({ until: new Date(Date.now() + parkedPages.limitMs), why: COPY.otherKept }).catch(() => false)
          : await page.goto('about:blank').then(() => true, () => false);
        if (left) {
          observation = await guard.observe(page, { interactive: false });
          challenge = detectChallenge(observation);
        }
      }
      if (challenge?.kind === 'interstitial') {
        const site = policy.sites?.forUrl(observation.url);
        if (site && challenge.reason !== 'signin') policy.sites?.downgrade(site.key, new Date(), pausedUntil(challenge) ?? undefined, challenge.reason);
        const why = challengeNotice(challenge, hostOf(observation.url));
        store.recordStep({ runId, idx: step, url: observation.url, outcome: 'challenge', failure: challengeMessage(challenge, hostOf(observation.url)) });
        return finish('awaiting_approval', why, { kind: 'ask_user', reason: 'a bot check needs the user', message: why });
      }
      if (challenge && !challengeNoted) {
        challengeNoted = true;
        history.push(
          `NOTE: this page has a bot check ("${challenge.evidence}"). Do not touch it. Fill in everything else, `
          + 'then use ask_user to have the user complete the check and submit.',
        );
      }

      // ------------------------------------------------------ skill replay
      // Tried once, on the first REAL page observation, not on step 0: with
      // a lazy browser step 0 has no page at all, so keying this on the step
      // index would skip replay on every run that defers opening Chrome.
      if (memory && page && !replayConsidered && !skillAttempted) {
        replayConsidered = true;
        const attempt = await tryReplay(memory, page, goal, observation, model, policy);
        if (attempt) {
          touched = true;
          skillAttempted = attempt.skillId;
          totalCost += attempt.costUsd;
          if (attempt.result.ok) {
            store.recordStep({
              runId, idx: step, url: observation.url, action: `replay ${attempt.skillId}`,
              outcome: 'ok', costUsd: attempt.costUsd, actMs: attempt.result.ms,
            });
            onEvent({ type: 'acted', step, ok: true, ms: attempt.result.ms });
            return finish('done', `completed by replaying the learned skill ${attempt.skillId}`);
          }
          if (attempt.result.needsApproval) {
            store.setRunStatus(runId, 'awaiting_approval');
            return finish('awaiting_approval', attempt.result.needsApproval.why);
          }
          history.push(
            `replay of skill ${attempt.skillId} failed at step ${attempt.result.failure?.index}: ` +
            `${attempt.result.failure?.reason}`,
          );
        }
      }
      const rendered = renderObservation(observation);
      lastUrl = observation.url;
      // No browser open yet: there is no page to show the person under the step.
      if (page) onEvent({
        type: 'observed', step, url: observation.url,
        nodes: observation.nodes.length,
        tokens: Math.ceil(rendered.length / 4),
        ms: observation.totalMs,
      });

      // ---------------------------------------------------- the form pass
      // On an application form, the fields Fanfold holds answers for are
      // filled first, one queued action a step, with no model call. Each goes
      // through policy, the guard and act below exactly as a model's would.
      let queued: Fill | null = null;
      if (form && page) {
        const next = await form.next(observation);
        if (next.asked) {
          const { questions, ...asked } = next.asked;
          onEvent({ type: 'question_asked', step, ...asked });
          for (const q of questions) askedHere.add(q);
        }
        if (next.note) history.push(next.note);
        queued = next.fill;
      }

      // ----------------------------------------------------------- choose
      // After a failure the page read clearly was not sufficient, so spend
      // the better model rather than repeat a cheap mistake.
      const stepTier: Tier = consecutiveFailures > 0 ? recoveryTier : tier;

      // Only PROMOTED lessons reach a running task. The reflector's raw
      // output is never consulted here — that is the whole point of having a
      // gate rather than a notebook.
      const lessons = memory && !queued
        ? memory.recallLessons(hostOf(observation.url), taskType, `${goal} ${rendered.slice(0, 400)}`, 4)
        : [];
      if (lessons.length) usedLessons.push(...lessons.map((l) => l.id));

      // The user's documents are retrieved once, against the goal, and only
      // on a real match. BM25 always ranks something first, so without a
      // guard a task about the weather would pull a paragraph of someone's
      // resume in on one incidental word.
      //
      // The guard is the number of distinct query terms present, not a score
      // threshold: BM25 scores are relative to the corpus, so the same
      // relevance scores differently with one document than with fifty, and
      // an absolute floor would silently stop retrieving anything as the
      // library grows.
      if (memory && documents === 'auto' && step === 0) {
        // Two routes in, deliberately. A document the goal NAMES ("given my
        // resume") comes in on the strength of being named, because its text
        // says "TypeScript" and "Postgres" rather than "resume" and would fail
        // the overlap guard every time. Everything else must earn its place
        // by overlap, so a task about the weather still retrieves nothing.
        // The user's earlier turns count as naming one too: "carry on" after
        // "apply using my résumé" is still a task about that résumé.
        const asked = [goal, ...(opts.conversation ?? []).filter((t) => t.role === 'user').map((t) => t.text)].join('\n');
        const named = memory.documentsNamedIn(asked, 2);
        const searched = memory.searchDocuments(goal, 3, { minTerms: 2 });
        const seen = new Set<string>();
        // A document an agent added is kept and nothing more until the owner says it is theirs: no model reads it.
        const theirs = new Set(memory.listDocuments().filter((d) => d.trusted).map((d) => d.id));
        docContext = [...named, ...searched]
          .filter((d) => theirs.has(d.documentId) && !seen.has(d.chunkId) && seen.add(d.chunkId))
          .map((d) => ({ title: d.title, text: d.text }));
        if (docContext.length) {
          onEvent({ type: 'documents_used', step, titles: [...new Set(docContext.map((d) => d.title))] });
        }
      }

      const chooseStarted = Date.now();
      const limit = maxSteps + (form?.taken ?? 0);
      let action: AgentAction;
      let costUsd = 0;
      if (queued) action = queued.action;
      else try {
        const res = await model.completeJson<AgentAction>({
          tier: stepTier,
          maxTokens: STEP_MAX_TOKENS,
          schema: ACTION_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
          signal,
          messages: buildStepMessages({
            goal,
            conversation,
            progress: objective && objectives ? (() => {
              const p = objectives.progress(objective!.id)!;
              return {
                found: p.found, target: p.objective.targetCount, what: p.objective.what,
                recent: objectives.findings(objective!.id).slice(-6).map((f) => f.label),
              };
            })() : undefined,
            // Warned while it can still act, not told afterwards.
            stepsLeft: limit - step <= WRAP_UP_MARGIN ? limit - step : undefined,
            lessons: [...siteGuide(observation.url), ...lessons.map((l) => `${l.trigger} → ${l.lesson}`)],
            documents: docContext,
            // Only what can actually be attached right now. Offering a
            // document whose file has since been moved would produce an
            // upload that fails for a reason the model cannot see.
            attachable: memory?.uploadableDocuments().map((d) => ({ id: d.id, title: d.title })),
            tools: toolNames,
            profile: profileText || undefined,
            // The snapshot is page-authored text and is fenced as data. It is
            // the only place a hostile page can speak to the model.
            page: [fenceBlock(rendered, observation.url), ...snapshotNotes(observation)].join('\n'),
            history,
          }),
        });
        action = res.content;
        costUsd = res.usage.reportedCostUsd ?? res.usage.computedCostUsd;
        totalCost += costUsd;
        store.recordUsage(runId, res.usage);
      } catch (err) {
        // Stop pressed while the model was thinking: that is a cancel, not an outage.
        if (signal?.aborted) return finish('failed', stoppedWith(signal));
        store.recordStep({ runId, idx: step, url: observation.url, outcome: 'model_error', failure: (err as Error).message.slice(0, 300) });
        return finish('failed', `The model could not be reached: ${(err as Error).message}`);
      }
      const chooseMs = Date.now() - chooseStarted;
      // A stop pressed while the model was thinking takes effect before the
      // action it chose, not after it.
      if (signal?.aborted) return finish('failed', stoppedWith(signal));
      onEvent({ type: 'chose', step, action, tier: stepTier, ms: chooseMs, costUsd });

      // ------------------------------------------------- bank what it found
      if (objectives && conversationId) {
        if (!objective) {
          objective = openObjectiveIfAsked({ objectives, current: objective, action, conversationId, goal });
          if (objective) store.setRunObjective(runId, objective.id);
        }
        const rows = action.findings ?? [];
        if (objective && rows.length) {
          const { added, progress: p } = bank(objectives, objective, rowsAsFindings(objective, rows, observation.url), runId);
          addedThisRun += added;
          onEvent({ type: 'progress', step, found: p.found, target: p.objective.targetCount, added });
          history.push(describeBanked(added, rows.length, p));
        }
      }

      // ------------------------------------------------- record actions
      // The user's own records. No page, no policy question: nothing leaves
      // the machine except a read of a public jobs API.
      if (RECORD_KINDS.has(action.kind)) {
        // A question from a dropdown or a group of buttons is asked with its options, whatever kind the model gave it.
        if (action.kind === 'answer_questions') action = withPageChoices(action, observation);
        const outcome = await runRecordAction(action, {
          jobs, profile, workers, conversationId, workerId: recordAs, runId, step, onEvent,
          fetchImpl: opts.fetchImpl, pageUrl: observation.url, memory, answering, signal,
        });
        store.recordStep({
          runId, idx: step, url: observation.url, action: JSON.stringify(action),
          outcome: outcome.ok ? 'ok' : 'failed', failure: outcome.ok ? undefined : outcome.error,
          modelMs: chooseMs, costUsd,
        });
        onEvent({ type: 'acted', step, ok: outcome.ok, failure: outcome.ok ? undefined : outcome.error, ms: 0 });
        if (outcome.ok) {
          consecutiveFailures = 0;
          history.push(`${action.kind} -> ${outcome.summary}`);
        } else {
          consecutiveFailures++;
          history.push(`${action.kind} -> FAILED ${outcome.error}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish('failed', `three consecutive failures, last: ${outcome.error}`);
        }
        continue;
      }

      // ------------------------------------------------- sub-agents
      if (action.kind === 'delegate') {
        const out = await runDelegateAction(action, {
          delegate: opts.delegate, threadId: `${runId}:${step}`, signal,
          onEvent: (event) => onEvent({ type: 'delegated', step, event }),
        });
        const spent = out.outcome?.results.reduce((sum, r) => sum + r.costUsd, 0) ?? 0;
        totalCost += spent;
        store.recordStep({
          runId, idx: step, url: observation.url, action: JSON.stringify(action),
          outcome: out.ok ? 'ok' : 'failed', failure: out.ok ? undefined : out.summary,
          modelMs: chooseMs, costUsd: costUsd + spent,
        });
        onEvent({ type: 'acted', step, ok: out.ok, failure: out.ok ? undefined : out.summary, ms: 0 });
        if (!out.ok) {
          consecutiveFailures++;
          history.push(`delegate -> FAILED ${out.summary}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish('failed', `three consecutive failures, last: ${out.summary}`);
          continue;
        }
        consecutiveFailures = 0;
        // What a sub-agent reports was read off pages. It is data here too.
        history.push(`delegate -> ${fenceBlock(out.summary, 'sub-agents')}`);
        continue;
      }

      // --------------------------------------------- open a browser if asked
      // Before policy, not after: a browser action judged against an empty
      // page classifies as an unknown target and stops for approval, which
      // would make "open a browser" impossible to ask for.
      if (!page && needsBrowser(action.kind)) {
        try {
          await openBrowser();
        } catch (err) {
          const why = `could not open a browser: ${(err as Error).message}`;
          store.recordStep({
            runId, idx: step, url: observation.url, action: JSON.stringify(action),
            outcome: 'failed', failure: why, modelMs: chooseMs, costUsd,
          });
          return finish('failed', why);
        }
        history.push('opened a browser');
        onEvent({ type: 'browser_opened', step });
        /*
         * A `goto` is carried out NOW, in this step. It names a URL, not a
         * ref, so there is nothing about the empty placeholder page that
         * makes it unsafe to act on, and the model has already decided where
         * to go. Dropped, the model is shown a blank tab and, reading "my
         * inbox" in a goal that chose goto linkedin.com/messaging, asks the
         * person for credentials it never needed. Every other browser action
         * carries a ref from a page that does not exist, so those still wait
         * for the next step to observe the real one.
         */
        // A fan-out reads in tabs of its own and needs nothing of this page either: dropped, it costs the model a second choice of it.
        if (action.kind !== 'goto' && action.kind !== 'fanout') continue;
      }

      // ------------------------------------------------------ attachments
      // An upload names a DOCUMENT, never a path. The model chooses from what
      // the user imported, and this is the only place a filesystem path is
      // produced — so no prompt, page or clever reasoning step can talk the
      // agent into attaching ~/.ssh/id_rsa. Resolved before policy so an
      // unresolvable document costs nobody an approval.
      let attachment: { id: string; title: string; path: string } | null = null;
      if (action.kind === 'upload') {
        attachment = action.value ? (memory?.uploadableDocument(action.value) ?? null) : null;
        if (!attachment) {
          const why = unattachable(memory, action.value);
          consecutiveFailures++;
          history.push(`upload -> REFUSED. ${why}`);
          store.recordStep({
            runId, idx: step, url: observation.url, pageStateId: observation.pageStateId,
            observation: rendered, action: JSON.stringify(action),
            sensitivity: 'AMBIGUOUS_WRITE', allowed: false, modelMs: chooseMs, costUsd,
            outcome: 'blocked', failure: why,
          });
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish('failed', why);
          continue;
        }
      }

      // ------------------------------------------- the user's own answers
      // A sensitive question takes only what the user said, here or approved
      // for this form: what the model typed for one is checked against what
      // Fanfold holds from them. Nothing about the person is the model's guess
      // either (rule 1): a value for a question about them that does not trace
      // to what Fanfold holds is not typed, and the question waits for them.
      // Before policy, so a value that may not go in at all never becomes a card.
      if (jobs && (action.kind === 'fill' || action.kind === 'type' || action.kind === 'select' || action.kind === 'check')) {
        const field = action.ref ? observation.nodes.find((n) => n.ref === action.ref!.replace(/^@/, '')) : undefined;
        const held = field && (action.kind !== 'check' || field.role === 'radio' || field.role === 'checkbox')
          ? await holdSensitive(action, field, {
            jobs, profile, memory, answering, pageUrl: observation.url, approved: opts.approved, strict: true, said: userWords, choices: groupOptions(observation, field),
          }).catch(() => null)
          : null;
        if (held) {
          store.recordStep({
            runId, idx: step, url: observation.url, pageStateId: observation.pageStateId, observation: rendered, action: JSON.stringify(action),
            targetRole: field?.role ?? null, targetName: field?.name ? unwrapUntrustedForDisplay(field.name) : null,
            allowed: false, modelMs: chooseMs, costUsd, outcome: 'refused', failure: held.note,
          });
          if (held.ids.length) onEvent({ type: 'question_asked', step, ids: held.ids, fresh: held.fresh, company: held.company, title: held.title });
          // Said in the chat too: the step ends waiting on the person, and the reply names what waits.
          const question = typedAnswer(action, field)?.question ?? '';
          if (held.ids.length && question) askedHere.add(question);
          onEvent({
            type: 'acted', step, ok: false, ms: 0, code: held.ids.length ? 'ASKED' : 'HELD',
            failure: (held.ids.length ? COPY.askedStep : COPY.heldStep).replace('{question}', question),
          });
          history.push(`${describeAction(action)} -> ${held.note}`);
          if (!queued) consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish('failed', held.note);
          continue;
        }
      }

      // ----------------------------------------------------------- policy
      // Who this would reach is read from the page the agent is on, never
      // from a constant the caller supplied: a grant scoped to one person must
      // match the person this page actually addresses, and an undetermined
      // recipient means a person decides rather than a static value standing
      // in for one.
      const recipientEvidence = deriveRecipient(observation);
      const recipient = recipientEvidence?.id ?? null;
      let verdict = decide(action, observation, { ...policy, recipient });
      const held = attachment && memory && (verdict.allow || verdict.requiresApproval) ? uploadHold(memory, profile?.fact('name')?.value, attachment.id) : null;
      if (held) verdict = { allow: false, sensitivity: verdict.sensitivity, requiresApproval: true, why: held };

      /*
       * Never contact the same person twice.
       *
       * This is the rule the episodic table exists for: without it a worker
       * with a grant could message someone it messaged yesterday.
       * The check sits AFTER the policy verdict on purpose, so that a grant —
       * which can make an outbound action allowed — cannot make a repeat
       * allowed. A second contact is a decision for a person every time, and
       * the reason says when the first one happened.
       */
      let recipientKey: string | null = null;
      let knownContactAt: string | null = null;
      if (memory && verdict.sensitivity === 'CONTACT_EXTERNAL' && recipient) {
        recipientKey = memory.personKey(recipient);
        memory.surface({ identityKey: recipientKey, kind: 'person', displayName: recipientEvidence?.display, runId });
        const contactedAt = memory.contactedAt(recipientKey);
        // Only while CONTACT_EXTERNAL is gated: with no approval queue there
        // is nowhere for a held action to go. The effects journal still
        // suppresses a true duplicate, and the model asks before sending.
        if (contactedAt && policy.gate?.has('CONTACT_EXTERNAL') && !(verdict.allow === false && verdict.prepare)) {
          knownContactAt = memory.contactMark(recipientKey);
          verdict = {
            allow: false, sensitivity: verdict.sensitivity, requiresApproval: true,
            why: repeatContactWhy(recipientEvidence?.display ?? recipient, contactedAt),
          };
        } else if (contactedAt) {
          history.push(
            `NOTE: ${repeatContactWhy(recipientEvidence?.display ?? recipient, contactedAt)}.`,
          );
        }
      }

      // What the action is aimed at, in terms that outlive the observation.
      // A ref is a lease; role and name are how a person — or a replay —
      // finds the same control again.
      const targetNode = action.ref
        ? observation.nodes.find((n) => n.ref === action.ref!.replace(/^@/, ''))
        : undefined;

      const base = {
        runId, idx: step, url: observation.url, pageStateId: observation.pageStateId,
        observation: rendered, action: JSON.stringify(action),
        targetRole: targetNode?.role ?? null,
        targetName: targetNode?.name ? unwrapUntrustedForDisplay(targetNode.name) : null,
        sensitivity: verdict.sensitivity, allowed: verdict.allow,
        modelMs: chooseMs, costUsd,
      };

      if (!verdict.allow && verdict.prepare) {
        // The site's terms make the click the user's. The form is filled;
        // record the application as prepared so Review can open it at the
        // button, and stop. Nothing is queued for the agent to press later.
        store.recordStep({ ...base, outcome: 'prepared', failure: verdict.why });
        store.setRunStatus(runId, 'awaiting_approval');
        if (jobs) {
          const prepared = recordPrepared(jobs, observation, recordAs, runId);
          if (prepared) onEvent({ type: 'application', step, applicationId: prepared.id, status: 'prepared', company: prepared.company, title: prepared.title });
        }
        const message = `${verdict.why} It is waiting at ${observation.url}`;
        return finish('awaiting_approval', message, action);
      }

      if (!verdict.allow) {
        // The request captures the target semantically and the content
        // verbatim, so it can be honoured later against a page that has moved
        // on — see approvals.ts.
        const request = approvals?.request({
          runId, stepIdx: step, action, observation,
          sensitivity: verdict.sensitivity, why: verdict.why, priorContactAt: knownContactAt,
        });
        let why = verdict.why;
        // The run's own hold and a second contact are the person's to lift, whatever the standing yes covers.
        if (standing && request && verdict.requiresApproval && !verdict.ownHold && !knownContactAt && !askFirst(request.url)) {
          touched = true;
          const sent = await sendOnStanding(standing, request, await openBrowser(), observation, action, verdict.sensitivity, runId);
          if ('outcome' in sent) {
            const { outcome } = sent;
            store.recordStep({
              ...base, allowed: true,
              outcome: outcome.performed ? 'ok' : outcome.reason === 'unknown' ? 'unknown' : 'failed',
              failure: outcome.performed ? undefined : outcome.detail,
            });
            onEvent({ type: 'acted', step, ok: outcome.performed, failure: outcome.performed ? undefined : outcome.reason, ms: 0 });
            if (outcome.performed) {
              const done = standing.approvals.get(request.id);
              consecutiveFailures = 0;
              history.push(`${describeAction(action)} -> ${pressedOnStanding(done)}`);
              // Sent, not only the form opened: this run may say the application went.
              if (jobs && !openedFormOnly(done)) jobs.noteSubmitted(runId);
              continue;
            }
            // It may have reached someone: the run stops, as it does on any such press.
            if (outcome.reason === 'unknown') return finish('failed', `${describeAction(action)}: ${outcome.detail}. Nothing further was attempted.`);
            consecutiveFailures++;
            history.push(`${describeAction(action)} -> FAILED ${outcome.detail}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish('failed', `three consecutive failures, last: ${outcome.detail}`);
            continue;
          }
          // It was on and did not cover this one: the card and the run say why, in one sentence.
          const held = heldNote(sent.refusal);
          if (held) {
            why = `${why.replace(/\s*Needs your approval\.?$/i, '').replace(/[.\s]+$/, '')}. ${held}`;
            standing.approvals.amend(request.id, why);
          }
        }
        store.recordStep({ ...base, outcome: 'blocked', failure: why });
        store.setRunStatus(runId, 'awaiting_approval');
        onEvent({
          type: 'approval_required', step, action,
          sensitivity: verdict.sensitivity, why,
          approvalId: request?.id,
        });
        return finish('awaiting_approval', why, action);
      }

      // ------------------------------------------------------- terminals
      if (action.kind === 'done') {
        // Not the model's decision alone: asked for fifty and holding
        // fourteen, it would say so in the message and stop anyway. The count
        // decides.
        const p = objective && objectives ? objectives.progress(objective.id) : null;
        if (p && !p.satisfied) {
          store.recordStep({ ...base, outcome: 'refused', failure: `${p.found} of ${p.objective.targetCount}` });
          history.push(
            `done was refused: you have ${p.found} of ${p.objective.targetCount} ` +
            `${p.objective.what ?? 'items'} and ${p.remaining} are missing. ` +
            'Go to the next page, scroll for more, or widen the search. Do not report until you have them.',
          );
          consecutiveFailures = 0;
          continue;
        }
        store.recordStep({ ...base, outcome: 'done' });
        const said = action.message || action.reason;
        // A run whose last press the site answered with an error does not report it as gone through, whatever the model wrote.
        return finish('done', siteError && !MENTIONS_ERROR.test(said) ? `${COPY.siteErrorDone.replace('{status}', String(siteError))} ${said}` : said);
      }
      if (action.kind === 'ask_user') {
        store.recordStep({ ...base, outcome: 'ask_user' });
        return finish('awaiting_approval', action.message || action.reason, action);
      }

      // ------------------------------------------------------- parallel reads
      if (action.kind === 'fanout') {
        const out = await readPagesAtOnce({
          action, page: await openBrowser(), model, signal, step, onEvent,
          kind: objective?.what ?? undefined,
        });
        if (!out) {
          store.recordStep({ ...base, outcome: 'failed', failure: 'fanout with no urls' });
          history.push('fanout -> FAILED no urls were given');
          consecutiveFailures++;
          continue;
        }
        const { urls, failed } = out;
        totalCost += out.costUsd;

        let added = 0;
        if (objectives && objective && out.findings.length) {
          const banked = bank(objectives, objective, out.findings, runId);
          added = banked.added;
          addedThisRun += added;
          onEvent({ type: 'progress', step, found: banked.progress.found, target: banked.progress.objective.targetCount, added });
        }
        store.recordStep({
          ...base, outcome: failed.length === urls.length ? 'failed' : 'ok',
          failure: failed.length ? `${failed.length} of ${urls.length} could not be read` : undefined,
          actMs: out.ms, costUsd: costUsd + out.costUsd,
        });
        onEvent({ type: 'acted', step, ok: failed.length < urls.length, ms: out.ms });
        history.push(
          `fanout over ${urls.length} page(s) -> ${out.findings.length} row(s), ${added} new` +
          (failed.length ? `; ${failed.length} failed: ${failed[0].error}` : ''),
        );
        consecutiveFailures = failed.length === urls.length ? consecutiveFailures + 1 : 0;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish('failed', 'three consecutive failures, last: fanout read nothing');
        continue;
      }

      // ------------------------------------------------- connector actions
      // Handled before anything browser-shaped: they have no ref, no page
      // state and no capacity to claim, and their results are untrusted in
      // exactly the way page content is.
      if (CONNECTOR_KINDS.has(action.kind)) {
        const outcome = await runConnectorAction(tools, action);
        store.recordStep({
          ...base,
          outcome: outcome.ok ? 'ok' : 'failed',
          failure: outcome.ok ? undefined : outcome.error,
        });
        onEvent({ type: 'acted', step, ok: outcome.ok, failure: outcome.ok ? undefined : outcome.error, ms: 0 });

        if (outcome.ok) {
          consecutiveFailures = 0;
          history.push(
            `${action.kind} -> ${fenceBlock(outcome.summary, `connector:${action.kind}`)}`,
          );
        } else {
          consecutiveFailures++;
          history.push(`${action.kind} -> FAILED ${outcome.error}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return finish('failed', `three consecutive failures, last: ${outcome.error}`);
          }
        }
        continue;
      }

      // ------------------------------------------- claim capacity, then act
      // Both the grant budget and the rate cap are CLAIMED before the action
      // and settled after. Checking then acting is not a limit: two
      // concurrent runs can both pass a cap of one and both send.
      const activity = labelActivity(action, observation, verdict.sensitivity);

      /** Stop the run for a person, on a card that shows the page as `at` holds it. */
      const holdForApproval = (why: string, at: Observation = observation): RunResult => {
        store.recordStep({ ...base, outcome: 'blocked', failure: why });
        store.setRunStatus(runId, 'awaiting_approval');
        const card = approvals?.request({ runId, stepIdx: step, action, observation: at, sensitivity: verdict.sensitivity, why });
        onEvent({ type: 'approval_required', step, action, sensitivity: verdict.sensitivity, why, approvalId: card?.id });
        return finish('awaiting_approval', why, action);
      };

      let capabilityClaim: string | null = null;
      if (verdict.capability && ctxCapabilities) {
        const claim = ctxCapabilities.reserve({
          workerId: policy.workerId ?? null,
          url: observation.url,
          sensitivity: verdict.sensitivity,
          actionKind: action.kind,
          recipient,
        });
        if (!claim.ok) return holdForApproval(claim.reason);
        capabilityClaim = claim.capability.id;
      }

      let rateClaim: string | null = null;
      const settleClaims = (outcome: 'committed' | 'released' | 'unknown'): void => {
        if (rateClaim && governor) governor.settle(rateClaim, outcome);
        if (capabilityClaim && ctxCapabilities) {
          ctxCapabilities.settle(capabilityClaim, outcome, {
            runId, url: observation.url, action: action.kind,
            sensitivity: verdict.sensitivity, recipient,
          });
        }
      };
      if (governor && activity.outbound) {
        const claim = governor.reserve(activity.platform, activity.action, runId);
        if (!claim.ok) {
          // Give back the capability use: the action never happened.
          settleClaims('released');
          store.recordStep({ ...base, outcome: 'rate_limited', failure: claim.why });
          onEvent({ type: 'rate_limited', step, platform: activity.platform, action: activity.action, why: claim.why });
          return finish('rate_limited', claim.why, action);
        }
        rateClaim = claim.id;
      }

      // ---------------------------------------------------------- act
      // An action that can have an outside effect records its intent first,
      // under a key derived from what it is about to do. A crash between here
      // and the settle leaves exactly one row saying what may have happened.
      const actuating = ACTUATING.has(action.kind) && verdict.sensitivity !== 'READ';
      const effect = { runId, stepIdx: step, kind: action.kind, target: describeTarget(observation, action.ref), content: action.value };
      const key = actuating ? Store.idempotencyKey(effect) : null;
      if (key) {
        const { fresh, existing } = store.intendEffect(key, effect);
        if (!fresh && existing?.status === 'committed') {
          history.push(`${describeAction(action)} -> already done earlier in this run, skipped`);
          store.recordStep({ ...base, outcome: 'deduped' });
          settleClaims('released');
          continue;
        }
      }

      // -------------------------------- reassert the target before sending
      // For anything that reaches another person or cannot be undone, the
      // page is observed again immediately before the action and the
      // destination re-checked. A page that swaps the recipient between the
      // authorisation and the click is exactly why a grant is scoped to an
      // identity rather than a domain.
      let request = toActionRequest(action, observation.pageStateId);
      if (attachment) request = { ...request, files: [attachment.path], value: undefined };
      if (NEEDS_REASSERT.has(verdict.sensitivity) && action.ref) {
        const fresh = await (await openBrowser()).observe();
        const change = recipientChanged(recipient, deriveRecipient(fresh));
        if (change.changed) {
          settleClaims('released');
          return holdForApproval(change.why, fresh);
        }

        const relocated = relocate(observation, fresh, action.ref);
        if (!relocated) {
          const why = 'the control moved or became ambiguous between the check and the action';
          settleClaims('released');
          store.recordStep({ ...base, outcome: 'blocked', failure: why });
          store.setRunStatus(runId, 'awaiting_approval');
          onEvent({ type: 'approval_required', step, action, sensitivity: verdict.sensitivity, why });
          return finish('awaiting_approval', why, action);
        }
        request = { ...request, ref: relocated, pageStateId: fresh.pageStateId };
      }

      let result: ActionResult;
      touched = true;
      const acting = Date.now();
      try {
        result = await (await openBrowser()).act(request);
      } catch (err) {
        // The runtime threw rather than returning a typed failure, so whether
        // the action landed is unknown. Keep the capacity, record the doubt,
        // and say so — an unreconcilable effect must be visible, not implied
        // by a missing row.
        if (key) store.settleEffect(key, 'intended', `threw: ${(err as Error).message}`);
        settleClaims('unknown');
        store.recordStep({
          ...base, outcome: 'failed',
          failure: `the runtime threw during the action; its effect is unknown: ${(err as Error).message}`,
        });
        onEvent({ type: 'acted', step, ok: false, failure: failureSaid('CDP_ERROR'), code: 'CDP_ERROR', ms: 0 });
        return finish('failed', COPY.unknownOutcome);
      }

      // ------------------------------------------------- an unknown outcome
      //
      // The question is not which error arrived, it is whether the input
      // could already have been dispatched when it did. Only the failures in
      // NO_EFFECT_FAILURES are decided before anything is sent to the page;
      // a timeout, a replaced document, a protocol error and a lost transport
      // all leave the outcome genuinely unknown. A send that timed out,
      // journalled as "failed", would claim it provably did not happen, and
      // the model would go on to report it as sent.
      // Going to an address sends nothing anyone acts on: a goto that failed simply failed.
      const dispatched = !result.ok && action.kind !== 'goto' && !NO_EFFECT_FAILURES.has(result.failure ?? '');

      if (dispatched) {
        // The journal must not say it failed. It says nothing settled it,
        // which is the truth and is what surfaces for reconciliation.
        if (key) {
          store.settleEffect(key, 'intended', `outcome unknown (${result.failure}): ${result.detail ?? ''}`);
        }
        settleClaims('unknown');

        const description = `${describeAction(action)} (${result.failure})`;
        if (REACHES_OUTSIDE.has(verdict.sensitivity)) {
          // It may have reached a person, or spent money. Stop: an agent that
          // gets another turn here will narrate the uncertainty away, and no
          // wording in a prompt reliably prevents that.
          const why =
            `${description} may have taken effect and may not have; the outcome is unknown. ` +
            'Nothing further was attempted.';
          store.recordStep({ ...base, outcome: 'unknown', failure: why, actMs: result.ms });
          onEvent({ type: 'acted', step, ok: false, failure: failureSaid(result.failure, result.detail), code: result.failure, ms: result.ms });
          return finish('failed', COPY.maySent);
        }

        // Confined to this page. The run continues, because stopping on every
        // uncertain click would make the agent useless — but the history says
        // plainly that it is uncertain, so the model re-observes rather than
        // assuming.
        if (!queued) consecutiveFailures++;
        history.push(`${description} -> OUTCOME UNKNOWN. Re-observe; do not assume it worked or did not.`);
        store.recordStep({ ...base, outcome: 'unknown', failure: `${result.failure}: ${result.detail ?? ''}`, actMs: result.ms });
        onEvent({ type: 'acted', step, ok: false, failure: failureSaid(result.failure, result.detail), code: result.failure, ms: result.ms });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return finish('failed', COPY.threeFailures.replace('{last}', failureSaid(result.failure, result.detail)));
        }
        continue;
      }

      if (key) {
        store.settleEffect(
          key,
          result.ok ? 'committed' : 'failed',
          result.ok ? `navigated=${result.navigated}` : result.failure,
        );
      }
      settleClaims(result.ok ? 'committed' : 'released');
      if (result.ok && recipientKey && memory) {
        // The contact is recorded against evidence that it happened, not
        // against the intention. A second recordContact throws by design, and
        // that is not this run's failure to report.
        try { memory.recordContact(recipientKey, 'browser', action.value ?? describeAction(action)); } catch { /* already recorded */ }
      }

      onEvent({ type: 'acted', step, ok: result.ok, ...(result.ok ? {} : { failure: failureSaid(result.failure, result.detail), code: result.failure }), ms: result.ms });
      store.recordStep({
        ...base,
        outcome: result.ok ? 'ok' : 'failed',
        failure: result.ok ? undefined : `${result.failure}: ${result.detail ?? ''}`,
        actMs: result.ms,
      });

      // The site answered with an error page: the run is told so plainly, and does not report it as done.
      const answered = result.ok && result.navigated ? page?.documentResponse?.(acting) ?? null : null;
      if (answered && answered.status >= 400) {
        if (action.kind !== 'goto') siteError = answered.status;
        history.push(COPY.siteErrorNote.replace('{status}', String(answered.status)));
      } else if (result.ok && result.navigated) siteError = null;

      if (result.ok) {
        // What the form pass filled is told to the model in one line once its last action has run.
        if (queued) form!.landed(queued);
        else {
          consecutiveFailures = 0;
          history.push(describeAction(action));
        }
        // A press that sends, carried out: this run may say the application went.
        if (jobs && verdict.sensitivity === 'CONTACT_EXTERNAL' && (action.kind === 'click' || action.kind === 'press')) jobs.noteSubmitted(runId);
        // What was typed into a form is kept for the run, so the application it records shows what was filled;
        // the résumé Fanfold attached too, so the card shows which file went.
        const typed = jobs ? (queued && action.kind === 'upload' ? queued.given : typedAnswer(action, targetNode)) : null;
        if (typed) jobs!.noteGiven(runId, { url: observation.url }, [typed]);
      } else {
        if (!queued) consecutiveFailures++;
        // The failure goes into history verbatim. A model that cannot see why
        // the last action failed will repeat it, which is the cascading-error
        // loop these systems are known for.
        history.push(`${describeAction(action)} -> FAILED ${result.failure}: ${result.detail ?? ''}${unreachable(result.detail) ? ` ${COPY.noSite}` : ''}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return finish('failed', COPY.threeFailures.replace('{last}', failureSaid(result.failure, result.detail)));
        }
      }
    }

    // A site that pushed back on the last step ends the run, out of steps or not.
    guard.check();
    // Reached only when the wrap-up warning above did not persuade the model
    // to finish. Say where it got to: "ran out of steps" on its own tells the
    // person nothing they can act on.
    const p = objective && objectives ? objectives.progress(objective.id) : null;
    if (p && !p.satisfied && addedThisRun > 0) {
      // Still finding new rows, just out of steps. A run that made progress
      // is worth resuming; one that made none is stuck, and saying so beats
      // burning money in a loop.
      return finish('continuing',
        `${p.found} of ${p.objective.targetCount} ${p.objective.what ?? 'items'} so far — continuing.`);
    }
    return finish('step_limit', lastUrl
      ? `Stopped after ${maxSteps} steps without finishing. The last page was ${lastUrl}.`
      : `Stopped after ${maxSteps} steps without finishing.`);
  } catch (err) {
    if (signal?.aborted && !(err instanceof RunHalt)) return finish('failed', stoppedWith(signal));
    return finish('failed', (err as Error).message, undefined, err instanceof RunHalt ? err.reason : undefined);
  }
}
