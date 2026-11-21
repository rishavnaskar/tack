/**
 * Several sub-agents at once, each on its own page, then one merged result.
 *
 * The lead agent names a few independent tasks. Each runs as its own agent
 * loop with its own context and its own tab, so three applications or four
 * price checks take roughly the time of one. A task can depend on another's
 * result. Each reports back a short summary, not its transcript: the lead's
 * context stays small however much work the sub-agents did.
 *
 * It is a graph so that the work survives a pause. A sub-agent that needs an
 * answer from the user stops only itself; the others finish, the run is
 * checkpointed, and the answer resumes exactly the task that asked.
 */
import { END, StateGraph, send, type CompiledGraph } from '../graph/graph.ts';
import type { Checkpointer } from '../graph/checkpoint.ts';
import type { BrowserRuntime, Tab } from '../observe/runtime.ts';
import type { ConversationTurn } from './conversation.ts';
import type { AgentEvent, RunResult } from './loop.ts';

const MAX_SUBTASKS = 8;
const SUMMARY_LIMIT = 600;

export interface SubTask {
  id: string;
  /** Everything the sub-agent needs. It has not seen the lead's conversation. */
  goal: string;
  /** Where to start, when known. */
  url?: string;
  /** Tasks whose results this one needs first. */
  dependsOn?: string[];
}

export type SubStatus = 'done' | 'failed' | 'skipped' | 'waiting_approval' | 'needs_answer';

export interface SubResult {
  id: string;
  status: SubStatus;
  summary: string;
  runId?: string;
  steps: number;
  costUsd: number;
}

interface State {
  tasks: SubTask[];
  /** null clears a result so the task runs again. */
  results: Record<string, SubResult | null>;
  /** What a paused task asked, and what the user said. */
  answers: Record<string, { question: string; answer: string }>;
}

export type DelegateEvent =
  | { type: 'subtask_started'; taskId: string; goal: string }
  | { type: 'subtask_event'; taskId: string; event: AgentEvent }
  | { type: 'subtask_finished'; taskId: string; status: SubStatus; summary: string };

export interface DelegateDeps {
  /** A page of its own for one sub-task. */
  openPage(): Promise<Tab>;
  /** The agent loop, composed the way every other run is. */
  run(a: {
    goal: string; page: BrowserRuntime; signal: AbortSignal;
    conversation?: ConversationTurn[]; onEvent(e: AgentEvent): void;
  }): Promise<RunResult>;
  /** Tie a run to its page, so an approval answered later lands there. Returns how to untie it. */
  bindRun?(runId: string, page: BrowserRuntime): (() => void) | void;
  /**
   * Take over a page that a person still has to come back to: an action
   * waiting for approval, or a form that is filled and theirs to submit.
   * Without this such a page is closed with the task. A page kept for a
   * question is parked under `key`, and handed back by `take`.
   */
  park?(runId: string, tab: Tab, key?: string): void;
  /** The page parked under `key`, no longer kept, for the task that continues on it; null once it is gone. */
  take?(key: string): Tab | null;
  checkpointer?: Checkpointer;
  concurrency?: number;
}

export interface DelegateOptions {
  threadId: string;
  /** Required to start. Omit when resuming with an answer. */
  tasks?: SubTask[];
  /** The user's reply to the questions a paused run asked. */
  answer?: string;
  signal?: AbortSignal;
  onEvent?(event: DelegateEvent): void;
}

export interface DelegateOutcome {
  status: 'done' | 'needs_answer' | 'failed' | 'cancelled';
  threadId: string;
  results: SubResult[];
  /** What the paused sub-agents asked, when status is needs_answer. */
  questions: Array<{ id: string; question: string }>;
  error?: string;
}

/** What is wrong with a plan, or null. Checked before anything runs. */
export function validateTasks(tasks: SubTask[]): string | null {
  if (!tasks.length) return 'no tasks were given';
  if (tasks.length > MAX_SUBTASKS) return `at most ${MAX_SUBTASKS} tasks run at once; ${tasks.length} were given`;
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!/^[\w-]{1,24}$/.test(task.id ?? '')) return 'every task needs a short id of letters, digits, "-" or "_"';
    if (ids.has(task.id)) return `two tasks share the id ${task.id}`;
    ids.add(task.id);
    if (!task.goal?.trim()) return `task ${task.id} has no goal`;
    if (task.url !== undefined && !/^https?:\/\//.test(task.url)) return `task ${task.id}: url must be an http(s) address`;
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) return `task ${task.id} depends on ${dep}, which is not a task`;
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cyclic = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'visiting') return true;
    state.set(id, 'visiting');
    const found = (byId.get(id)?.dependsOn ?? []).some(cyclic);
    state.set(id, 'done');
    return found;
  };
  if (tasks.some((t) => cyclic(t.id))) return 'the tasks depend on each other in a circle';
  return null;
}

