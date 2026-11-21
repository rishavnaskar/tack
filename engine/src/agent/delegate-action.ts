/** The lead agent's `delegate` action: turn its payload into sub-agents and their results into one reply. */
import type { AgentAction } from './prompt.ts';
import { parseData, text } from './record-actions.ts';
import type { DelegateEvent, DelegateOutcome, SubTask } from './delegate.ts';

export type Delegator = (a: {
  threadId: string;
  tasks?: SubTask[];
  answer?: string;
  signal?: AbortSignal;
  onEvent?(event: DelegateEvent): void;
}) => Promise<DelegateOutcome>;

export interface DelegateActionResult {
  ok: boolean;
  /** What the lead agent reads back. */
  summary: string;
  outcome?: DelegateOutcome;
}

function toTasks(value: unknown): SubTask[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      id: text(t.id, 24),
      goal: text(t.goal, 4000),
      ...(text(t.url, 2000) ? { url: text(t.url, 2000) } : {}),
      ...(Array.isArray(t.dependsOn) ? { dependsOn: t.dependsOn.map((d) => text(d, 24)).filter(Boolean) } : {}),
    }));
}

/** How the lead agent continues a paused delegation. A host with other tools words it differently. */
const RESUME_WITH_DELEGATE = (threadId: string): string =>
  'Ask the user those questions with ask_user. When they reply, '
  + `continue with delegate and data {"resume":"${threadId}","answer":"<their words>"}.`;

export function describeOutcome(outcome: DelegateOutcome, howToResume = RESUME_WITH_DELEGATE): string {
  const lines = outcome.results.map((r) => `${r.id}: ${r.status.replace('_', ' ')}. ${r.summary}`);
  if (outcome.status === 'needs_answer') {
    lines.push('Some tasks are waiting for the user\'s answer.');
    lines.push(howToResume(outcome.threadId));
  }
  if (outcome.status === 'failed') lines.push(`The delegation stopped: ${outcome.error ?? 'unknown error'}`);
  if (outcome.status === 'cancelled') lines.push('The delegation was cancelled before every task ran.');
  return lines.join('\n');
}

export async function runDelegateAction(
  action: AgentAction,
  ctx: { delegate?: Delegator; threadId: string; signal?: AbortSignal; onEvent?(event: DelegateEvent): void },
): Promise<DelegateActionResult> {
  if (!ctx.delegate) {
    return { ok: false, summary: 'delegate is not available here: a sub-agent cannot start sub-agents of its own. Do the work yourself.' };
  }
  const data = parseData(action);
  if (!data) return { ok: false, summary: 'delegate needs a JSON object in data: {"tasks":[{"id":"a","goal":"..."}]}' };

  const resume = text(data.resume, 200);
  const outcome = resume
    ? await ctx.delegate({ threadId: resume, answer: text(data.answer, 4000), signal: ctx.signal, onEvent: ctx.onEvent })
    : await ctx.delegate({ threadId: ctx.threadId, tasks: toTasks(data.tasks), signal: ctx.signal, onEvent: ctx.onEvent });

  if (outcome.status === 'failed' && !outcome.results.length) {
    return { ok: false, summary: `delegate was refused: ${outcome.error ?? 'unknown error'}`, outcome };
  }
  return { ok: true, summary: describeOutcome(outcome), outcome };
}
