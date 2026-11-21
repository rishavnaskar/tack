/**
 * One browser action, taken under the same rules whoever chose it.
 *
 * The agent loop applies these checks inline for its own model. A caller that
 * brings its own model, such as an MCP host, goes through this instead, so
 * site terms, the approval gate, grants, rate caps, the effects journal and
 * the recipient re-check all apply to it identically.
 */
import { decide, pressActivates, type PolicyContext } from '../policy/engine.ts';
import { deriveRecipient, recipientChanged, repeatContactWhy } from '../policy/recipient.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { unattachable } from '../policy/import-hold.ts';
import { labelActivity } from '../workers/classify-action.ts';
import type { RateGovernor } from '../workers/governor.ts';
import { Store } from '../store/db.ts';
import { Memory } from '../memory/memory.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import type { ActionResult, Observation, Sensitivity } from '../types.ts';
import type { Jobs } from '../jobs/jobs.ts';
import type { Approvals } from './approvals.ts';
import type { AgentAction } from './prompt.ts';
import { toActionRequest, describeTarget, describeAction, relocate } from './actions.ts';
import { recordPrepared } from './record-actions.ts';
import { ACTUATING, NO_EFFECT_FAILURES, REACHES_OUTSIDE, NEEDS_REASSERT } from './effect-rules.ts';

export interface GovernDeps {
  store: Store;
  approvals: Approvals;
  policy: PolicyContext;
  memory?: Memory;
  governor?: RateGovernor;
  jobs?: Jobs;
  /** Why attaching this document waits for the owner, or null (policy/upload-hold.ts). */
  uploadHold?: (documentId: string) => string | null;
}

export interface GovernInput {
  page: BrowserRuntime;
  /** The observation the action was chosen against. Its refs are the lease. */
  observation: Observation;
  action: AgentAction;
  runId: string;
  step: number;
  /** Told of each fresh look taken here at the same document, so a caller holding its refs keeps a current lease. */
  observed?: (fresh: Observation) => void;
}

export type Governed =
  | { status: 'ok'; sensitivity: Sensitivity; result: ActionResult }
  /** Provably did nothing: the target could not be resolved. */
  | { status: 'failed'; sensitivity: Sensitivity; failure: string; detail: string }
  /** May or may not have landed. `stop` means it could have reached beyond the page. */
  | { status: 'unknown'; sensitivity: Sensitivity; failure: string; detail: string; stop: boolean }
  | { status: 'needs_approval'; sensitivity: Sensitivity; why: string; approvalId: string }
  /** The site's terms make this click the user's. */
  | { status: 'prepare'; sensitivity: Sensitivity; why: string; applicationId?: string }
  | { status: 'refused'; sensitivity: Sensitivity; why: string };