const clip = (text: string, limit = SUMMARY_LIMIT): string =>
  (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

function settled(state: State): Map<string, SubResult> {
  const out = new Map<string, SubResult>();
  for (const [id, result] of Object.entries(state.results)) if (result) out.set(id, result);
  return out;
}

export class Delegation {
  readonly #deps: DelegateDeps;
  readonly #graph: CompiledGraph<State>;
  /**
   * Pages kept open for a task that paused, so its answer continues where it
   * stopped. Parked, so they are kept as every page waiting on the user is,
   * and held here only when there is nowhere to park them.
   */
  readonly #kept = new Map<string, Tab>();
  /** Tasks whose page is parked under #key. */
  readonly #parked = new Set<string>();
  #threadId = '';
  #onEvent: (event: DelegateEvent) => void = () => {};

  constructor(deps: DelegateDeps) {
    this.#deps = deps;
    this.#graph = new StateGraph<State>({
      reducers: {
        results: (current, update) => ({ ...current, ...update }),
        answers: (current, update) => ({ ...current, ...update }),
      },
    })
      .addNode('dispatch', (state) => this.#dispatch(state))
      .addNode('work', (state, ctx) => this.#work(state, String(ctx.input), ctx.signal))
      .addNode('ask', (state, ctx) => {
        const waiting = [...settled(state).values()].filter((r) => r.status === 'needs_answer');
        const answer = ctx.interrupt<string>(waiting.map((r) => ({ id: r.id, question: r.summary })));
        return {
          goto: 'dispatch',
          update: {
            answers: Object.fromEntries(waiting.map((r) => [r.id, { question: r.summary, answer }])),
            results: Object.fromEntries(waiting.map((r) => [r.id, null])),
          },
        };
      })
      .setEntry('dispatch')
      .addEdge('work', 'dispatch')
      .compile({ name: 'delegate', checkpointer: deps.checkpointer });
  }

  async run(opts: DelegateOptions): Promise<DelegateOutcome> {
    if (opts.tasks) {
      const problem = validateTasks(opts.tasks);
      if (problem) return { status: 'failed', threadId: opts.threadId, results: [], questions: [], error: problem };
    }
    this.#onEvent = opts.onEvent ?? (() => {});
    this.#threadId = opts.threadId;
    const result = await this.#graph.invoke({
      threadId: opts.threadId,
      input: opts.tasks ? { tasks: opts.tasks, results: {}, answers: {} } : undefined,
      resume: opts.answer,
      signal: opts.signal,
      maxConcurrency: this.#deps.concurrency ?? 3,
    });

    const results = [...settled(result.state).values()];
    const base = { threadId: opts.threadId, results };
    if (result.status === 'interrupted') {
      const questions = results.filter((r) => r.status === 'needs_answer').map((r) => ({ id: r.id, question: r.summary }));
      return { ...base, status: 'needs_answer', questions };
    }
    await this.#release();
    if (result.status === 'failed') return { ...base, status: 'failed', questions: [], error: result.error };
    return { ...base, status: result.status, questions: [] };
  }

  /** Close pages held for answers that will not come. */
  async close(): Promise<void> {
    await this.#release();
  }

  async #release(): Promise<void> {
    const tabs = [...this.#kept.values(), ...[...this.#parked].map((id) => this.#deps.take?.(this.#key(id)) ?? null)];
    this.#kept.clear();
    this.#parked.clear();
    await Promise.all(tabs.map((t) => t?.close().catch(() => {})));
  }

  #key(id: string): string {
    return `delegate:${this.#threadId}:${id}`;
  }

  #keep(id: string, runId: string, tab: Tab): void {
    if (this.#deps.park && this.#deps.take) {
      this.#deps.park(runId, tab, this.#key(id));
      this.#parked.add(id);
    } else {
      this.#kept.set(id, tab);
    }
  }

  /** The page a paused task was kept on, or null when there is none or it was let go (kept past its limit, closed by the user). */
  async #takeBack(id: string): Promise<Tab | null> {
    let tab = this.#kept.get(id) ?? null;
    this.#kept.delete(id);
    if (!tab && this.#parked.delete(id)) tab = this.#deps.take?.(this.#key(id)) ?? null;
    if (!tab) return null;
    try {
      await tab.page.observe();
      return tab;
    } catch {
      await tab.close().catch(() => {});
      return null;
    }
  }

  #dispatch(state: State) {
    const done = settled(state);
    const skipped: Record<string, SubResult> = {};
    const blocked = (task: SubTask): string | null => {
      for (const dep of task.dependsOn ?? []) {
        const result = done.get(dep) ?? skipped[dep];
        if (result && result.status !== 'done') return dep;
      }
      return null;
    };
    // Repeated until stable: skipping one task can block the ones after it.
    for (let changed = true; changed;) {
      changed = false;
      for (const task of state.tasks) {
        if (done.has(task.id) || skipped[task.id]) continue;
        const dep = blocked(task);
        // A task waiting on an answer may still finish, so what needs it waits too.
        if (!dep || (done.get(dep) ?? skipped[dep]).status === 'needs_answer') continue;
        skipped[task.id] = { id: task.id, status: 'skipped', summary: `not started: it needs ${dep}, which did not finish`, steps: 0, costUsd: 0 };
        changed = true;
      }
    }

    const ready = state.tasks.filter((task) =>
      !done.has(task.id) && !skipped[task.id]
      && (task.dependsOn ?? []).every((dep) => done.get(dep)?.status === 'done'));

    if (ready.length) return { update: { results: skipped }, goto: ready.map((t) => send('work', t.id)) };
    const waiting = [...done.values()].some((r) => r.status === 'needs_answer');
    return { update: { results: skipped }, goto: waiting ? 'ask' : END };
  }

  async #work(state: State, id: string, signal: AbortSignal): Promise<Partial<State>> {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`no task with id ${id}`);
    this.#onEvent({ type: 'subtask_started', taskId: id, goal: task.goal });

    const finish = (result: SubResult): Partial<State> => {
      this.#onEvent({ type: 'subtask_finished', taskId: id, status: result.status, summary: result.summary });
      return { results: { [id]: result } };
    };

    let tab = await this.#takeBack(id);
    const resumed = tab !== null;
    try {
      tab ??= await this.#deps.openPage();
      if (task.url && !resumed) await tab.page.goto(task.url);
    } catch (err) {
      await tab?.close().catch(() => {});
      return finish({ id, status: 'failed', summary: `could not open a page: ${(err as Error).message}`, steps: 0, costUsd: 0 });
    }

    const prior = (task.dependsOn ?? [])
      .map((dep) => settled(state).get(dep))
      .filter((r): r is SubResult => r !== undefined)
      .map((r) => `Result of ${r.id}: ${r.summary}`);
    const goal = prior.length ? `${task.goal}\n\nFrom the steps before this one:\n${prior.join('\n')}` : task.goal;
    const exchange = state.answers[id];
    const at = new Date().toISOString();
    const conversation: ConversationTurn[] | undefined = exchange
      ? [
          { role: 'user', text: task.goal, at, awaiting: false },
          { role: 'agent', text: exchange.question, at, awaiting: true },
          { role: 'user', text: exchange.answer, at, awaiting: false },
        ]
      : undefined;

    let result: RunResult;
    let unbind: (() => void) | void;
    const discard = async (): Promise<void> => {
      unbind?.();
      await tab!.close().catch(() => {});
    };
    try {
      result = await this.#deps.run({
        goal, page: tab.page, signal, conversation,
        onEvent: (event) => {
          if (event.type === 'run_started') unbind = this.#deps.bindRun?.(event.runId, tab!.page);
          this.#onEvent({ type: 'subtask_event', taskId: id, event });
        },
      });
    } catch (err) {
      await discard();
      return finish({ id, status: 'failed', summary: clip(`stopped: ${(err as Error).message}`), steps: 0, costUsd: 0 });
    }

    const base = { id, runId: result.runId, steps: result.steps, costUsd: result.costUsd };
    if (result.status === 'done') {
      await discard();
      return finish({ ...base, status: 'done', summary: clip(result.message) });
    }
    if (result.status === 'awaiting_approval' && result.pendingAction?.kind === 'ask_user') {
      // Kept for the answer, which continues on this page.
      this.#keep(id, result.runId, tab);
      return finish({ ...base, status: 'needs_answer', summary: clip(result.message) });
    }
    if (result.status === 'awaiting_approval') {
      if (this.#deps.park) this.#deps.park(result.runId, tab);
      else await discard();
      return finish({ ...base, status: 'waiting_approval', summary: clip(result.message) });
    }
    await discard();
    return finish({ ...base, status: 'failed', summary: clip(`${result.status}: ${result.message}`) });
  }
}
