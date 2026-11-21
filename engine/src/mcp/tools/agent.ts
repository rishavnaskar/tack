/** Hand a whole task to Fanfold's own agent, which chooses its own steps. */
import { randomUUID } from 'node:crypto';
import { runTask } from '../../agent/loop.ts';
import { describeOutcome } from '../../agent/delegate-action.ts';
import type { SubTask } from '../../agent/delegate.ts';
import { shielded } from '../../policy/navigable.ts';
import { WINDOW_CLOSED } from '../../agent/approvals.ts';
import type { Tool } from '../protocol.ts';
import { SESSION_ARG, sessionFor, type FanfoldContext } from '../context.ts';

export function agentTools(ctx: FanfoldContext): Tool[] {
  const run: Tool = {
    name: 'agent_run',
    title: 'Delegate a task to Fanfold\'s own agent',
    description:
      'Give Fanfold a goal in plain words and let its own agent carry it out in a browser session, choosing every step itself. '
      + 'Worth it for long, routine work on one site ("fill this application from my profile"), or to run several tasks at once: '
      + 'open a session per task and call agent_run on each in parallel. Returns when the task ends, with what it found or where it stopped. '
      + 'For anything short, drive the browser yourself.',
    inputSchema: {
      type: 'object', required: ['goal'], additionalProperties: false,
      properties: {
        goal: { type: 'string', minLength: 5, maxLength: 4000, description: 'What to achieve, with everything needed to do it. The agent has not seen this conversation.' },
        max_steps: { type: 'integer', minimum: 3, maximum: 80, description: 'Default 30.' },
        session: SESSION_ARG,
      },
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    available: () => ctx.app.modelConfigured,
    run: async (args, call) => {
      const session = await sessionFor(ctx, args, call);
      return ctx.sessions.exclusive(session, async () => {
        let release: (() => void) | null = null;
        try {
          const result = await runTask({
            goal: String(args.goal),
            page: shielded(session.page),
            ...(await ctx.app.runContext()),
            policy: ctx.app.policy(null),
            maxSteps: typeof args.max_steps === 'number' ? args.max_steps : 30,
            signal: call.signal,
            onEvent: (e) => {
              ctx.emit(e as unknown as Record<string, unknown>);
              if (e.type === 'run_started') release = ctx.app.bindRun(e.runId, session.page);
              if (e.type === 'chose') {
                call.progress(`step ${e.step + 1}: ${e.action.kind}${e.action.reason ? `, ${e.action.reason}` : ''}`);
              }
            },
          });
          // An approval answered later still has to land on this page, for as long as the session is open.
          if (result.status === 'awaiting_approval') {
            const unbind = release as (() => void) | null;
            session.closing.signal.addEventListener('abort', () => {
              unbind?.();
              ctx.app.approvals.endFor(result.runId, WINDOW_CLOSED);
            }, { once: true });
            release = null;
          }
          const lines = [
            `status: ${result.status}`,
            `steps: ${result.steps}, cost in USD: ${result.costUsd.toFixed(4)}`,
            result.message,
          ];
          if (result.status === 'awaiting_approval') {
            lines.push('It stopped for the user. Anything waiting for approval is in Fanfold\'s Review queue.');
          }
          return { text: lines.join('\n'), isError: result.status === 'failed' };
        } finally {
          // The agent re-observed the page many times; the host's refs are gone.
          session.observation = null;
          (release as (() => void) | null)?.();
        }
      });
    },
  };

  const many: Tool = {
    name: 'agent_run_many',
    title: 'Run several tasks at once with Fanfold\'s agents',
    description:
      'Give Fanfold up to eight separate tasks and have each carried out by an agent of its own, on a tab of its own, all at the same time: '
      + 'apply to these four roles, check a price on five shops. A task can wait for another\'s result with dependsOn. '
      + 'Returns one short line per task. If a task needs an answer from the user, the result says so and gives a thread id; '
      + 'ask the user, then call this again with resume and answer.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        tasks: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', required: ['id', 'goal'], additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 24, description: 'A short name: letters, digits, "-" or "_".' },
              goal: { type: 'string', minLength: 5, maxLength: 4000, description: 'What to achieve, with everything needed. The agent has not seen this conversation.' },
              url: { type: 'string', maxLength: 2000, description: 'Where to start.' },
              dependsOn: { type: 'array', maxItems: 7, items: { type: 'string', maxLength: 24 }, description: 'Ids of tasks whose results this one needs first.' },
            },
          },
        },
        resume: { type: 'string', maxLength: 200, description: 'The thread id of a run that is waiting for an answer.' },
        answer: { type: 'string', maxLength: 4000, description: 'The user\'s answer, when resuming.' },
      },
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    available: () => ctx.app.modelConfigured,
    run: async (args, call) => {
      const resume = typeof args.resume === 'string' && args.resume ? args.resume : null;
      if (!resume && !Array.isArray(args.tasks)) throw new Error('give tasks to start, or resume and answer to continue');
      const outcome = await ctx.app.delegator()({
        threadId: resume ?? `host:${randomUUID()}`,
        tasks: resume ? undefined : (args.tasks as SubTask[]),
        answer: resume ? String(args.answer ?? '') : undefined,
        signal: call.signal,
        onEvent: (event) => {
          ctx.emit({ type: 'delegated', event });
          if (event.type === 'subtask_started') call.progress(`${event.taskId}: started`);
          if (event.type === 'subtask_finished') call.progress(`${event.taskId}: ${event.status.replace('_', ' ')}`);
        },
      }).catch((err: unknown) => {
        // A resume naming no run that stopped to ask: said in the host's terms, not the graph's.
        if (resume && /has no checkpoint/.test((err as Error).message)) {
          throw new Error(`no run "${resume}" is waiting for an answer. Use the id agent_run_many gave when it stopped to ask, or start the tasks again.`);
        }
        throw err;
      });
      const lines = [describeOutcome(outcome, (thread) =>
        `Ask the user, then call agent_run_many with resume "${thread}" and their answer.`)];
      if (outcome.results.some((r) => r.status === 'waiting_approval')) {
        lines.push('Tasks waiting for approval are in Fanfold\'s Review queue, with their pages kept open.');
      }
      // Every task failing is a failure, whatever the plan as a whole reports.
      const allFailed = outcome.results.length > 0 && outcome.results.every((r) => r.status === 'failed');
      return { text: lines.join('\n').trim(), isError: outcome.status === 'failed' || allFailed };
    },
  };

  return [run, many];
}
