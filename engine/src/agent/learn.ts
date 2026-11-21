/**
 * The learning lifecycle.
 *
 * Runs offline, on finished runs, never in the hot path. It is the only thing
 * that moves a lesson from "the reflector wrote it down" to "a running task
 * will act on it", and every step of that path is measured.
 *
 *   reflect  → propose lessons and skills from recent trajectories
 *   stage    → write them as `proposed`, which recall does not return
 *   gate     → measure each one case-by-case against the eval suite
 *   promote  → `active` only on positive evidence with no regression
 *
 * A lesson the suite cannot measure comes back `unproven` and stays out of
 * recall. The way in is not more confidence in the same evidence — it is new
 * evidence: cases derived from real runs where the agent failed and then
 * recovered on the same page. Those carry ground truth, and each learning
 * pass re-gates the unproven lessons against the enlarged suite.
 */

import type { ModelClient } from '../model/client.ts';
import type { Store } from '../store/db.ts';
import type { Memory } from '../memory/memory.ts';
import { reflect, stageProposals, type Reflection } from './reflect.ts';
import { gateLesson, gateSkillPromotion, measureBaseline, validateSkill } from '../eval/gate.ts';
import { deriveCasesFromRuns } from '../eval/derive-cases.ts';
import { loadCases, type EvalCase } from '../eval/action-eval.ts';

export interface LearnResult {
  reflectedRuns: number;
  proposed: { lessons: number; skills: number };
  gated: Array<{ id: string; trigger: string; status: string; why: string }>;
  /** Cases derived from real failures, which make new lessons measurable. */
  derivedCases: number;
  /** Previously-unproven lessons that the enlarged suite could now measure. */
  regated: Array<{ id: string; status: string; why: string }>;
  skillsRejected: Array<{ id: string; why: string }>;
  /** Shadowing skills checked for promotion this pass, and what the gate said. */
  skillsPromoted: Array<{ id: string; promoted: boolean; why: string }>;
  notes: string;
  costUsd: number;
}

export interface LearnOptions {
  model: ModelClient;
  store: Store;
  memory: Memory;
  /** Runs to reflect on. Defaults to the most recent finished ones. */
  runIds?: string[];
  maxRuns?: number;
  cases?: EvalCase[];
  /** Override the watermark. Mostly for tests and for a deliberate re-run. */
  since?: string | null;
  /** Skip the eval entirely; stage proposals without gating them. */
  stageOnly?: boolean;
  /**
   * Stop between candidates.
   *
   * Checked between gate calls rather than inside one: a full suite is the
   * unit of work here, and abandoning one halfway would leave a lesson
   * measured against a partial result. Everything already decided stands, and
   * the watermark does not advance, so the rest is picked up next pass.
   */
  signal?: AbortSignal;
}

/**
 * Reflect on recent runs and gate whatever comes out.
 *
 * Gating costs real model calls — a baseline plus one full suite per
 * candidate — which is exactly why this is a scheduled offline job and not
 * something that happens while a user waits.
 */
