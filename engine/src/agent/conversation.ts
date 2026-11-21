/**
 * The conversation: what the user has already told the agent.
 *
 * A run is one task. A conversation is the thread the tasks happen in.
 * Without one, every message opens a run that knows only its own goal: the
 * agent asks "are you signed in to LinkedIn?", the person answers "Yes I am
 * signed in", and that answer arrives as a brand-new goal. The agent reads it
 * literally and replies that it was told someone is signed in but given no
 * task. It is not being stupid; it has been handed a sentence with its
 * question cut off.
 *
 * Two things prevent that, and they are separate on purpose:
 *
 *  - The thread is shown to the model on every step, so what was already said
 *    is available to reason with. That alone is most of it.
 *  - A message answering a pending question does NOT become the goal. The
 *    goal stays the task; the answer joins the thread. Otherwise the run's
 *    GOAL line says "Yes I am signed in", and no amount of history rescues a
 *    goal that is not a task.
 */

import type { ConversationTurn } from '../store/db.ts';
import type { ModelLike } from './loop.ts';

export type { ConversationTurn };

/** What a new user message turns out to be. */
export interface Continuation {
  /**
   * 'answer' — it replies to a question the agent asked, so the task it was
   * already doing carries on.
   * 'task' — it is something to do.
   */
  kind: 'answer' | 'task';
  /** The goal the run should carry. */
  goal: string;
  /** One line, for the record and the UI. */
  why: string;
}

const CLASSIFIER_SCHEMA = {
  name: 'continuation',
  schema: {
    type: 'object',
    properties: {
      answers: {
        type: 'boolean',
        description: 'True when the message replies to the pending question rather than starting something else.',
      },
      why: { type: 'string', description: 'One short sentence.' },
    },
    required: ['answers', 'why'],
    additionalProperties: false,
  },
} as const;

/**
 * The classifier prompt.
 *
 * The default direction is deliberate: when the agent is the one waiting, a
 * reply is the likely reading, so ambiguity resolves to "answers". Getting
 * that wrong costs one step; the opposite costs the whole run.
 */
const CLASSIFIER_PROMPT = `A browser agent asked the user a question and stopped, mid-task. Decide what the user's new message is.

It ANSWERS the question when:
- it responds to what was asked, even indirectly or in one word ("yes", "I am now", "the second one", "go ahead")
- it supplies a detail the agent asked for
- it tells the agent to continue, retry, or proceed
- it corrects an assumption the agent made about the task it is doing

It is a NEW TASK when:
- it names something different to do
- it abandons the current work ("never mind", "forget it", "stop")
- it asks about something unrelated to the pending question

When it could be either, it ANSWERS: the agent asked, so a reply is the likely reading.

Reply only with JSON matching the schema.`;

export interface ResolveOptions {
  /** What the user just sent. */
  message: string;
  /** The question the agent is waiting on, if any. */
  pending: { text: string } | null;
  /** The task the thread is working on, if any. */
  activeGoal: string | null;
  /** Omit to decide structurally, without a model call. */
  model?: ModelLike;
  signal?: AbortSignal;
  /** Charged to the run that follows, when there is one. */
  onCost?: (usd: number) => void;
}

/**
 * Decide what a new message is, and what goal the run should carry.
 *
 * The model is consulted ONLY when a question is pending and there is a task
 * to carry on with — the one case where the answer changes anything. Every
 * other message is a task, decided structurally for free.
 */
export async function resolveContinuation(opts: ResolveOptions): Promise<Continuation> {
  const message = opts.message.trim();
  const task = (why: string): Continuation => ({ kind: 'task', goal: message, why });

  if (!opts.pending) return task('nothing was pending; this is a new task');
  if (!opts.activeGoal) return task('a question was pending but no task was recorded to carry on with');

  const answer = (why: string): Continuation => ({ kind: 'answer', goal: opts.activeGoal as string, why });

  if (!opts.model) return answer('a question was pending and no classifier was available');

  try {
    const res = await opts.model.completeJson<{ answers: boolean; why: string }>({
      tier: 'step',
      // A verdict and a sentence, but 200 tokens can run out before the JSON
      // closes, and a classifier that fails treats every new task as an answer.
      maxTokens: 1_000,
      schema: CLASSIFIER_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      signal: opts.signal,
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        {
          role: 'user',
          content: `THE TASK THE AGENT IS DOING\n${opts.activeGoal}\n\nWHAT THE AGENT ASKED\n${opts.pending.text}\n\nWHAT THE USER REPLIED\n${message}`,
        },
      ],
    });
    opts.onCost?.(res.usage.reportedCostUsd ?? res.usage.computedCostUsd);
    const why = (res.content.why || '').slice(0, 200);
    return res.content.answers
      ? answer(why || 'it answers the pending question')
      : task(why || 'it starts something else');
  } catch {
    // The classifier is an optimisation, never a gate. A model outage must
    // not turn a reply into a nonsense goal, which is the failure mode this
    // whole module is here to prevent — so it falls to the safe default.
    return answer('the classifier was unavailable; a pending question defaults to being answered');
  }
}

/**
 * The thread, as the model sees it.
 *
 * Long turns are clipped rather than dropped: what the user said matters more
 * than how much of it fits, and a truncated sentence still carries the
 * instruction. Returns null when there is nothing to show, so the prompt can
 * leave the section out entirely rather than print an empty heading.
 */
export function renderThread(turns: ConversationTurn[], maxChars = 600): string | null {
  if (!turns.length) return null;
  return turns
    .map((t) => {
      const text = t.text.length > maxChars ? `${t.text.slice(0, maxChars)}…` : t.text;
      return `${t.role === 'user' ? 'user' : 'you'}: ${text.replace(/\n+/g, ' ')}`;
    })
    .join('\n');
}

/**
 * A handle for the thread in the UI.
 *
 * The first message, shortened at a word boundary. Not a model call: a title
 * is worth nothing if it delays the work.
 */
export function titleFrom(message: string): string {
  const flat = message.trim().replace(/\s+/g, ' ');
  if (flat.length <= 60) return flat || 'New conversation';
  const cut = flat.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`;
}
