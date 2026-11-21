/**
 * Replaying a recorded run.
 *
 * A trajectory is already stored for every run, and this makes it executable:
 * take what a run did and do it again, without the model. Two uses, both
 * ordinary — reproducing a failure while working on it, and checking that a
 * change to the agent did not change what a known task does.
 *
 * What it is NOT is a way around the safety rules. A replay re-derives the
 * policy verdict from the page in front of it now, and stops at anything that
 * needs a person, even though the recorded run may have had approval at the
 * time. An approval is for one action on one page, not a licence to repeat
 * it — and repeating an outbound action is precisely how something gets sent
 * twice.
 *
 * Targets are resolved the way skill replay resolves them: by role and
 * accessible name against a fresh observation. A recorded ref is a lease on
 * an observation that ended when the run did, so it can never be reused; the
 * loop records what the action was AIMED at so the trace stays meaningful.
 */

import type { BrowserRuntime } from '../observe/runtime.ts';
import type { Store } from '../store/db.ts';
import type { Ref, PageStateId, ActionRequest } from '../types.ts';
import { decide, type PolicyContext } from '../policy/engine.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import type { AgentAction } from './prompt.ts';
import { REACHES_OUTSIDE } from './effect-rules.ts';

export interface TraceStep {
  idx: number;
  url: string;
  kind: string;
  targetRole: string | null;
  targetName: string | null;
  value: string | null;
  sensitivity: string | null;
}

export interface TraceReplayResult {
  ok: boolean;
  runId: string;
  /** Steps actually performed. */
  replayed: number;
  /** Steps in the trace that were replayable at all. */
  replayable: number;
  /** Where it stopped, and why. Absent when everything ran. */
  stopped?: { idx: number; reason: 'needs_approval' | 'target_gone' | 'ambiguous' | 'failed'; detail: string };
  finalUrl: string;
}

/**
 * The steps of a run that can be replayed.
 *
 * A step is replayable when it acted on the page through a control that was
 * recorded by role and name. Everything else — a step that was blocked, a
 * connector call, a `done`, or anything from before the trace recorded what
 * it was aimed at — is skipped rather than guessed at.
 */
export function replayableSteps(store: Store, runId: string): TraceStep[] {
  const rows = store.steps(runId);
  const steps: TraceStep[] = [];
  for (const row of rows) {
    if (row.outcome !== 'ok') continue;
    let action: AgentAction;
    try {
      action = JSON.parse(String(row.action ?? '{}')) as AgentAction;
    } catch {
      continue;
    }
    const goto = action.kind === 'goto';
    if (!goto && (!row.target_role || !row.target_name)) continue;
    steps.push({
      idx: Number(row.idx),
      url: String(row.url ?? ''),
      kind: action.kind,
      targetRole: goto ? null : String(row.target_role),
      targetName: goto ? null : String(row.target_name),
      value: action.value ?? null,
      sensitivity: row.sensitivity ? String(row.sensitivity) : null,
    });
  }
  return steps;
}

export async function replayRun(opts: {
  store: Store;
  runId: string;
  page: BrowserRuntime;
  policy?: PolicyContext;
  /** Stop before performing anything that reaches beyond this page. Default true. */
  readOnly?: boolean;
}): Promise<TraceReplayResult> {
  const { store, runId, page } = opts;
  const steps = replayableSteps(store, runId);
  const result: TraceReplayResult = { ok: true, runId, replayed: 0, replayable: steps.length, finalUrl: '' };

  for (const step of steps) {
    if (step.kind === 'goto') {
      await page.goto(step.value ?? step.url);
      result.replayed++;
      continue;
    }

    // Each step starts where the recording says it was. A replay that drifts
    // onto another page and keeps clicking is worse than one that stops.
    let observation = await page.observe({ interactive: false });
    if (step.url && observation.url !== step.url) {
      await page.goto(step.url);
      observation = await page.observe({ interactive: false });
    }

    const matches = observation.nodes.filter(
      (n) => n.role === step.targetRole
        && (n.name ? unwrapUntrustedForDisplay(n.name) : null) === step.targetName,
    );
    if (matches.length === 0) {
      result.ok = false;
      result.stopped = {
        idx: step.idx, reason: 'target_gone',
        detail: `no ${step.targetRole} named ${JSON.stringify(step.targetName)} on ${observation.url}`,
      };
      break;
    }
    if (matches.length > 1) {
      // The recording cannot say which one, and guessing on a replay is how a
      // reproduction quietly stops reproducing the thing it was for.
      result.ok = false;
      result.stopped = {
        idx: step.idx, reason: 'ambiguous',
        detail: `${matches.length} controls now match ${step.targetRole} ${JSON.stringify(step.targetName)}`,
      };
      break;
    }

    const action = {
      kind: step.kind, ref: matches[0].ref ?? undefined, value: step.value ?? undefined, reason: 'replay',
    } as AgentAction;

    // Judged against the page as it is NOW. The verdict recorded during the
    // run described a page that no longer exists.
    const verdict = decide(action, observation, opts.policy ?? {});
    if (!verdict.allow || (opts.readOnly !== false && REACHES_OUTSIDE.has(verdict.sensitivity))) {
      result.ok = false;
      result.stopped = {
        idx: step.idx, reason: 'needs_approval',
        detail: `${step.kind} on ${step.targetRole} ${JSON.stringify(step.targetName)} is ${verdict.sensitivity}: ${verdict.why}`,
      };
      break;
    }

    const request: ActionRequest = {
      kind: step.kind as ActionRequest['kind'],
      ref: matches[0].ref as Ref,
      pageStateId: observation.pageStateId as PageStateId,
      value: step.value ?? undefined,
    };
    const performed = await page.act(request);
    if (!performed.ok) {
      result.ok = false;
      result.stopped = {
        idx: step.idx, reason: 'failed',
        detail: `${performed.failure}: ${performed.detail ?? ''}`,
      };
      break;
    }
    result.replayed++;
  }

  result.finalUrl = (await page.observe().catch(() => null))?.url ?? '';
  return result;
}