export async function learnFromRuns(opts: LearnOptions): Promise<LearnResult> {
  const { model, store, memory } = opts;
  const before = model.totalCostUsd();

  // Only runs that have not been reflected on already. Without a watermark
  // every restart reflects over the same window again, proposing the same
  // conclusions and spending a full eval suite per candidate on evidence that
  // has not changed.
  const watermark = memory.learningWatermark();
  const runIds = opts.runIds
    ?? recentFinishedRuns(store, opts.maxRuns ?? 10, opts.since ?? watermark.lastRunEndedAt, watermark.lastRunId);
  const result: LearnResult = {
    reflectedRuns: runIds.length,
    proposed: { lessons: 0, skills: 0 },
    gated: [],
    derivedCases: 0,
    regated: [],
    skillsRejected: [],
    skillsPromoted: [],
    notes: '',
    costUsd: 0,
  };
  if (!runIds.length) {
    result.notes = watermark.lastRunId
      ? 'no new finished runs since the last reflection'
      : 'no finished runs to learn from';
    return result;
  }
  /** The result, charged with what this pass spent. */
  const finished = (): LearnResult => {
    result.costUsd = model.totalCostUsd() - before;
    return result;
  };

  let reflection: Reflection;
  try {
    reflection = await reflect({ model, store, runIds });
  } catch (err) {
    // Deliberately does NOT advance the watermark: a reflection that failed
    // has not consumed these runs, and they should be tried again.
    result.notes = `reflection failed: ${(err as Error).message}`;
    return finished();
  }
  result.notes = reflection.notes;

  const { lessonIds, skillIds } = stageProposals(memory, reflection, runIds[0]);
  result.proposed = { lessons: lessonIds.length, skills: skillIds.length };

  // A proposed skill that cannot be replayed is rejected here rather than
  // spending a browser session discovering it.
  for (const id of skillIds) {
    const skill = memory.getSkill(id);
    if (!skill) continue;
    const check = validateSkill(skill);
    if (check.promoted) {
      memory.setSkillStatus(id, 'shadow');
    } else {
      memory.setSkillStatus(id, 'retired');
      result.skillsRejected.push({ id, why: check.why });
    }
  }

  // Skills already shadowing are asked whether they have earned promotion.
  for (const skill of memory.listSkills('shadow')) {
    const verdict = gateSkillPromotion(memory, skill.id);
    result.skillsPromoted.push({ id: skill.id, promoted: verdict.promoted, why: verdict.why });
  }

  // Cases derived from real failures in these runs. A lesson about how one
  // site behaves is usually invisible to a generic suite; this is what makes
  // it measurable, using a page the user actually hit rather than an invented
  // one.
  const derived = deriveCasesFromRuns(store, runIds);
  result.derivedCases = derived.length;
  const suite: EvalCase[] = [...(opts.cases ?? (await loadCases())), ...derived];

  if (opts.stageOnly || (!lessonIds.length && !derived.length)) {
    advance();
    return finished();
  }

  if (opts.signal?.aborted) {
    result.notes = 'stopped before gating; nothing was decided';
    return finished();
  }

  // One baseline for the whole batch; each candidate is measured against it.
  const baseline = await measureBaseline({ client: model, memory, cases: suite });
  for (const id of lessonIds) {
    if (opts.signal?.aborted) {
      result.notes = `stopped after ${result.gated.length} of ${lessonIds.length} candidates`;
      return finished();   // deliberately without advancing the watermark
    }
    const verdict = await gateLesson({ client: model, memory, lessonId: id, baseline, cases: suite });
    const lesson = memory.getLesson(id);
    result.gated.push({
      id,
      trigger: lesson?.trigger ?? '',
      status: lesson?.status ?? 'unknown',
      why: verdict.why,
    });
  }

  // Lessons the suite could not measure last time get another look now that
  // it has grown. This is the whole second chance: not more confidence in the
  // same evidence, but evidence that did not exist before.
  if (derived.length) {
    for (const lesson of memory.lessonsByStatus('unproven')) {
      if (opts.signal?.aborted) {
        // Some candidates were never looked at, so this pass did not finish
        // with these runs. advance() declines to claim them.
        result.notes = `stopped during re-gating after ${result.regated.length} promotion(s)`;
        return finished();
      }
      if (lessonIds.includes(lesson.id)) continue;
      const verdict = await gateLesson({ client: model, memory, lessonId: lesson.id, baseline, cases: suite });
      const after = memory.getLesson(lesson.id);
      if (after?.status !== 'unproven') {
        result.regated.push({ id: lesson.id, status: after?.status ?? 'unknown', why: verdict.why });
      }
    }
  }

  advance();
  return finished();

  /**
   * Move the watermark past the runs this pass consumed.
   *
   * Not called when reflection itself failed — those runs were not consumed
   * and should be tried again — and not when the caller named an explicit
   * batch, which is a deliberate re-run rather than progress.
   */
  function advance(): void {
    if (opts.runIds) return;
    // The guard lives here rather than at each return, because there are
    // several: an abort during reflection itself falls through the "nothing to
    // gate" path, which would otherwise claim the runs, so a cancelled pass
    // could skip a run permanently. A pass that did not finish has not
    // consumed anything.
    if (opts.signal?.aborted) return;
    const newest = newestRun(store, runIds);
    if (newest) memory.advanceLearningWatermark(newest.id, newest.endedAt);
  }
}

/**
 * Finished runs not yet reflected on, in COMPLETION order.
 *
 * Ordered by (ended_at, id) rather than start time. A long run that began
 * before a short one can finish after it, and a start-ordered cursor steps
 * past it permanently — so a browser task running for hours would never be
 * learned from at all.
 */
function recentFinishedRuns(
  store: Store, limit: number, sinceEndedAt: string | null, sinceRunId: string | null,
): string[] {
  const rows = sinceEndedAt
    ? store.raw.prepare(`
        SELECT id FROM runs
        WHERE status IN ('done', 'failed') AND steps > 0 AND ended_at IS NOT NULL
          AND (ended_at > ? OR (ended_at = ? AND id > ?))
        ORDER BY ended_at ASC, id ASC LIMIT ?
      `).all(sinceEndedAt, sinceEndedAt, sinceRunId ?? '', limit) as Array<{ id: string }>
    : store.raw.prepare(`
        SELECT id FROM runs
        WHERE status IN ('done', 'failed') AND steps > 0 AND ended_at IS NOT NULL
        ORDER BY ended_at ASC, id ASC LIMIT ?
      `).all(limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** The furthest point in completion order that this batch reached. */
function newestRun(store: Store, runIds: string[]): { id: string; endedAt: string } | null {
  let newest: { id: string; endedAt: string } | null = null;
  for (const id of runIds) {
    const run = store.getRun(id);
    if (!run?.ended_at) continue;
    const endedAt = String(run.ended_at);
    if (!newest || endedAt > newest.endedAt || (endedAt === newest.endedAt && id > newest.id)) {
      newest = { id, endedAt };
    }
  }
  return newest;
}
