/**
 * Skill replay: run a learned trajectory without the model.
 *
 * This is where the speed and the margin come from. A task that cost sixty
 * model calls the first time should cost none on the tenth, and the user gets
 * the same outcome either way.
 *
 * The reason replay is safe to do at all is that a skill step never names an
 * element by ref. It names it the way a person would — by role and accessible
 * name, optionally within a structural anchor — and the ref is resolved
 * against a fresh observation at replay time. A ref is a lease on one live
 * session; a skill outlives the session by definition.
 *
 * Checkpoints are what keep a stale skill from silently doing the wrong
 * thing. Every assertion is structural: a role present, a name present, a
 * count met, a URL shape. Deliberately NOT a screenshot hash — antialiasing,
 * an animation frame, an avatar, an ad or a timestamp all change the pixels
 * while the page is perfectly fine, so a pixel checkpoint is a false-negative
 * generator wired directly into the quarantine rule.
 */

import type { BrowserRuntime } from '../observe/runtime.ts';
import type { Memory, Skill, SkillStep } from '../memory/memory.ts';
import type { Observation, Ref } from '../types.ts';
import { unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { decide, type PolicyContext } from '../policy/engine.ts';

export interface ReplayResult {
  ok: boolean;
  stepsRun: number;
  ms: number;
  /** Which step failed, and why. Empty when ok. */
  failure?: { index: number; reason: string };
  /** Set when replay stopped because policy requires a person. */
  needsApproval?: { index: number; why: string };
}

export interface ReplayOptions {
  skill: Skill;
  params: Record<string, string>;
  page: BrowserRuntime;
  memory?: Memory;
  policy?: PolicyContext;
  /** Record the outcome against the skill's stats. Off for dry runs. */
  record?: boolean;
}

export async function replaySkill(opts: ReplayOptions): Promise<ReplayResult> {
  const { skill, params, page, memory, policy = {} } = opts;
  const started = Date.now();

  const missing = skill.params.filter((p) => params[p] === undefined);
  if (missing.length) {
    return finish(false, 0, { index: -1, reason: `missing parameters: ${missing.join(', ')}` });
  }

  let observation: Observation | null = null;

  for (const [index, step] of skill.steps.entries()) {
    if (step.act === 'goto') {
      if (!step.url) return finish(false, index, { index, reason: 'goto step has no url' });
      await page.goto(substitute(step.url, params));
      observation = await page.observe();
    } else if (step.act === 'press' || step.act === 'scroll') {
      observation ??= await page.observe();
      const result = await page.act({
        kind: step.act as 'press' | 'scroll',
        key: step.key,
        amount: step.act === 'scroll' ? Number(step.value ?? 500) : undefined,
      });
      if (!result.ok) return finish(false, index, { index, reason: `${step.act} failed: ${result.failure}` });
      observation = await page.observe();
    } else {
      observation ??= await page.observe();
      const located = locate(observation, step);
      if (!located.ok) return finish(false, index, { index, reason: located.reason });

      // Policy applies to a replayed action exactly as it does to a chosen
      // one. A skill is not a way to pre-authorise anything: the whole point
      // of putting policy outside the model is that it is outside everything.
      const verdict = decide(
        { kind: step.act as never, ref: located.ref, reason: `replay of ${skill.id} step ${index}` },
        observation,
        policy,
      );
      if (!verdict.allow) {
        if (opts.record !== false && memory) memory.recordSkillRun(skill.id, false, Date.now() - started, 'needs approval');
        return {
          ok: false, stepsRun: index, ms: Date.now() - started,
          needsApproval: { index, why: verdict.why },
        };
      }

      const result = await page.act({
        kind: step.act as never,
        ref: located.ref,
        pageStateId: observation.pageStateId,
        value: step.value === undefined ? undefined : substitute(step.value, params),
      });
      if (!result.ok) {
        return finish(false, index, { index, reason: `${step.act} failed: ${result.failure} ${result.detail ?? ''}` });
      }
      observation = await page.observe();
    }

    if (step.checkpoint) {
      const check = assertCheckpoint(observation!, step, params);
      if (!check.ok) return finish(false, index + 1, { index, reason: `checkpoint failed: ${check.reason}` });
    }
  }

  return finish(true, skill.steps.length);

  function finish(ok: boolean, stepsRun: number, failure?: ReplayResult['failure']): ReplayResult {
    const ms = Date.now() - started;
    if (opts.record !== false && memory) {
      memory.recordSkillRun(skill.id, ok, ms, failure?.reason);
    }
    return ok ? { ok, stepsRun, ms } : { ok, stepsRun, ms, failure };
  }
}

type LocateResult = { ok: true; ref: Ref } | { ok: false; reason: string };

/**
 * Resolve a semantic target against the live page.
 *
 * Ambiguity is a failure, not a coin flip. Two elements with the same role and
 * name means the skill's description is no longer specific enough for this
 * page, and picking one would be the exact silent-wrong-click the ref-lease
 * design exists to prevent.
 */
function locate(observation: Observation, step: SkillStep): LocateResult {
  const target = step.target;
  if (!target) return { ok: false, reason: `${step.act} step has no target` };

  const matches = observation.nodes.filter((n) => {
    if (n.role !== target.role) return false;
    const name = n.name ? unwrapUntrustedForDisplay(n.name) : '';
    return name === target.name;
  });

  if (matches.length === 1 && matches[0].ref) return { ok: true, ref: matches[0].ref };
  if (matches.length === 0) {
    return { ok: false, reason: `no ${target.role} named "${target.name}" on ${observation.url}` };
  }
  return {
    ok: false,
    reason: `${matches.length} elements match ${target.role} "${target.name}"; the skill is no longer specific enough`,
  };
}

function assertCheckpoint(
  observation: Observation, step: SkillStep, params: Record<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const cp = step.checkpoint!;

  if (cp.urlPattern) {
    const pattern = substitute(cp.urlPattern, params);
    if (!matchesUrl(observation.url, pattern)) {
      return { ok: false, reason: `url ${observation.url} does not match ${pattern}` };
    }
  }

  const candidates = observation.nodes.filter((n) => {
    if (cp.role && n.role !== cp.role) return false;
    if (cp.name) {
      const name = n.name ? unwrapUntrustedForDisplay(n.name) : '';
      if (!name.includes(substitute(cp.name, params))) return false;
    }
    return true;
  });

  const need = cp.minCount ?? (cp.role || cp.name ? 1 : 0);
  if (candidates.length < need) {
    return {
      ok: false,
      reason: `expected at least ${need} ${cp.role ?? 'element'}${cp.name ? ` named like "${cp.name}"` : ''}, found ${candidates.length}`,
    };
  }
  return { ok: true };
}

/** Glob with `*`. Kept trivial: a checkpoint is not a place for regex injection. */
function matchesUrl(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

function substitute(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    params[key] !== undefined ? params[key] : whole,
  );
}
