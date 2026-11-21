/**
 * Local durable state: SQLite, one file, no native dependency (node:sqlite).
 *
 * Two shapes matter here and they are deliberately different:
 *
 *  - The trajectory log (runs, steps, usage) is append-mostly and exists so a
 *    crash is visible rather than silent, and so any two prompt or model
 *    versions can be diffed after the fact.
 *
 *  - The side-effect journal is the duplicate-suppression protocol. An
 *    actuating action records its INTENT under an idempotency key derived from
 *    (run, step, target, content) before it is attempted, and its EVIDENCE
 *    after. A retry is only permitted when the journal shows no evidence the
 *    effect occurred. Without this, a browser hiccup mid-batch means someone
 *    gets contacted twice and the only way to find out is to go and look.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type RunStatus =
  | 'running' | 'done' | 'failed' | 'awaiting_approval' | 'abandoned'
  /** Ended at its step limit with work outstanding; another leg took over. */
  | 'continued';
export type EffectStatus = 'intended' | 'committed' | 'failed' | 'abandoned';

/** The title a thread has until its first request names it. */
export const UNTITLED_CONVERSATION = 'New conversation';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  result        TEXT,
  error         TEXT,
  steps         INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  conversation_id TEXT,
  objective_id  TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  run_id        TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  at            TEXT NOT NULL,
  url           TEXT,
  page_state_id TEXT,
  observation   TEXT,
  action        TEXT,
  -- WHAT the action was aimed at, by role and accessible name.
  --
  -- A ref is a lease on one observation and means nothing afterwards, so a
  -- recorded trace could describe what was clicked but never find it again.
  -- These two are what make a run replayable at all.
  target_role   TEXT,
  target_name   TEXT,
  sensitivity   TEXT,
  allowed       INTEGER,
  outcome       TEXT,
  failure       TEXT,
  model_ms      INTEGER,
  act_ms        INTEGER,
  cost_usd      REAL,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT,
  at            TEXT NOT NULL,
  tier          TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  reported_cost_usd REAL,
  computed_cost_usd REAL NOT NULL,
  price_book_version TEXT NOT NULL,
  latency_ms    INTEGER NOT NULL
);

-- The idempotency key is the primary key on purpose: recording the same
-- intent twice is a constraint violation, not a silent second send.
CREATE TABLE IF NOT EXISTS effects (
  idempotency_key TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  step_idx      INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  target        TEXT NOT NULL,
  content       TEXT,
  status        TEXT NOT NULL,
  intended_at   TEXT NOT NULL,
  settled_at    TEXT,
  evidence      TEXT
);

-- A conversation is the thread the user is actually having. Runs belong to
-- one: a task is what the agent does, a conversation is what it remembers.
-- Without it every message is an island, and a reply answering a question
-- the agent has just asked arrives as a brand-new goal with no idea what it
-- is answering.
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  last_at       TEXT NOT NULL,
  -- The task the thread is working on. An answer to a pending question
  -- continues it; a new instruction replaces it.
  goal          TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL,
  idx             INTEGER NOT NULL,
  at              TEXT NOT NULL,
  role            TEXT NOT NULL,
  text            TEXT NOT NULL,
  run_id          TEXT,
  -- 1 on an agent turn that ended by asking the user something. The next
  -- user message is read as the answer to it rather than as a new task.
  awaiting        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, idx)
);

CREATE INDEX IF NOT EXISTS steps_run ON steps(run_id);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);

-- What the thread is trying to achieve, and what it has collected so far.
-- Held on the conversation, not the run, so a run that ends with work
-- outstanding is resumed rather than restarted.
CREATE TABLE IF NOT EXISTS objectives (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  goal            TEXT NOT NULL,
  -- What "finished" means, checked by the loop rather than by the model.
  -- NULL target means "no countable criterion"; done is then the model's call.
  target_count    INTEGER,
  what            TEXT,
  status          TEXT NOT NULL,          -- active | done | abandoned
  created_at      TEXT NOT NULL,
  ended_at        TEXT,
  -- Filename of the report written when it completed, if it did.
  report          TEXT
);

