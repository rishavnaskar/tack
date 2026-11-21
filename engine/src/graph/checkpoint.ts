/**
 * Where a graph run had got to, kept so it can continue.
 *
 * One row per thread, replaced at every step. The state is stored as JSON,
 * so it has to be plain data: no class instances, no functions.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Task {
  node: string;
  /** The private input of a branch, or null for a node reached by an edge. */
  input: unknown;
  /** Stopped at an interrupt and waiting for its answer. */
  interrupted: boolean;
}

export interface Checkpoint {
  threadId: string;
  graph: string;
  step: number;
  state: unknown;
  /** What runs next. */
  frontier: Task[];
  status: 'running' | 'interrupted' | 'done' | 'failed';
  interrupts: Array<{ node: string; payload: unknown }>;
  error: string | null;
  updatedAt: string;
}

export interface Checkpointer {
  save(checkpoint: Checkpoint): void;
  load(threadId: string): Checkpoint | null;
  delete(threadId: string): void;
}

export class MemoryCheckpointer implements Checkpointer {
  readonly #threads = new Map<string, string>();

  save(checkpoint: Checkpoint): void {
    this.#threads.set(checkpoint.threadId, JSON.stringify(checkpoint));
  }

  load(threadId: string): Checkpoint | null {
    const saved = this.#threads.get(threadId);
    return saved ? (JSON.parse(saved) as Checkpoint) : null;
  }

  delete(threadId: string): void {
    this.#threads.delete(threadId);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_checkpoints (
  thread_id   TEXT PRIMARY KEY,
  graph       TEXT NOT NULL,
  step        INTEGER NOT NULL,
  status      TEXT NOT NULL,
  state       TEXT NOT NULL,
  frontier    TEXT NOT NULL,
  interrupts  TEXT NOT NULL,
  error       TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_checkpoints_status ON graph_checkpoints(graph, status);
`;

export class SqliteCheckpointer implements Checkpointer {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  save(c: Checkpoint): void {
    this.#db.prepare(`
      INSERT INTO graph_checkpoints (thread_id, graph, step, status, state, frontier, interrupts, error, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET
        graph = excluded.graph, step = excluded.step, status = excluded.status, state = excluded.state,
        frontier = excluded.frontier, interrupts = excluded.interrupts, error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      c.threadId, c.graph, c.step, c.status, JSON.stringify(c.state), JSON.stringify(c.frontier),
      JSON.stringify(c.interrupts), c.error, c.updatedAt,
    );
  }

  load(threadId: string): Checkpoint | null {
    const row = this.#db.prepare('SELECT * FROM graph_checkpoints WHERE thread_id = ?').get(threadId) as
      Record<string, unknown> | undefined;
    return row ? toCheckpoint(row) : null;
  }

  delete(threadId: string): void {
    this.#db.prepare('DELETE FROM graph_checkpoints WHERE thread_id = ?').run(threadId);
  }

  /** Threads of one graph that stopped part-way, oldest first. */
  unfinished(graph: string): Checkpoint[] {
    const rows = this.#db.prepare(
      "SELECT * FROM graph_checkpoints WHERE graph = ? AND status IN ('running','interrupted') ORDER BY updated_at",
    ).all(graph) as Array<Record<string, unknown>>;
    return rows.map(toCheckpoint);
  }
}

function toCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    threadId: String(row.thread_id),
    graph: String(row.graph),
    step: Number(row.step),
    status: row.status as Checkpoint['status'],
    state: JSON.parse(String(row.state)),
    frontier: JSON.parse(String(row.frontier)) as Task[],
    interrupts: JSON.parse(String(row.interrupts)) as Checkpoint['interrupts'],
    error: row.error === null ? null : String(row.error),
    updatedAt: String(row.updated_at),
  };
}
