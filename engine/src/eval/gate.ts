/**
 * The promotion gate.
 *
 * Learning proposes; evals promote. Nothing the reflector writes takes effect
 * until it has been measured not to make the agent worse — because the
 * failure mode of a self-improving system is not that it stops improving, it
 * is that it degrades while reporting success.
 *
 * Measured, not argued: a lesson is promoted only if accuracy on the eval
 * suite with the lesson present is at least as good as without it. A lesson
 * that sounds wise and costs a point is rejected, and the reason is recorded.
 */

import { ModelClient } from '../model/client.ts';
import { Memory, type Skill } from '../memory/memory.ts';
import { loadCases, runEval, type EvalCase, type EvalReport } from './action-eval.ts';
import type { Tier } from '../model/pricebook.ts';
import { screenLesson } from '../memory/screen.ts';

export interface GateResult {
  promoted: boolean;
  why: string;
  baseline?: { passed: number; total: number };
  candidate?: { passed: number; total: number };
}

export interface GateOptions {
  client: ModelClient;
  memory: Memory;
  tier?: Tier;
  cases?: EvalCase[];
  /** A cached baseline report, to avoid re-running it per candidate. */
  baseline?: EvalReport;
}

export async function measureBaseline(opts: GateOptions): Promise<EvalReport> {
  const cases = opts.cases ?? (await loadCases());
  return runEval(opts.client, opts.tier ?? 'plan', cases);
}

/**
 * Gate one proposed lesson.
 *
 * Compares CASE BY CASE, not on the total. A single 19/20 both ways says
 * almost nothing: it is equally consistent with a lesson that fixed one case
 * and broke another, and with a lesson the model ignored entirely. The first
 * should be examined; the second must not be promoted, because an inert
 * falsehood still costs tokens on every step and still waits to matter under
 * a different model.
 *
 * Outcomes:
 *   rejected  — the safety screen refused it, or any case regressed.
 *   active    — at least one case it plausibly applies to improved.
 *   unproven  — nothing changed. Stays out of recall; the route in is shadow
 *               evidence from real runs, since the eval demonstrably cannot
 *               measure this one.
 */
export async function gateLesson(
  opts: GateOptions & { lessonId: string },
): Promise<GateResult> {
  const cases = opts.cases ?? (await loadCases());
  const tier = opts.tier ?? 'plan';

  const lesson = opts.memory.getLesson(opts.lessonId);
  if (!lesson) return { promoted: false, why: `no such lesson: ${opts.lessonId}` };

  const screen = screenLesson(`${lesson.trigger} ${lesson.lesson}`);
  if (!screen.promoted) {
    opts.memory.setLessonStatus(opts.lessonId, 'rejected', screen.why);
    opts.memory.retireLesson(opts.lessonId, screen.why);
    return screen;
  }

  const baseline = opts.baseline ?? (await runEval(opts.client, tier, cases));
  const candidate = await runEval(opts.client, tier, cases, {
    lessons: [`${lesson.trigger} → ${lesson.lesson}`],
  });

  const before = new Map(baseline.results.map((r) => [r.name, r.pass]));
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const r of candidate.results) {
    const was = before.get(r.name);
    if (was === undefined) continue;
    if (was && !r.pass) regressions.push(r.name);
    if (!was && r.pass) improvements.push(r.name);
  }

  if (regressions.length) {
    const why = `rejected: broke ${regressions.length} case(s) that passed without it — ${regressions.join('; ')}`;
    opts.memory.setLessonStatus(opts.lessonId, 'rejected', why);
    opts.memory.retireLesson(opts.lessonId, why);
    return { promoted: false, why, baseline: brief(baseline), candidate: brief(candidate) };
  }

  if (!improvements.length) {
    const why =
      'unproven: no case behaved differently with it, so the suite cannot show this lesson ' +
      'is either useful or harmless. It stays out of recall until real runs provide evidence.';
    opts.memory.setLessonStatus(opts.lessonId, 'unproven', why);
    return { promoted: false, why, baseline: brief(baseline), candidate: brief(candidate) };
  }

  const why = `improved ${improvements.length} case(s) and broke none — ${improvements.join('; ')}`;
  opts.memory.setLessonStatus(opts.lessonId, 'active', why);
  return { promoted: true, why, baseline: brief(baseline), candidate: brief(candidate) };
}

function brief(r: EvalReport): { passed: number; total: number } {
  return { passed: r.passed, total: r.total };
}

/**
 * Structural checks a skill must pass before it is even allowed to shadow.
 *
 * These are cheap and catch the proposals that cannot possibly work, so that
 * shadow runs — which cost a real browser session — are spent on plausible
 * candidates.
 */
export function validateSkill(skill: Skill): GateResult {
  if (!skill.steps.length) return { promoted: false, why: 'a skill with no steps is not a skill' };

  for (const [i, step] of skill.steps.entries()) {
    if (step.target && !(step.target.role && step.target.name)) {
      return { promoted: false, why: `step ${i} names an element without both a role and an accessible name` };
    }
    // Refs are session-scoped leases. A skill is replayed in a different
    // session by definition, so a ref here can never resolve.
    if (JSON.stringify(step).match(/"e\d+"/)) {
      return { promoted: false, why: `step ${i} contains a session ref, which cannot survive replay` };
    }
  }

  const hasCheckpoint = skill.steps.some((s) => s.checkpoint);
  if (!hasCheckpoint) {
    return { promoted: false, why: 'no checkpoint: a replay with nothing to assert cannot detect that it went wrong' };
  }

  const declared = new Set(skill.params);
  const used = new Set<string>();
  for (const step of skill.steps) {
    for (const m of JSON.stringify(step).matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]);
  }
  for (const p of used) {
    if (!declared.has(p)) return { promoted: false, why: `step uses {{${p}}}, which is not a declared parameter` };
  }
  return { promoted: true, why: 'structurally valid; eligible for shadow runs' };
}

/**
 * Promote a skill from shadow to active.
 *
 * Requires evidence from real shadow runs, not a structural check: the point
 * of shadowing is that a skill can be perfectly well-formed and still not work
 * on the live site.
 */
export function gateSkillPromotion(
  memory: Memory,
  skillId: string,
  opts: { minRuns?: number; minSuccessRate?: number } = {},
): GateResult {
  const minRuns = opts.minRuns ?? 5;
  const minRate = opts.minSuccessRate ?? 0.9;

  const skill = memory.getSkill(skillId);
  if (!skill) return { promoted: false, why: `no such skill: ${skillId}` };

  const structural = validateSkill(skill);
  if (!structural.promoted) return structural;

  if (skill.status !== 'shadow') {
    return { promoted: false, why: `skill is ${skill.status}; only a shadowing skill can be promoted` };
  }
  if (skill.runs < minRuns) {
    return { promoted: false, why: `only ${skill.runs} shadow runs; ${minRuns} required` };
  }
  const rate = skill.successes / skill.runs;
  if (rate < minRate) {
    return { promoted: false, why: `shadow success rate ${(rate * 100).toFixed(0)}% is below ${(minRate * 100).toFixed(0)}%` };
  }

  memory.setSkillStatus(skillId, 'active', { evalPassed: true });
  return { promoted: true, why: `${skill.successes}/${skill.runs} shadow runs succeeded` };
}
