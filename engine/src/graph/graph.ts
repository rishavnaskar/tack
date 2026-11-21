/**
 * A small state graph: named nodes, edges between them, and one shared state.
 *
 * Orchestration that spans several agents needs three things a plain function
 * call does not give: branches that run side by side and merge, a record of
 * where a run had got to so it can continue after a pause or a restart, and a
 * way for a node to stop and wait for a person. This is the smallest engine
 * that provides those, with no dependency.
 *
 * A run advances in steps. Every node due in a step runs concurrently; their
 * updates are merged into the state field by field; the step is checkpointed;
 * then the next nodes are worked out. A node that needs a person calls
 * `ctx.interrupt()`. The run stops with the state saved, and resuming it runs
 * that node again from the top with the answer in hand, so a node should
 * pause before it does anything it could not safely do twice.
 */
import type { Checkpointer, Checkpoint, Task } from './checkpoint.ts';
import { MemoryCheckpointer } from './checkpoint.ts';

export const END = '__end__';

/** How an update to one field combines with what is already there. */
export type Reducer<V> = (current: V, update: V) => V;

/** Run a node with an input of its own, alongside the shared state. One per parallel branch. */
export interface Send {
  node: string;
  input: unknown;
}

export const send = (node: string, input: unknown): Send => ({ node, input });

/** A node's way of choosing where to go next itself, instead of following an edge. */
export interface Command<S> {
  update?: Partial<S>;
  goto: string | Array<string | Send>;
}

export type GraphEvent =
  | { type: 'node_started'; node: string; step: number }
  | { type: 'node_finished'; node: string; step: number; ms: number }
  | { type: 'node_failed'; node: string; step: number; error: string; willRetry: boolean }
  | { type: 'custom'; node: string; name: string; data: unknown };

export interface NodeContext {
  threadId: string;
  signal: AbortSignal;
  /** The private input of a branch started with `send`. */
  input: unknown;
  /** Publish something to whoever is watching the run. */
  emit(name: string, data: unknown): void;
  /**
   * Stop here and wait for a person. The first time this is reached the run
   * pauses and `payload` is handed to the caller. When the run is resumed the
   * node starts again and this returns the answer.
   */
  interrupt<T = unknown>(payload: unknown): T;
}

export type NodeResult<S> = Partial<S> | Command<S> | void;
export type NodeFn<S> = (state: S, ctx: NodeContext) => Promise<NodeResult<S>> | NodeResult<S>;
export type Router<S> = (state: S) => string | Array<string | Send>;

export interface NodeOptions {
  /** Extra attempts after a failure. An interrupt is never retried. */
  retries?: number;
}

export interface GraphOptions<S> {
  /** Fields that accumulate rather than overwrite. */
  reducers?: { [K in keyof S]?: Reducer<S[K]> };
}

export interface InvokeOptions<S> {
  threadId: string;
  /** Merged into the state before the run continues. Required to start a new thread. */
  input?: Partial<S>;
  /** The answer to a pending interrupt. */
  resume?: unknown;
  signal?: AbortSignal;
  onEvent?(event: GraphEvent): void;
  /** How many nodes may run at once within a step. */
  maxConcurrency?: number;
  /** Steps before the run is declared stuck. */
  stepLimit?: number;
}

export type GraphResult<S> =
  | { status: 'done'; state: S }
  | { status: 'interrupted'; state: S; interrupts: Array<{ node: string; payload: unknown }> }
  | { status: 'failed'; state: S; error: string }
  | { status: 'cancelled'; state: S };

class Interrupt extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) {
    super('interrupt');
    this.payload = payload;
  }
}

function isCommand<S>(value: unknown): value is Command<S> {
  return typeof value === 'object' && value !== null && 'goto' in value;
}

export class StateGraph<S extends object> {
  readonly #nodes = new Map<string, { fn: NodeFn<S>; retries: number }>();
  readonly #edges = new Map<string, string[]>();
  readonly #routers = new Map<string, Router<S>>();
  readonly #reducers: NonNullable<GraphOptions<S>['reducers']>;
  #entry: string | null = null;

  constructor(opts: GraphOptions<S> = {}) {
    this.#reducers = opts.reducers ?? {};
  }

