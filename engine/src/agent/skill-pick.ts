/**
 * Choosing a learned skill for the current site, and replaying it.
 */

import type { ModelLike } from './loop.ts';
import type { Memory } from '../memory/memory.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import type { PolicyContext } from '../policy/engine.ts';
import type { Observation } from '../types.ts';
import { replaySkill } from './replay.ts';

const SKILL_PICK_SCHEMA = {
  name: 'skill_choice',
  schema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'Exact id of a listed skill, or "" for none.' },
      params: { type: 'string', description: 'JSON object of parameter values, or "{}".' },
      reason: { type: 'string' },
    },
    required: ['skillId', 'params', 'reason'],
    additionalProperties: false,
  },
};

/**
 * Pick and replay a learned skill for this site, if one fits.
 *
 * One model call to match intent and extract parameters; the replay itself
 * costs nothing. Returns null when there is no candidate, so the caller can
 * tell "no skill" from "a skill that failed".
 */
export async function tryReplay(
  memory: Memory,
  page: BrowserRuntime,
  goal: string,
  observation: Observation,
  model: ModelLike,
  policy: PolicyContext,
): Promise<{ skillId: string; costUsd: number; result: Awaited<ReturnType<typeof replaySkill>> } | null> {
  let domain: string;
  try {
    domain = new URL(observation.url).hostname;
  } catch {
    return null;
  }

  const candidates = memory.listSkills('active').filter(
    (s) => domain === s.domain || domain.endsWith(`.${s.domain}`),
  );
  if (!candidates.length) return null;

  const listing = candidates
    .map((s) => `- ${s.id}: ${s.intent.replace(/_/g, ' ')} (parameters: ${s.params.join(', ') || 'none'})`)
    .join('\n');

  let choice: { skillId: string; params: string };
  let costUsd = 0;
  try {
    const res = await model.completeJson<{ skillId: string; params: string; reason: string }>({
      tier: 'step',
      maxTokens: 400,
      schema: SKILL_PICK_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      messages: [
        {
          role: 'system',
          content:
            'Pick the saved skill that accomplishes the goal exactly, and extract its parameters from the goal. ' +
            'Return "" for skillId unless a skill matches the whole goal — a partial match is worse than none, ' +
            'because it will do part of the job and report success.',
        },
        { role: 'user', content: `GOAL\n${goal}\n\nSAVED SKILLS FOR ${domain}\n${listing}` },
      ],
    });
    choice = res.content;
    costUsd = res.usage.reportedCostUsd ?? res.usage.computedCostUsd;
  } catch {
    return null;
  }

  const skill = candidates.find((s) => s.id === choice.skillId);
  if (!skill) return null;

  let params: Record<string, string> = {};
  try {
    params = JSON.parse(choice.params || '{}') as Record<string, string>;
  } catch {
    params = {};
  }

  const result = await replaySkill({ skill, params, page, memory, policy });
  return { skillId: skill.id, costUsd, result };
}
