/**
 * What the thread is trying to achieve, and what it has collected.
 *
 * Asked for the top 50 jobs, an agent that finds 14 says so and returns done
 * unless something compares 14 to 50. Told to continue, it re-reads the same
 * page and reports the same 14 unless there is somewhere to bank what it
 * already has. The target answers the first, deduped findings the second.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type ObjectiveStatus = 'active' | 'done' | 'abandoned';

export interface Objective {
  id: string;
  conversationId: string;
  goal: string;
  /** How many distinct findings finish it. Null when nothing countable was asked for. */
  targetCount: number | null;
  /** What is being collected, in the user's own words: "job listings". */
  what: string | null;
  status: ObjectiveStatus;
  /** Report filename, once one has been written. */
  report?: string | null;
}

export interface Finding {
  kind: string;
  label: string;
  data: Record<string, unknown>;
  sourceUrl?: string | null;
}

export interface Progress {
  objective: Objective;
  found: number;
  /** Null when the objective has no countable target. */
  remaining: number | null;
  satisfied: boolean;
}

/**
 * The dedupe key: kind plus a canonical hash of the data. Key order must not
 * make the same row look new, so the JSON is sorted first.
 */
export function findingHash(f: Finding): string {
  const canonical = JSON.stringify([f.kind, sortedJson(f.data)]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortedJson(v)]),
    );
  }
  return value;
}

export class Objectives {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  open(o: { conversationId: string; goal: string; targetCount?: number | null; what?: string | null }): Objective {
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO objectives (id, conversation_id, goal, target_count, what, status, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, o.conversationId, o.goal, o.targetCount ?? null, o.what ?? null, 'active', new Date().toISOString());
    return {
      id, conversationId: o.conversationId, goal: o.goal,
      targetCount: o.targetCount ?? null, what: o.what ?? null, status: 'active',
    };
  }

  /** The thread's live objective, if it has one. */
  active(conversationId: string): Objective | null {
    const row = this.#db.prepare(
      "SELECT * FROM objectives WHERE conversation_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    ).get(conversationId) as Record<string, unknown> | undefined;
    return row ? toObjective(row) : null;
  }

  get(id: string): Objective | null {
    const row = this.#db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toObjective(row) : null;
  }

  close(id: string, status: Exclude<ObjectiveStatus, 'active'>): void {
    this.#db.prepare('UPDATE objectives SET status = ?, ended_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  setReport(id: string, name: string): void {
    this.#db.prepare('UPDATE objectives SET report = ? WHERE id = ?').run(name, id);
  }

  /** Every objective a thread has had, newest first. */
  forConversation(conversationId: string): Objective[] {
    return (this.#db.prepare(
      'SELECT * FROM objectives WHERE conversation_id = ? ORDER BY created_at DESC',
    ).all(conversationId) as Array<Record<string, unknown>>).map(toObjective);
  }

  /**
   * Bank a finding. Returns true only when it was new.
   *
   * The dedupe is the primary key, so a second run re-reading page one adds
   * nothing and cannot inflate its own progress.
   */
  record(objectiveId: string, f: Finding, runId?: string | null): boolean {
    const hash = findingHash(f);
    const existing = this.#db.prepare(
      'SELECT 1 FROM findings WHERE objective_id = ? AND content_hash = ?',
    ).get(objectiveId, hash);
    if (existing) return false;
    this.#db.prepare(`
      INSERT INTO findings (objective_id, content_hash, kind, label, data, source_url, run_id, at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(objectiveId, hash, f.kind, f.label, JSON.stringify(f.data),
           f.sourceUrl ?? null, runId ?? null, new Date().toISOString());
    return true;
  }

  /**
   * How many were new, stopping at the target.
   *
   * A fan-out over twelve pages banks its rows all at once, so a count checked
   * only afterwards turns fifty asked for into eighty-six collected. Fifty
   * asked for is fifty delivered: the rows past it are dropped rather than
   * stored, so the chat, the file and the preview cannot disagree about how
   * many there are.
   */
  recordAll(objectiveId: string, findings: Finding[], runId?: string | null): number {
    const target = this.get(objectiveId)?.targetCount ?? null;
    let have = this.count(objectiveId);
    let added = 0;
    for (const f of findings) {
      if (target !== null && have >= target) break;
      if (this.record(objectiveId, f, runId)) { added++; have++; }
    }
    return added;
  }

  findings(objectiveId: string, limit = 500): Array<Finding & { at: string }> {
    const rows = this.#db.prepare(
      'SELECT kind, label, data, source_url, at FROM findings WHERE objective_id = ? ORDER BY at LIMIT ?',
    ).all(objectiveId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      kind: String(r.kind), label: String(r.label),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
      sourceUrl: (r.source_url as string) ?? null,
      at: String(r.at),
    }));
  }

  count(objectiveId: string): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM findings WHERE objective_id = ?')
      .get(objectiveId) as { n: number };
    return row.n;
  }

  /**
   * Whether the objective is finished. With no countable target there is
   * nothing to check, so the model's own judgement stands.
   */
  progress(objectiveId: string): Progress | null {
    const objective = this.get(objectiveId);
    if (!objective) return null;
    const found = this.count(objectiveId);
    if (objective.targetCount === null) {
      return { objective, found, remaining: null, satisfied: true };
    }
    const remaining = Math.max(0, objective.targetCount - found);
    return { objective, found, remaining, satisfied: remaining === 0 };
  }
}

function toObjective(row: Record<string, unknown>): Objective {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    goal: String(row.goal),
    targetCount: row.target_count === null ? null : Number(row.target_count),
    what: (row.what as string) ?? null,
    status: String(row.status) as ObjectiveStatus,
    report: (row.report as string) ?? null,
  };
}