  addNode(name: string, fn: NodeFn<S>, opts: NodeOptions = {}): this {
    if (name === END || this.#nodes.has(name)) throw new Error(`node name ${JSON.stringify(name)} is taken`);
    this.#nodes.set(name, { fn, retries: opts.retries ?? 0 });
    return this;
  }

  setEntry(name: string): this {
    this.#entry = name;
    return this;
  }

  addEdge(from: string, to: string): this {
    this.#edges.set(from, [...(this.#edges.get(from) ?? []), to]);
    return this;
  }

  /** Choose the next node from the state, once `from` has run. */
  addConditionalEdges(from: string, router: Router<S>): this {
    this.#routers.set(from, router);
    return this;
  }

  compile(opts: { name: string; checkpointer?: Checkpointer }): CompiledGraph<S> {
    if (!this.#entry || !this.#nodes.has(this.#entry)) throw new Error('the graph has no entry node');
    for (const [from, targets] of this.#edges) {
      if (!this.#nodes.has(from)) throw new Error(`edge from unknown node ${from}`);
      for (const to of targets) if (to !== END && !this.#nodes.has(to)) throw new Error(`edge to unknown node ${to}`);
      // One style per node: an edge and a router together would send the run to both.
      if (this.#routers.has(from)) throw new Error(`${from} has both an edge and a router`);
    }
    for (const from of this.#routers.keys()) {
      if (!this.#nodes.has(from)) throw new Error(`router on unknown node ${from}`);
    }
    return new CompiledGraph<S>({
      name: opts.name, entry: this.#entry, nodes: this.#nodes, edges: this.#edges,
      routers: this.#routers, reducers: this.#reducers,
      checkpointer: opts.checkpointer ?? new MemoryCheckpointer(),
    });
  }
}

interface Compiled<S> {
  name: string;
  entry: string;
  nodes: Map<string, { fn: NodeFn<S>; retries: number }>;
  edges: Map<string, string[]>;
  routers: Map<string, Router<S>>;
  reducers: NonNullable<GraphOptions<S>['reducers']>;
  checkpointer: Checkpointer;
}

type Outcome<S> =
  | { kind: 'ok'; task: Task; result: NodeResult<S> }
  | { kind: 'interrupt'; task: Task; payload: unknown }
  | { kind: 'error'; task: Task; error: string };

export class CompiledGraph<S extends object> {
  readonly #g: Compiled<S>;

  constructor(g: Compiled<S>) {
    this.#g = g;
  }

  /** The saved position of a thread, if it has one. */
  checkpoint(threadId: string): Checkpoint | null {
    return this.#g.checkpointer.load(threadId);
  }

  async invoke(opts: InvokeOptions<S>): Promise<GraphResult<S>> {
    const { threadId } = opts;
    const signal = opts.signal ?? new AbortController().signal;
    const saved = this.#g.checkpointer.load(threadId);

    let state: S;
    let frontier: Task[];
    let step: number;
    let resume: { value: unknown } | null = null;

    if (!saved) {
      if (opts.input === undefined) throw new Error(`thread ${threadId} has no checkpoint and no input to start from`);
      state = this.#merge({} as S, opts.input);
      frontier = [{ node: this.#g.entry, input: null, interrupted: false }];
      step = 0;
    } else {
      state = saved.state as S;
      if (opts.input !== undefined) state = this.#merge(state, opts.input);
      step = saved.step;
      if (saved.status === 'interrupted') {
        if (opts.resume === undefined) {
          return { status: 'interrupted', state, interrupts: saved.interrupts };
        }
        resume = { value: opts.resume };
        frontier = saved.frontier;
      } else if (saved.status === 'done' || saved.frontier.length === 0) {
        // A finished thread given new input runs again from the top, keeping its state.
        frontier = [{ node: this.#g.entry, input: null, interrupted: false }];
      } else {
        frontier = saved.frontier.map((t) => ({ ...t, interrupted: false }));
      }
    }

    const limit = opts.stepLimit ?? 100;
    const started = step;

    while (frontier.length) {
      if (signal.aborted) {
        this.#save(threadId, state, frontier, step, 'running', []);
        return { status: 'cancelled', state };
      }
      if (step - started >= limit) {
        const error = `the run did not finish within ${limit} steps`;
        this.#save(threadId, state, frontier, step, 'failed', [], error);
        return { status: 'failed', state, error };
      }

      const outcomes = await this.#runStep(frontier, state, step, threadId, signal, resume, opts);
      resume = null;
      step++;

      const next: Task[] = [];
      const interrupts: Array<{ node: string; payload: unknown }> = [];
      let failure: string | null = null;

      for (const outcome of outcomes) {
        if (outcome.kind === 'error') {
          failure ??= `${outcome.task.node}: ${outcome.error}`;
          continue;
        }
        if (outcome.kind === 'interrupt') {
          interrupts.push({ node: outcome.task.node, payload: outcome.payload });
          next.push({ ...outcome.task, interrupted: true });
          continue;
        }
        const result = outcome.result;
        if (isCommand<S>(result)) {
          if (result.update) state = this.#merge(state, result.update);
        } else if (result) {
          state = this.#merge(state, result);
        }
      }

      if (failure) {
        this.#save(threadId, state, frontier, step, 'failed', [], failure);
        return { status: 'failed', state, error: failure };
      }

      // Routing reads the state after every update in the step has landed.
      for (const outcome of outcomes) {
        if (outcome.kind === 'ok') this.#addSuccessors(next, outcome.task.node, outcome.result, state);
      }

      frontier = next;
      if (interrupts.length) {
        this.#save(threadId, state, frontier, step, 'interrupted', interrupts);
        return { status: 'interrupted', state, interrupts };
      }
      this.#save(threadId, state, frontier, step, frontier.length ? 'running' : 'done', []);
    }

    return { status: 'done', state };
  }

  async #runStep(
    frontier: Task[], state: S, step: number, threadId: string, signal: AbortSignal,
    resume: { value: unknown } | null, opts: InvokeOptions<S>,
  ): Promise<Array<Outcome<S>>> {
    const outcomes = new Array<Outcome<S>>(frontier.length);
    const width = Math.max(1, Math.min(opts.maxConcurrency ?? 4, frontier.length));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= frontier.length) return;
        const task = frontier[i];
        const answer = task.interrupted && resume ? resume : null;
        outcomes[i] = await this.#runTask(task, state, step, threadId, signal, answer, opts);
      }
    };
    await Promise.all(Array.from({ length: width }, worker));
    return outcomes;
  }

  async #runTask(
    task: Task, state: S, step: number, threadId: string, signal: AbortSignal,
    answer: { value: unknown } | null, opts: InvokeOptions<S>,
  ): Promise<Outcome<S>> {
    const node = this.#g.nodes.get(task.node);
    if (!node) return { kind: 'error', task, error: 'no such node' };

    const ctx: NodeContext = {
      threadId, signal, input: task.input,
      emit: (name, data) => opts.onEvent?.({ type: 'custom', node: task.node, name, data }),
      interrupt: <T>(payload: unknown): T => {
        if (answer) return answer.value as T;
        throw new Interrupt(payload);
      },
    };

    for (let attempt = 0; ; attempt++) {
      opts.onEvent?.({ type: 'node_started', node: task.node, step });
      const startedAt = Date.now();
      try {
        const result = await node.fn(state, ctx);
        opts.onEvent?.({ type: 'node_finished', node: task.node, step, ms: Date.now() - startedAt });
        return { kind: 'ok', task, result };
      } catch (err) {
        if (err instanceof Interrupt) return { kind: 'interrupt', task, payload: err.payload };
        const willRetry = attempt < node.retries && !signal.aborted;
        opts.onEvent?.({ type: 'node_failed', node: task.node, step, error: (err as Error).message, willRetry });
        if (!willRetry) return { kind: 'error', task, error: (err as Error).message };
      }
    }
  }

  #addSuccessors(next: Task[], node: string, result: NodeResult<S>, state: S): void {
    const chosen = isCommand<S>(result)
      ? result.goto
      : this.#g.routers.get(node)?.(state) ?? this.#g.edges.get(node) ?? END;
    for (const target of Array.isArray(chosen) ? chosen : [chosen]) {
      if (typeof target === 'string') {
        if (target === END) continue;
        if (!this.#g.nodes.has(target)) throw new Error(`${node} routed to unknown node ${target}`);
        // Branches that converge on a node run it once, after all of them.
        if (!next.some((t) => t.node === target && t.input === null)) {
          next.push({ node: target, input: null, interrupted: false });
        }
      } else {
        if (!this.#g.nodes.has(target.node)) throw new Error(`${node} sent to unknown node ${target.node}`);
        next.push({ node: target.node, input: target.input, interrupted: false });
      }
    }
  }

  #merge(state: S, update: Partial<S>): S {
    const merged = { ...state };
    for (const key of Object.keys(update) as Array<keyof S>) {
      const value = update[key];
      if (value === undefined) continue;
      const reducer = this.#g.reducers[key];
      merged[key] = reducer && merged[key] !== undefined ? reducer(merged[key], value as S[keyof S]) : (value as S[keyof S]);
    }
    return merged;
  }

  #save(
    threadId: string, state: S, frontier: Task[], step: number, status: Checkpoint['status'],
    interrupts: Checkpoint['interrupts'], error?: string,
  ): void {
    this.#g.checkpointer.save({
      threadId, graph: this.#g.name, step, state, frontier, status, interrupts,
      error: error ?? null, updatedAt: new Date().toISOString(),
    });
  }
}

/** A reducer that appends. The usual choice for a list several branches write to. */
export function append<T>(current: T[], update: T[]): T[] {
  return [...current, ...update];
}
