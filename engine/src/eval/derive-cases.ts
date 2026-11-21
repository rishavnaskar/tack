/**
 * Turn real failures into eval cases.
 *
 * This is the honest answer to a problem the gate creates for itself. A
 * lesson about how one site behaves is often true and touches none of the
 * twenty cases, so it comes back `unproven` and stays out of recall.
 *
 * The route in is to make the lesson measurable: when a run failed at a
 * step and then recovered on the same page, that trajectory contains ground
 * truth. The page as it was, the action that failed, and the action that
 * actually worked. That is exactly an eval case, and unlike an invented one
 * it comes from a page the user really hit.
 *
 * Refs cannot be carried across observations — they are leases — so the
 * action that worked is matched back to the failing page by its role and
 * accessible name, the same way a skill step is resolved.
 */

import type { Store } from '../store/db.ts';
import type { EvalCase } from './action-eval.ts';

interface StepRow {
  idx: number;
  url: string | null;
  observation: string | null;
  action: string | null;
  outcome: string | null;
  failure: string | null;
}

interface ParsedNode {
  role: string;
  name: string | null;
  ref: string | null;
}

/** Action kinds that act on a specific control, so a case must name one. */
const TARGETED_KINDS = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover']);

/** One rendered observation line: `  - button "Search" [ref=e7] [submits]` */
const LINE = /^\s*-\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:.*?\[ref=(\w+)\])?/;

export function parseObservation(rendered: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  for (const line of rendered.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    nodes.push({
      role: m[1],
      name: m[2] === undefined ? null : m[2].replace(/\\"/g, '"'),
      ref: m[3] ?? null,
    });
  }
  return nodes;
}

export interface DerivedCase extends EvalCase {
  /** Where this came from, so a surprising case can be traced back. */
  derivedFrom: { runId: string; failedStep: number; recoveredStep: number };
}

/**
 * Build cases from runs where the agent failed and then recovered.
 *
 * Deliberately conservative. A case is only produced when the recovery
 * happened on the same URL and the successful action's target can be located
 * on the failing page — otherwise "what it should have done" is a guess, and
 * a guessed case in a gate is worse than no case.
 */
export function deriveCasesFromRuns(store: Store, runIds: string[], limit = 20): DerivedCase[] {
  const cases: DerivedCase[] = [];

  for (const runId of runIds) {
    const run = store.getRun(runId);
    if (!run) continue;
    const steps = store.steps(runId) as unknown as StepRow[];

    for (const [i, failed] of steps.entries()) {
      if (cases.length >= limit) return cases;
      if (failed.outcome !== 'failed' || !failed.observation || !failed.url || !failed.action) continue;

      // The next successful action on the same page is what should have
      // happened instead.
      const recovered = steps.slice(i + 1).find(
        (s) => s.outcome === 'ok' && s.url === failed.url && s.action && s.observation,
      );
      if (!recovered) continue;

      let failedAction: { kind?: string; ref?: string };
      let goodAction: { kind?: string; ref?: string };
      try {
        failedAction = JSON.parse(failed.action) as { kind?: string; ref?: string };
        goodAction = JSON.parse(recovered.action!) as { kind?: string; ref?: string };
      } catch {
        continue;
      }
      if (!goodAction.kind) continue;

      // Same kind and same target means nothing was learned — the action just
      // worked the second time, which is a flake rather than a lesson.
      if (goodAction.kind === failedAction.kind && goodAction.ref === failedAction.ref) continue;

      // What the recovery actually clicked, named semantically. A ref cannot
      // cross observations, so the control is identified by role and name.
      const accept: EvalCase['accept'] = [{ kind: goodAction.kind }];
      if (goodAction.ref) {
        const target = parseObservation(recovered.observation!).find((n) => n.ref === goodAction.ref);
        if (!target) continue;

        const onFailingPage = parseObservation(failed.observation).filter(
          (n) => n.role === target.role && n.name === target.name && n.ref,
        );
        // If the control the agent recovered with was not present — or was
        // ambiguous — on the failing page, then what should have happened
        // there is not determined by this trajectory. A case that accepts any
        // click on any control is worse than no case: it would grade a click
        // on the wrong button as a recovery, and promote a lesson for it.
        if (onFailingPage.length !== 1) continue;

        accept[0].ref = onFailingPage[0].ref!;
        accept[0].role = target.role;
        if (target.name !== null) accept[0].name = target.name;
      } else if (TARGETED_KINDS.has(goodAction.kind)) {
        // A targeted action with no recorded ref cannot be asserted at all.
        continue;
      }

      cases.push({
        name: `recovered: ${goodAction.kind} after ${failed.failure ?? 'a failure'} (${runId.slice(0, 8)}#${failed.idx})`,
        why:
          'Derived from a real run: this action failed here and the agent recovered with a different one. ' +
          'The page and both actions are recorded, so what should have happened is observed rather than invented.',
        goal: String(run.goal),
        page: failed.observation,
        history: steps.slice(0, i).map((s, n) => `${n + 1}. ${s.action} -> ${s.outcome}`),
        accept,
        derivedFrom: { runId, failedStep: failed.idx, recoveredStep: recovered.idx },
      });
    }
  }
  return cases;
}