-- The primary key IS the dedupe, so re-reading a page contributes nothing and
-- a resumed run cannot pad its count with what it already had.
CREATE TABLE IF NOT EXISTS findings (
  objective_id  TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  label         TEXT NOT NULL,
  data          TEXT NOT NULL,
  source_url    TEXT,
  run_id        TEXT,
  at            TEXT NOT NULL,
  PRIMARY KEY (objective_id, content_hash)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS objectives_conversation ON objectives(conversation_id);
CREATE INDEX IF NOT EXISTS findings_objective ON findings(objective_id);
CREATE INDEX IF NOT EXISTS usage_run ON usage_events(run_id);
CREATE INDEX IF NOT EXISTS effects_run ON effects(run_id);
`;

/** One turn in a conversation: what the user said, or what the agent said back. */
export interface ConversationTurn {
  role: 'user' | 'agent';
  text: string;
  at: string;
  runId?: string | null;
  /** True when this agent turn ended by asking the user something. */
  awaiting: boolean;
}

export interface StepRecord {
  runId: string;
  idx: number;
  url?: string;
  pageStateId?: string;
  observation?: string;
  action?: string;
  targetRole?: string | null;
  targetName?: string | null;
  sensitivity?: string;
  allowed?: boolean;
  outcome?: string;
  failure?: string;
  modelMs?: number;
  actMs?: number;
  costUsd?: number;
}

export interface EffectIntent {
  runId: string;
  stepIdx: number;
  kind: string;
  target: string;
  content?: string;
}

export class Store {
  #db: DatabaseSync;

  #ownsConnection: boolean;

  /**
   * Accepts a path or an existing connection. Sharing one connection matters:
   * two handles on the same file means two transaction scopes, so an
   * idempotency check and the write it guards can straddle them and the
   * duplicate-suppression guarantee quietly stops holding.
   */
  constructor(pathOrDb: string | DatabaseSync) {
    if (typeof pathOrDb === 'string') {
      if (pathOrDb !== ':memory:') mkdirSync(dirname(pathOrDb), { recursive: true });
      this.#db = new DatabaseSync(pathOrDb);
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#ownsConnection = true;
    } else {
      this.#db = pathOrDb;
      this.#ownsConnection = false;
    }
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Bring an existing database forward.
   *
   * Steps recorded before the target columns existed keep their trajectory
   * and simply cannot be replayed — which is honest: nothing recorded what
   * they were aimed at.
   */
  #migrate(): void {
    const columns = this.#db.prepare("PRAGMA table_info('steps')").all() as Array<{ name: string }>;
    if (!columns.length) return;
    const have = new Set(columns.map((c) => c.name));
    for (const name of ['target_role', 'target_name']) {
      if (!have.has(name)) this.#db.exec(`ALTER TABLE steps ADD COLUMN ${name} TEXT`);
    }
    // Runs predating conversations keep a null thread: they happened, they
    // just belong to no conversation, which is exactly what they were.
    const runCols = this.#db.prepare("PRAGMA table_info('runs')").all() as Array<{ name: string }>;
    const haveRun = new Set(runCols.map((c) => c.name));
    if (runCols.length) {
      for (const name of ['conversation_id', 'objective_id']) {
        if (!haveRun.has(name)) this.#db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
      }
    }
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }

  get raw(): DatabaseSync {
    return this.#db;
  }

  // ------------------------------------------------------------------ runs

  /**
   * Open the run record BEFORE any work begins, so a crash leaves a visible
   * `running` row rather than no trace that anything was attempted.
   */
  openRun(id: string, goal: string, conversationId?: string | null): void {
    this.#db.prepare(
      'INSERT INTO runs (id, goal, status, started_at, conversation_id) VALUES (?, ?, ?, ?, ?)',
    ).run(id, goal, 'running', new Date().toISOString(), conversationId ?? null);
  }

  closeRun(id: string, status: RunStatus, result?: string, error?: string): void {
    this.#db.prepare(
      'UPDATE runs SET status = ?, ended_at = ?, result = ?, error = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), result ?? null, error ?? null, id);
  }

  /** Recorded once the model declares what the run is collecting. */
  setRunObjective(id: string, objectiveId: string): void {
    this.#db.prepare('UPDATE runs SET objective_id = ? WHERE id = ?').run(objectiveId, id);
  }

  setRunStatus(id: string, status: RunStatus): void {
    this.#db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  }

  getRun(id: string): Record<string, unknown> | undefined {
    return this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  /**
   * Runs left `running` by a crash. Surfacing these is the point of the table.
   *
   * Given when this process started, only runs from before it count: one
   * started since is still going, such as another agent's open session.
   */
  staleRuns(startedBefore?: string): Array<Record<string, unknown>> {
    const rows = this.#db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as Array<Record<string, unknown>>;
    if (!startedBefore) return rows;
    // A run from before that still says it waits on an approval, when no approval waits for it, waits on nothing.
    // One that ended asking the user something (a question, a bot check) ended: it was not left open.
    const approvals = !!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get();
    const waiting = this.#db.prepare(`SELECT * FROM runs WHERE status = 'awaiting_approval' AND ended_at IS NULL AND started_at < ?${approvals
      ? " AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = runs.id AND a.status = 'pending')" : ''}`).all(startedBefore) as Array<Record<string, unknown>>;
    return [...rows.filter((r) => String(r.started_at) < startedBefore), ...waiting];
  }

  /**
   * Close out runs a crash left open, once someone has looked at them.
   *
   * `except` is the run happening right now, which is legitimately `running`
   * and must not be swept up with the wreckage. Effects stay unsettled: an
   * action that may have reached someone is not resolved by tidying the run
   * that attempted it.
   */
  abandonStaleRuns(except?: string | null, startedBefore?: string): number {
    const rows = this.staleRuns(startedBefore).filter((r) => r.id !== except);
    for (const r of rows) this.closeRun(String(r.id), 'abandoned', undefined, r.status === 'awaiting_approval' ? 'left waiting on an approval that is no longer there' : 'left open by a crash');
    return rows.length;
  }

  // -------------------------------------------------------------- settings

  setting<T>(key: string, fallback: T): T {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }

  setSetting(key: string, value: unknown): void {
    this.#db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // --------------------------------------------------------- conversations

  /**
   * Start a thread. The title is a handle for the UI, not a key.
   *
   * Deliberately NOT derived by a model call: a thread is created on the
   * user's first keystroke-to-send, and paying a round trip before the work
   * starts would make the product feel slower to do the thing it was asked.
   */
  openConversation(title: string, id = randomUUID()): string {
    const now = new Date().toISOString();
    this.#db.prepare(
      'INSERT INTO conversations (id, title, started_at, last_at) VALUES (?, ?, ?, ?)',
    ).run(id, title.slice(0, 120) || UNTITLED_CONVERSATION, now, now);
    return id;
  }

  conversation(id: string): Record<string, unknown> | undefined {
    return this.#db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  /** The thread the user was last in. What a reopened browser tab should show. */
  latestConversation(): Record<string, unknown> | undefined {
    return this.#db.prepare('SELECT * FROM conversations ORDER BY last_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
  }

  conversations(limit = 20): Array<Record<string, unknown>> {
    return this.#db.prepare('SELECT * FROM conversations ORDER BY last_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }

  renameConversation(id: string, title: string): boolean {
    const clean = title.trim().slice(0, 120);
    if (!clean) return false;
    return this.#db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(clean, id).changes > 0;
  }

  /** Name a thread after its first request, unless someone named it already. */
  titleConversation(id: string, title: string): boolean {
    const clean = title.trim().slice(0, 120);
    if (!clean) return false;
    return this.#db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title = ?')
      .run(clean, id, UNTITLED_CONVERSATION).changes > 0;
  }

  /**
   * The newest thread nobody has written in or named, moved to the top of the
   * list. "New" pressed twice is one empty thread, not two.
   */
  reuseEmptyConversation(): string | null {
    const row = this.#db.prepare(`
      SELECT id FROM conversations c WHERE title = ?
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id)
      ORDER BY last_at DESC LIMIT 1
    `).get(UNTITLED_CONVERSATION) as { id: string } | undefined;
    if (!row) return null;
    this.#db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return row.id;
  }

  /** Threads whose title or any message holds the words, newest first. */
  searchConversations(query: string, limit = 50): Array<Record<string, unknown>> {
    const like = '%' + query.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    return this.#db.prepare(`
      SELECT * FROM conversations c
      WHERE c.title LIKE ? ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.text LIKE ? ESCAPE '\\')
      ORDER BY last_at DESC LIMIT ?
    `).all(like, like, limit) as Array<Record<string, unknown>>;
  }

  /**
   * Remove a thread and its messages.
   *
   * Runs and objectives stay: they are the audit trail and the collected
   * rows, and a report file on disk still points at them. Only the link from
   * the run to the thread is cleared.
   */
  deleteConversation(id: string): boolean {
    this.#db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    this.#db.prepare('UPDATE runs SET conversation_id = NULL WHERE conversation_id = ?').run(id);
    return this.#db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
  }

  /**
   * The task the thread is working on.
   *
   * Held on the conversation rather than re-derived from the last run,
   * because the whole point is that an answer to a question does not become
   * the goal: "Yes I am signed in" must not replace "fetch my last three
   * conversations", and reading the newest run's goal would do exactly that.
   */
  setConversationGoal(id: string, goal: string | null): void {
    this.#db.prepare('UPDATE conversations SET goal = ? WHERE id = ?').run(goal, id);
  }

  conversationGoal(id: string): string | null {
    const row = this.#db.prepare('SELECT goal FROM conversations WHERE id = ?').get(id) as { goal?: string } | undefined;
    return row?.goal ?? null;
  }

  appendMessage(m: {
    conversationId: string; role: 'user' | 'agent'; text: string;
    runId?: string | null; awaiting?: boolean;
  }): number {
    const next = this.#db.prepare(
      'SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM messages WHERE conversation_id = ?',
    ).get(m.conversationId) as { n: number };
    const at = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO messages (conversation_id, idx, at, role, text, run_id, awaiting)
      VALUES (?,?,?,?,?,?,?)
    `).run(m.conversationId, next.n, at, m.role, m.text, m.runId ?? null, m.awaiting ? 1 : 0);
    this.#db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(at, m.conversationId);
    return next.n;
  }

  /**
   * The thread, oldest first.
   *
   * `limit` takes the most RECENT n and returns them in order: an old thread
   * must not push the current page out of the prompt, and the turns nearest
   * the question are the ones that explain it.
   */
  thread(conversationId: string, limit = 20): ConversationTurn[] {
    const rows = this.#db.prepare(`
      SELECT role, text, at, run_id, awaiting FROM messages
      WHERE conversation_id = ? ORDER BY idx DESC LIMIT ?
    `).all(conversationId, limit) as Array<{ role: string; text: string; at: string; run_id: string | null; awaiting: number }>;
    return rows.reverse().map((r) => ({
      role: r.role === 'agent' ? 'agent' : 'user',
      text: r.text,
      at: r.at,
      runId: r.run_id,
      awaiting: r.awaiting === 1,
    }));
  }

  /**
   * The question the agent is waiting on, if it is still the last word.
   *
   * Only the LAST turn counts. A question the user has already answered — or
   * talked past — is not pending, and treating it as pending would keep
   * re-answering an old question with every new message.
   */
  pendingQuestion(conversationId: string): { text: string; at: string } | null {
    const last = this.#db.prepare(
      'SELECT role, text, at, awaiting FROM messages WHERE conversation_id = ? ORDER BY idx DESC LIMIT 1',
    ).get(conversationId) as { role: string; text: string; at: string; awaiting: number } | undefined;
    if (!last || last.role !== 'agent' || last.awaiting !== 1) return null;
    return { text: last.text, at: last.at };
  }

  // ----------------------------------------------------------------- steps

  recordStep(step: StepRecord): void {
    this.#db.prepare(`
      INSERT INTO steps (run_id, idx, at, url, page_state_id, observation, action,
                         target_role, target_name,
                         sensitivity, allowed, outcome, failure, model_ms, act_ms, cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      step.runId, step.idx, new Date().toISOString(), step.url ?? null, step.pageStateId ?? null,
      step.observation ?? null, step.action ?? null,
      step.targetRole ?? null, step.targetName ?? null, step.sensitivity ?? null,
      step.allowed === undefined ? null : (step.allowed ? 1 : 0),
      step.outcome ?? null, step.failure ?? null,
      step.modelMs ?? null, step.actMs ?? null, step.costUsd ?? null,
    );
    this.#db.prepare(
      'UPDATE runs SET steps = ?, cost_usd = cost_usd + ? WHERE id = ?',
    ).run(step.idx + 1, step.costUsd ?? 0, step.runId);
  }

  steps(runId: string): Array<Record<string, unknown>> {
    return this.#db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY idx').all(runId) as Array<Record<string, unknown>>;
  }

  // ----------------------------------------------------------------- usage

  recordUsage(runId: string | null, e: {
    tier: string; modelId: string; promptTokens: number; completionTokens: number;
    cachedTokens: number; reasoningTokens: number; reportedCostUsd: number | null;
    computedCostUsd: number; priceBookVersion: string; latencyMs: number; at: string;
  }): void {
    this.#db.prepare(`
      INSERT INTO usage_events (run_id, at, tier, model_id, prompt_tokens, completion_tokens,
                                cached_tokens, reasoning_tokens, reported_cost_usd,
                                computed_cost_usd, price_book_version, latency_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(runId, e.at, e.tier, e.modelId, e.promptTokens, e.completionTokens,
      e.cachedTokens, e.reasoningTokens, e.reportedCostUsd, e.computedCostUsd,
      e.priceBookVersion, e.latencyMs);
  }

  // --------------------------------------------------------------- effects

  /**
   * Derive a stable key for an intended side effect.
   *
   * Content is part of the key: sending a *different* message to the same
   * person is a different effect, and must not be suppressed as a duplicate.
   * The parts are JSON-encoded so a value containing the separator cannot
   * forge a different tuple that hashes the same.
   */
  static idempotencyKey(parts: EffectIntent): string {
    const canonical = JSON.stringify([parts.runId, parts.stepIdx, parts.kind, parts.target, parts.content ?? '']);
    return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  }

  /**
   * Record intent. Returns the existing row if this effect was already
   * attempted, so the caller can check for evidence instead of re-running it.
   */
  intendEffect(key: string, e: EffectIntent): { fresh: boolean; existing?: Record<string, unknown> } {
    const existing = this.#db.prepare('SELECT * FROM effects WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    if (existing) return { fresh: false, existing };
    this.#db.prepare(`
      INSERT INTO effects (idempotency_key, run_id, step_idx, kind, target, content, status, intended_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(key, e.runId, e.stepIdx, e.kind, e.target, e.content ?? null, 'intended', new Date().toISOString());
    return { fresh: true };
  }

  settleEffect(key: string, status: EffectStatus, evidence?: string): void {
    this.#db.prepare(
      'UPDATE effects SET status = ?, settled_at = ?, evidence = ? WHERE idempotency_key = ?',
    ).run(status, new Date().toISOString(), evidence ?? null, key);
  }

  getEffect(key: string): Record<string, unknown> | undefined {
    return this.#db.prepare('SELECT * FROM effects WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
  }

  /**
   * Effects recorded as intended but never settled — the exact set a crash
   * leaves behind, and the only ones a human needs to check by hand.
   */
  unsettledEffects(): Array<Record<string, unknown>> {
    return this.#db.prepare("SELECT * FROM effects WHERE status = 'intended'").all() as Array<Record<string, unknown>>;
  }
}