export async function governAct(deps: GovernDeps, input: GovernInput): Promise<Governed> {
  const { store, approvals, policy, memory, governor, jobs } = deps;
  const { page, action, runId, step } = input;
  const capabilities = policy.capabilities;
  const look = async (): Promise<Observation> => {
    const sameDocument = page.lastObservation !== null;
    const fresh = await page.observe();
    if (sameDocument) input.observed?.(fresh);
    return fresh;
  };

  // Enter and Space go to whatever has focus when they are pressed, which a
  // look taken before a Tab, a click or a page script moved it does not show.
  const observation = action.kind === 'press' && pressActivates(action.key) ? await look() : input.observation;

  let attachment: { id: string; title: string; path: string } | null = null;
  if (action.kind === 'upload') {
    attachment = action.value ? (memory?.uploadableDocument(action.value) ?? null) : null;
    if (!attachment) {
      const why = unattachable(memory, action.value);
      store.recordStep({
        runId, idx: step, url: observation.url, pageStateId: observation.pageStateId,
        action: JSON.stringify(action), sensitivity: 'AMBIGUOUS_WRITE', allowed: false,
        outcome: 'blocked', failure: why,
      });
      return { status: 'refused', sensitivity: 'AMBIGUOUS_WRITE', why };
    }
  }

  const recipientEvidence = deriveRecipient(observation);
  const recipient = recipientEvidence?.id ?? null;
  let verdict = decide(action, observation, { ...policy, recipient });
  const held = attachment && (verdict.allow || verdict.requiresApproval) ? deps.uploadHold?.(attachment.id) : null;
  if (held) verdict = { allow: false, sensitivity: verdict.sensitivity, requiresApproval: true, why: held };

  // After the verdict, so a grant cannot make a second contact allowed.
  let recipientKey: string | null = null;
  let knownContactAt: string | null = null;
  if (memory && verdict.sensitivity === 'CONTACT_EXTERNAL' && recipient) {
    recipientKey = memory.personKey(recipient);
    memory.surface({ identityKey: recipientKey, kind: 'person', displayName: recipientEvidence?.display, runId });
    const contactedAt = memory.contactedAt(recipientKey);
    if (contactedAt && policy.gate?.has('CONTACT_EXTERNAL') && !(verdict.allow === false && verdict.prepare)) {
      knownContactAt = memory.contactMark(recipientKey);
      verdict = {
        allow: false, sensitivity: verdict.sensitivity, requiresApproval: true,
        why: repeatContactWhy(recipientEvidence?.display ?? recipient, contactedAt),
      };
    }
  }

  const sensitivity = verdict.sensitivity;
  const targetNode = action.ref
    ? observation.nodes.find((n) => n.ref === action.ref!.replace(/^@/, ''))
    : undefined;
  const base = {
    runId, idx: step, url: observation.url, pageStateId: observation.pageStateId,
    action: JSON.stringify(action),
    targetRole: targetNode?.role ?? null,
    targetName: targetNode?.name ? unwrapUntrustedForDisplay(targetNode.name) : null,
    sensitivity, allowed: verdict.allow,
  };

  const askPerson = async (why: string, at: Observation = observation): Promise<Governed> => {
    store.recordStep({ ...base, outcome: 'blocked', failure: why });
    store.setRunStatus(runId, 'awaiting_approval');
    const request = approvals.request({
      runId, stepIdx: step, action, observation: at, sensitivity, why,
      // Only the card whose reason is the earlier contact told its reader about it.
      priorContactAt: why === verdict.why ? knownContactAt : null,
      // The card shows the form as it is now: a host that chained actions
      // without looking holds an older picture of it.
      live: at === observation ? await page.observe().catch(() => null) : at,
      standing: true,
    });
    return { status: 'needs_approval', sensitivity, why, approvalId: request.id };
  };

  if (!verdict.allow && verdict.prepare) {
    store.recordStep({ ...base, outcome: 'prepared', failure: verdict.why });
    const prepared = jobs ? recordPrepared(jobs, observation, policy.workerId ?? null, runId) : null;
    return {
      status: 'prepare', sensitivity,
      why: `${verdict.why} It is waiting at ${observation.url}`,
      applicationId: prepared?.id,
    };
  }
  if (!verdict.allow && !verdict.requiresApproval) {
    store.recordStep({ ...base, outcome: 'blocked', failure: verdict.why });
    return { status: 'refused', sensitivity, why: verdict.why };
  }
  if (!verdict.allow && action.kind === 'press') {
    // An approval is carried out on the control it names, and a key names none:
    // the card could never be acted on. The control itself can be clicked.
    const why = `${verdict.why.replace(/\.?\s*Needs your approval\.?$/i, '')}. A key press cannot be approved: `
      + 'click the control it would press, such as the form\'s Submit, and the user is asked about that';
    store.recordStep({ ...base, outcome: 'blocked', failure: why });
    return { status: 'refused', sensitivity, why };
  }
  if (!verdict.allow) return askPerson(verdict.why);

  // Claimed before the action and settled after: checking then acting is not
  // a limit when two sessions run at once.
  const activity = labelActivity(action, observation, sensitivity);
  let capabilityClaim: string | null = null;
  if (verdict.capability && capabilities) {
    const claim = capabilities.reserve({
      workerId: policy.workerId ?? null, url: observation.url, sensitivity,
      actionKind: action.kind, recipient,
    });
    if (!claim.ok) return askPerson(claim.reason);
    capabilityClaim = claim.capability.id;
  }

  let rateClaim: string | null = null;
  const settleClaims = (outcome: 'committed' | 'released' | 'unknown'): void => {
    if (rateClaim && governor) governor.settle(rateClaim, outcome);
    if (capabilityClaim && capabilities) {
      capabilities.settle(capabilityClaim, outcome, {
        runId, url: observation.url, action: action.kind, sensitivity, recipient,
      });
    }
  };

  if (governor && activity.outbound) {
    const claim = governor.reserve(activity.platform, activity.action, runId);
    if (!claim.ok) {
      settleClaims('released');
      store.recordStep({ ...base, outcome: 'rate_limited', failure: claim.why });
      return { status: 'refused', sensitivity, why: claim.why };
    }
    rateClaim = claim.id;
  }

  // Intent is journalled first, so a crash between here and the settle
  // leaves one row saying what may have happened.
  const actuating = ACTUATING.has(action.kind) && sensitivity !== 'READ';
  const effect = { runId, stepIdx: step, kind: action.kind, target: describeTarget(observation, action.ref), content: action.value };
  const key = actuating ? Store.idempotencyKey(effect) : null;
  if (key) store.intendEffect(key, effect);

  let request = toActionRequest(action, observation.pageStateId);
  if (attachment) request = { ...request, files: [attachment.path], value: undefined };

  if (NEEDS_REASSERT.has(sensitivity) && action.ref) {
    const fresh = await look();
    const change = recipientChanged(recipient, deriveRecipient(fresh));
    if (change.changed) {
      settleClaims('released');
      if (key) store.settleEffect(key, 'failed', change.why);
      return askPerson(change.why, fresh);
    }
    const relocated = relocate(observation, fresh, action.ref);
    if (!relocated) {
      const why = 'the control moved or became ambiguous between the check and the action';
      settleClaims('released');
      if (key) store.settleEffect(key, 'failed', why);
      store.recordStep({ ...base, outcome: 'blocked', failure: why });
      return { status: 'failed', sensitivity, failure: 'TARGET_DRIFT', detail: why };
    }
    request = { ...request, ref: relocated, pageStateId: fresh.pageStateId };
  }

  let result: ActionResult;
  try {
    result = await page.act(request);
  } catch (err) {
    const detail = `the runtime threw during the action; its effect is unknown: ${(err as Error).message}`;
    if (key) store.settleEffect(key, 'intended', `threw: ${(err as Error).message}`);
    settleClaims('unknown');
    store.recordStep({ ...base, outcome: 'failed', failure: detail });
    return { status: 'unknown', sensitivity, failure: 'CDP_ERROR', detail, stop: REACHES_OUTSIDE.has(sensitivity) };
  }

  const dispatched = !result.ok && !NO_EFFECT_FAILURES.has(result.failure ?? '');
  if (dispatched) {
    const detail = `${describeAction(action)} (${result.failure}) may have taken effect and may not have`;
    if (key) store.settleEffect(key, 'intended', `outcome unknown (${result.failure}): ${result.detail ?? ''}`);
    settleClaims('unknown');
    store.recordStep({ ...base, outcome: 'unknown', failure: `${result.failure}: ${result.detail ?? ''}`, actMs: result.ms });
    return {
      status: 'unknown', sensitivity, failure: result.failure ?? 'UNKNOWN', detail,
      stop: REACHES_OUTSIDE.has(sensitivity),
    };
  }

  if (key) {
    store.settleEffect(key, result.ok ? 'committed' : 'failed', result.ok ? `navigated=${result.navigated}` : result.failure);
  }
  settleClaims(result.ok ? 'committed' : 'released');
  if (result.ok && recipientKey && memory) {
    try { memory.recordContact(recipientKey, 'browser', action.value ?? describeAction(action)); } catch { /* already recorded */ }
  }
  store.recordStep({
    ...base, outcome: result.ok ? 'ok' : 'failed',
    failure: result.ok ? undefined : `${result.failure}: ${result.detail ?? ''}`, actMs: result.ms,
  });

  return result.ok
    ? { status: 'ok', sensitivity, result }
    : { status: 'failed', sensitivity, failure: result.failure ?? 'UNKNOWN', detail: result.detail ?? '' };
}
