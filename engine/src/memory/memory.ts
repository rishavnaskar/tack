/**
 * The memory layer: skills, lessons, episodic identity, documents.
 *
 * Shares the SQLite file with the trajectory store — one database, because
 * a lesson is only meaningful next to the run that produced it.
 */

import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { MEMORY_SCHEMA } from './schema.ts';
import { bm25, tokenize, termFrequencies, chunkText, refoldPostings, type ScoredDoc } from './retrieval.ts';
import { SiteKnowledge, siteKey } from './knowledge.ts';
import { ephemeralDirs, safeFilename, sizeOf } from './document-files.ts';
import { extractTextOffThread } from './import.ts';
import { readerText } from './document-instructions.ts';

type SkillStatus = 'proposed' | 'shadow' | 'active' | 'quarantined' | 'retired';

interface SkillTarget {
  /** Role and accessible name — the durable way to name an element. */
  role: string;
  name: string;
  /** Optional structural anchor, e.g. "within nav[aria-label='Jobs']". */
  anchor?: string;
}

export interface SkillStep {
  act: string;
  target?: SkillTarget;
  value?: string;
  key?: string;
  url?: string;
  /** Assertion that must hold after this step for replay to continue. */
  checkpoint?: { role: string; name?: string; minCount?: number; urlPattern?: string };
}

export interface Skill {
  id: string;
  domain: string;
  intent: string;
  params: string[];
  steps: SkillStep[];
  status: SkillStatus;
  version: number;
  runs: number;
  successes: number;
  consecutiveFailures: number;
  p50Ms: number | null;
  lastOkAt: string | null;
  lastError: string | null;
}

type LessonStatus = 'proposed' | 'shadow' | 'active' | 'unproven' | 'rejected';

export interface Lesson {
  id: string;
  domain: string;
  taskType: string;
  trigger: string;
  lesson: string;
  confidence: number;
  uses: number;
  helped: number;
  status: LessonStatus;
  gateVerdict: string | null;
  shadowRuns: number;
  shadowSuccesses: number;
}

/** A file given to Fanfold, a site's own data export, or text read from the owner's profile page on a site. */
export type DocumentKind = 'file' | 'export' | 'site';

interface EpisodicRecord {
  identityKey: string;
  kind: 'person' | 'company';
  displayName?: string;
  runId?: string;
}

/** Two consecutive failures quarantine a skill. Not three: a skill that fails
 *  twice in a row is stale, and replaying a stale skill is worse than not
 *  having one, because it looks like progress. */
const QUARANTINE_AFTER = 2;

export class Memory {
  #db: DatabaseSync;

  #documentsDirOverride: string | null;

  #knowledge: SiteKnowledge | null = null;

  /** Whole texts read back by documentText, by document: a document's text never changes once it has one. */
  readonly #texts = new Map<string, string>();

  /**
   * `knowledgeDir` is where each site's notes are kept as files. It defaults
   * to `knowledge` beside the database; an in-memory database keeps none.
   */
  constructor(db: DatabaseSync, opts: { documentsDir?: string; knowledgeDir?: string | null } = {}) {
    this.#db = db;
    this.#documentsDirOverride = opts.documentsDir ?? null;
    // Columns first, then the schema. The schema's indexes reference columns
    // the lifecycle added, so on an older database it cannot run until the
    // ALTERs have — which is the situation a migration exists for.
    this.#migrate();
    this.#db.exec(MEMORY_SCHEMA);
    refoldPostings(this.#db);
    const knowledgeDir = opts.knowledgeDir === undefined ? this.#besideDatabase('knowledge') : opts.knowledgeDir;
    if (knowledgeDir) {
      this.#knowledge = new SiteKnowledge(this, knowledgeDir);
      this.#knowledge.syncAll();
    }
  }

  /** The site knowledge files, when this memory keeps them. */
  get knowledge(): SiteKnowledge | null {
    return this.#knowledge;
  }

  #besideDatabase(name: string): string | null {
    const [main] = this.#db.prepare('PRAGMA database_list').all() as Array<{ file?: string }>;
    return main?.file ? join(dirname(main.file), name) : null;
  }

  #changed(domain: string | undefined): void {
    const host = domain ? siteKey(domain) : '';
    if (host && host !== '*') this.#knowledge?.changed(host);
  }

  /**
   * Bring an older database forward.
   *
   * A lesson written before the lifecycle existed has no status, and
   * defaulting those to 'active' would silently promote every ungated
   * conclusion the reflector ever wrote. They start as 'proposed' and have to
   * earn their way in like anything else.
   */
  #migrate(): void {
    const columns = this.#db.prepare("PRAGMA table_info('lessons')").all() as Array<{ name: string }>;
    if (!columns.length) return; // fresh database; the schema creates it correctly

    const have = new Set(columns.map((c) => c.name));
    const columnsOnLearning = this.#db.prepare("PRAGMA table_info('learning_state')").all() as Array<{ name: string }>;
    if (columnsOnLearning.length && !columnsOnLearning.some((c) => c.name === 'last_run_ended_at')) {
      this.#db.exec('ALTER TABLE learning_state ADD COLUMN last_run_ended_at TEXT');
      // A start-ordered watermark cannot be converted into a completion-
      // ordered one, and guessing would either re-reflect everything or skip
      // something. Clearing it re-reflects once, which is the safe direction.
      this.#db.exec('UPDATE learning_state SET last_run_ended_at = NULL');
    }

    const additions: Array<[string, string]> = [
      ['status', "TEXT NOT NULL DEFAULT 'proposed'"],
      ['fingerprint', 'TEXT'],
      ['gate_verdict', 'TEXT'],
      ['gated_at', 'TEXT'],
      ['shadow_runs', 'INTEGER NOT NULL DEFAULT 0'],
      ['shadow_successes', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, decl] of additions) {
      if (!have.has(name)) this.#db.exec(`ALTER TABLE lessons ADD COLUMN ${name} ${decl}`);
    }

    // Documents imported before the app retained its own copy have no
    // artifact, so they stay un-attachable until they are imported again.
    // That is the honest state: their bytes were never kept.
    const onDocuments = this.#db.prepare("PRAGMA table_info('documents')").all() as Array<{ name: string }>;
    const haveDoc = new Set(onDocuments.map((c) => c.name));
    if (onDocuments.length) {
      for (const [name, decl] of [['file_path', 'TEXT'], ['file_sha256', 'TEXT'], ['imported_by', 'TEXT'], ['held_why', 'TEXT']] as const) {
        if (!haveDoc.has(name)) this.#db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${decl}`);
      }
      // What the owner imported was always theirs; an agent's import waits for them to say so.
      if (!haveDoc.has('trusted')) {
        this.#db.exec('ALTER TABLE documents ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0');
        this.#db.exec('UPDATE documents SET trusted = 1 WHERE imported_by IS NULL');
      }
      if (!haveDoc.has('kind')) this.#db.exec("ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'");
      if (!haveDoc.has('ignored_lines')) this.#db.exec('ALTER TABLE documents ADD COLUMN ignored_lines INTEGER');
    }
  }

  // ---------------------------------------------------------------- skills

  proposeSkill(given: Omit<Skill, 'id' | 'status' | 'version' | 'runs' | 'successes' | 'consecutiveFailures' | 'p50Ms' | 'lastOkAt' | 'lastError'> & { inducedFrom?: string }): string {
    const s = { ...given, domain: siteKey(given.domain) };
    const id = `${s.domain}.${s.intent}`.replace(/[^a-z0-9._-]/gi, '_');
    this.#db.prepare(`
      INSERT INTO skills (id, domain, intent, params, steps, status, created_at, induced_from)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        steps = excluded.steps,
        params = excluded.params,
        version = skills.version + 1,
        status = 'proposed',
        consecutive_failures = 0
    `).run(id, s.domain, s.intent, JSON.stringify(s.params), JSON.stringify(s.steps),
           'proposed', new Date().toISOString(), s.inducedFrom ?? null);
    this.#changed(s.domain);
    return id;
  }

  /**
   * Move a skill along its lifecycle. Promotion to `active` is refused here
   * rather than trusted to the caller: a skill that can promote itself is not
   * gated by anything, and "self-improving" then means "drifts unobserved".
   */
  setSkillStatus(id: string, status: SkillStatus, opts: { evalPassed?: boolean } = {}): void {
    if (status === 'active' && !opts.evalPassed) {
      throw new Error(`refusing to activate ${id}: promotion requires a passing eval (see eval/gate.ts)`);
    }
    this.#db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(status, id);
    this.#changed(this.getSkill(id)?.domain);
  }

  findSkill(domain: string, intent: string, statuses: SkillStatus[] = ['active']): Skill | null {
    const placeholders = statuses.map(() => '?').join(',');
    const row = this.#db.prepare(
      `SELECT * FROM skills WHERE domain = ? AND intent = ? AND status IN (${placeholders}) LIMIT 1`,
    ).get(domain, intent, ...statuses) as Record<string, unknown> | undefined;
    return row ? rowToSkill(row) : null;
  }

  getSkill(id: string): Skill | null {
    const row = this.#db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToSkill(row) : null;
  }

  recordSkillRun(id: string, ok: boolean, ms: number, error?: string): SkillStatus {
    const skill = this.getSkill(id);
    if (!skill) throw new Error(`no such skill: ${id}`);

    const runs = skill.runs + 1;
    const successes = skill.successes + (ok ? 1 : 0);
    const consecutive = ok ? 0 : skill.consecutiveFailures + 1;
    // A running median would need the full history; the exponential estimate
    // is enough to spot a skill getting slower, which is all this is for.
    const p50 = skill.p50Ms === null ? ms : Math.round(skill.p50Ms * 0.8 + ms * 0.2);

    let status = skill.status;
    if (!ok && consecutive >= QUARANTINE_AFTER && status === 'active') status = 'quarantined';

    this.#db.prepare(`
      UPDATE skills SET runs = ?, successes = ?, consecutive_failures = ?, p50_ms = ?,
                        status = ?, last_ok_at = ?, last_error = ?
      WHERE id = ?
    `).run(runs, successes, consecutive, p50, status,
           ok ? new Date().toISOString() : skill.lastOkAt, ok ? null : (error ?? 'unknown'), id);
    if (status !== skill.status) this.#changed(skill.domain);
    return status;
  }

  listSkills(status?: SkillStatus): Skill[] {
    const rows = status
      ? this.#db.prepare('SELECT * FROM skills WHERE status = ? ORDER BY domain, intent').all(status)
      : this.#db.prepare('SELECT * FROM skills ORDER BY domain, intent').all();
    return (rows as Array<Record<string, unknown>>).map(rowToSkill);
  }

  // --------------------------------------------------------------- lessons

  /**
   * Append a lesson.
   *
   * Never updates an existing row: to revise a lesson, write a new one that
   * supersedes it, so the history of what the agent believed stays
   * inspectable.
   *
   * Identical content is NOT appended again, whatever its current status.
   * Reflection runs repeatedly over overlapping windows of runs, and without
   * this the same conclusion accumulates duplicate rows and the gate spends a
   * full eval suite re-deciding something it already decided — including
   * re-proposing lessons it previously rejected.
   */
  addLesson(
    l: Omit<Lesson, 'id' | 'uses' | 'helped' | 'status' | 'gateVerdict' | 'shadowRuns' | 'shadowSuccesses'>
      & { evidenceRun?: string; supersedes?: string },
  ): string {
    const fingerprint = lessonFingerprint(l.domain, l.taskType, l.trigger, l.lesson);
    const existing = this.#db.prepare('SELECT id FROM lessons WHERE fingerprint = ?')
      .get(fingerprint) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO lessons (id, domain, task_type, trigger, lesson, evidence_run, confidence,
                           supersedes, created_at, fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, l.domain, l.taskType, l.trigger, l.lesson, l.evidenceRun ?? null,
           l.confidence, l.supersedes ?? null, new Date().toISOString(), fingerprint);
    if (l.supersedes) {
      this.#db.prepare('UPDATE lessons SET retired = 1 WHERE id = ?').run(l.supersedes);
    }
    this.#changed(l.domain);
    return id;
  }

  // -------------------------------------------------------- learning state

  /**
   * The position in COMPLETION order already reflected on.
   *
   * Completion, not start: a run that began first can finish last, and a
   * start-ordered watermark skips it permanently. A browser task running for
   * hours would never reach memory or the evals at all.
   */
  learningWatermark(): { lastRunId: string | null; lastRunEndedAt: string | null; passes: number } {
    const row = this.#db.prepare("SELECT * FROM learning_state WHERE id = 'singleton'").get() as
      { last_run_id: string | null; last_run_ended_at: string | null; passes: number } | undefined;
    return {
      lastRunId: row?.last_run_id ?? null,
      lastRunEndedAt: row?.last_run_ended_at ?? null,
      passes: row?.passes ?? 0,
    };
  }

  /** Advance to (endedAt, runId), which is a total order over finished runs. */
  advanceLearningWatermark(runId: string | null, endedAt: string | null): void {
    this.#db.prepare(`
      INSERT INTO learning_state (id, last_run_id, last_run_ended_at, passes, last_pass_at)
      VALUES ('singleton', ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_run_id = COALESCE(excluded.last_run_id, learning_state.last_run_id),
        last_run_ended_at = COALESCE(excluded.last_run_ended_at, learning_state.last_run_ended_at),
        passes = learning_state.passes + 1,
        last_pass_at = excluded.last_pass_at
    `).run(runId, endedAt, new Date().toISOString());
  }

  getLesson(id: string): Lesson | null {
    const row = this.#db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToLesson(row) : null;
  }

  allLessons(includeRetired = false): Lesson[] {
    const rows = includeRetired
      ? this.#db.prepare('SELECT * FROM lessons ORDER BY created_at').all()
      : this.#db.prepare('SELECT * FROM lessons WHERE retired = 0 ORDER BY created_at').all();
    return (rows as Array<Record<string, unknown>>).map(rowToLesson);
  }

  /**
   * Retire a lesson, recording why.
   *
   * Retiring rather than deleting: a lesson the gate rejected is evidence
   * about what the reflector gets wrong, and deleting it throws that away.
   */
  retireLesson(id: string, reason: string): void {
    this.#db.prepare("UPDATE lessons SET retired = 1, trigger = trigger || ' [retired: ' || ? || ']' WHERE id = ?")
      .run(reason, id);
    this.#changed(this.getLesson(id)?.domain);
  }

  /**
   * Bring back a lesson retired for any reason but a rejection: a person
   * deleted a note from its file and then wrote it back.
   */
  reviveLesson(id: string): boolean {
    const row = this.#db.prepare('SELECT trigger, status, retired FROM lessons WHERE id = ?').get(id) as
      { trigger: string; status: string; retired: number } | undefined;
    if (!row || !row.retired || row.status === 'rejected') return false;
    const trigger = row.trigger.replace(/(?: \[retired: [^\]]*\])+$/, '');
    this.#db.prepare("UPDATE lessons SET retired = 0, trigger = ?, status = 'proposed' WHERE id = ?").run(trigger, id);
    this.#changed(this.getLesson(id)?.domain);
    return true;
  }

  /** The lesson recorded under this content, retired or not. */
  lessonWithFingerprint(fingerprint: string): (Lesson & { retired: boolean }) | null {
    const row = this.#db.prepare('SELECT * FROM lessons WHERE fingerprint = ?').get(fingerprint) as Record<string, unknown> | undefined;
    return row ? { ...rowToLesson(row), retired: Number(row.retired) === 1 } : null;
  }

  /**
   * A site's own notes, still in use or waiting to be checked: checked ones
   * first, then in the order they were learned. Rejected and retired notes
   * are left out.
   */
  siteNotes(domain: string, limit = 200): Array<Lesson & { createdAt: string }> {
    const rows = this.#db.prepare(`
      SELECT * FROM lessons
      WHERE retired = 0 AND domain = ? AND status IN ('active', 'proposed', 'shadow', 'unproven')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at, rowid
      LIMIT ?
    `).all(domain, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...rowToLesson(r), createdAt: String(r.created_at) }));
  }

  /** Every site with notes in use or waiting, or a flow in use. */
  knownSites(): string[] {
    const rows = this.#db.prepare(`
      SELECT domain FROM lessons WHERE retired = 0 AND status IN ('active', 'proposed', 'shadow', 'unproven') AND domain != '*'
      UNION SELECT domain FROM skills WHERE status = 'active'
    `).all() as Array<{ domain: string }>;
    return rows.map((r) => r.domain).sort();
  }

  knowledgeRecord(host: string): { sha256: string; notes: string[] } | null {
    const row = this.#db.prepare('SELECT sha256, notes FROM knowledge_files WHERE host = ?').get(host) as
      { sha256: string; notes: string } | undefined;
    return row ? { sha256: row.sha256, notes: JSON.parse(row.notes) as string[] } : null;
  }

  setKnowledgeRecord(host: string, sha256: string, notes: string[]): void {
    this.#db.prepare(`
      INSERT INTO knowledge_files (host, sha256, notes, written_at) VALUES (?,?,?,?)
      ON CONFLICT(host) DO UPDATE SET sha256 = excluded.sha256, notes = excluded.notes, written_at = excluded.written_at
    `).run(host, sha256, JSON.stringify(notes), new Date().toISOString());
  }

  /**
   * Retrieve lessons for a situation.
   *
   * Only ACTIVE lessons — ones a gate has measured — reach a running task.
   * Domain and task type filter first, and text similarity only orders what
   * survives: a lesson about LinkedIn job cards should never surface while
   * the agent is reading email, however similar the words are.
   */
  recallLessons(
    domain: string,
    taskType: string,
    context: string,
    limit = 5,
    options: { statuses?: LessonStatus[] } = {},
  ): Lesson[] {
    const statuses = options.statuses ?? ['active'];
    const placeholders = statuses.map(() => '?').join(',');
    // A '*' on either side of the query means "do not filter on this", so a
    // caller that does not classify task types still gets the site's lessons.
    const domainClause = domain === '*' ? '1=1' : "(domain = ? OR domain = '*')";
    const taskClause = taskType === '*' ? '1=1' : "(task_type = ? OR task_type = '*')";
    const params: SQLInputValue[] = [...statuses];
    if (domain !== '*') params.push(domain);
    if (taskType !== '*') params.push(taskType);

    const rows = this.#db.prepare(`
      SELECT * FROM lessons
      WHERE retired = 0 AND status IN (${placeholders}) AND ${domainClause} AND ${taskClause}
    `).all(...params) as Array<Record<string, unknown>>;
    if (rows.length <= limit) return rows.map(rowToLesson);

    const queryTerms = tokenize(context);
    const postings = new Map<string, Array<{ id: string; tf: number }>>();
    const lengths = new Map<string, number>();
    for (const row of rows) {
      const tf = termFrequencies(`${row.trigger} ${row.lesson}`);
      let len = 0;
      for (const [term, count] of tf) {
        len += count;
        const list = postings.get(term) ?? [];
        list.push({ id: String(row.id), tf: count });
        postings.set(term, list);
      }
      lengths.set(String(row.id), len);
    }
    const avg = [...lengths.values()].reduce((a, b) => a + b, 0) / (lengths.size || 1);
    const ranked = bm25(queryTerms, { postings, lengths, totalDocs: rows.length, avgLength: avg }, limit);

    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const picked = ranked.map((r) => byId.get(r.id)).filter(Boolean) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (picked.length >= limit) break;
      if (!picked.includes(row)) picked.push(row);
    }
    return picked.slice(0, limit).map(rowToLesson);
  }

  /** Record what the gate decided, and why. */
  setLessonStatus(id: string, status: LessonStatus, verdict: string): void {
    this.#db.prepare(
      'UPDATE lessons SET status = ?, gate_verdict = ?, gated_at = ? WHERE id = ?',
    ).run(status, verdict, new Date().toISOString(), id);
    this.#changed(this.getLesson(id)?.domain);
  }

  /**
   * Record how a run that consulted an ACTIVE lesson turned out.
   *
   * This is monitoring, not promotion evidence. Only active lessons are
   * recalled, so only active lessons ever accumulate these counts; promoting
   * an unproven lesson on them would be a route that never opens. What they
   * are good for is noticing that a promoted lesson has stopped helping.
   */
  recordLessonShadowRun(id: string, succeeded: boolean): void {
    this.#db.prepare(
      'UPDATE lessons SET shadow_runs = shadow_runs + 1, shadow_successes = shadow_successes + ? WHERE id = ?',
    ).run(succeeded ? 1 : 0, id);
  }

  lessonsByStatus(status: LessonStatus): Lesson[] {
    return (this.#db.prepare('SELECT * FROM lessons WHERE status = ? AND retired = 0 ORDER BY created_at')
      .all(status) as Array<Record<string, unknown>>).map(rowToLesson);
  }

  markLessonUsed(id: string, helped: boolean): void {
    this.#db.prepare(
      'UPDATE lessons SET uses = uses + 1, helped = helped + ? WHERE id = ?',
    ).run(helped ? 1 : 0, id);
  }

  // -------------------------------------------------------------- episodic

  /**
   * Normalise an identity into a stable key.
   *
   * Everything about deduplication rests on this being deterministic: the same
   * person must always produce the same key, and two different people must
   * never collide. Hence URL normalisation rather than name matching.
   */
  static identityKey(kind: 'person' | 'company', raw: string): string {
    let normalised = raw.trim().toLowerCase();
    try {
      const url = new URL(normalised);
      // Strip tracking parameters and trailing slashes; keep the path, which
      // is what identifies the profile.
      normalised = `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      normalised = normalised.replace(/\s+/g, ' ');
    }
    return `${kind}:${createHash('sha256').update(normalised).digest('hex').slice(0, 24)}`;
  }

  /** Record that an identity was surfaced. Returns false if it is a repeat. */
  surface(rec: EpisodicRecord): boolean {
    const now = new Date().toISOString();
    const existing = this.#db.prepare('SELECT surfaced_count FROM episodic WHERE identity_key = ?')
      .get(rec.identityKey) as { surfaced_count: number } | undefined;

    if (existing) {
      this.#db.prepare(
        'UPDATE episodic SET last_seen_at = ?, surfaced_count = surfaced_count + 1 WHERE identity_key = ?',
      ).run(now, rec.identityKey);
      return false;
    }
    this.#db.prepare(`
      INSERT INTO episodic (identity_key, kind, display_name, first_seen_at, last_seen_at, surfaced_count, run_id)
      VALUES (?,?,?,?,?,1,?)
    `).run(rec.identityKey, rec.kind, rec.displayName ?? null, now, now, rec.runId ?? null);
    return true;
  }

  /** When this identity was last contacted, or null if never. Exact, never fuzzy. */
  contactedAt(identityKey: string): string | null {
    const first = this.#firstContact(identityKey);
    if (!first) return null;
    const again = this.#db.prepare('SELECT MAX(at) AS at FROM contact_repeats WHERE identity_key = ?')
      .get(first.key) as { at: string | null };
    return again.at ?? first.at;
  }

  /**
   * A token that changes every time this identity is contacted, or null if it
   * never was. An approval remembers the one it was raised under, so it can
   * tell a contact it told its reader about from one made since.
   */
  contactMark(identityKey: string): string | null {
    const first = this.#firstContact(identityKey);
    if (!first) return null;
    const again = this.#db.prepare('SELECT COUNT(*) AS n FROM contact_repeats WHERE identity_key = ?')
      .get(first.key) as { n: number };
    return `${first.at}+${again.n}`;
  }

  /** A further contact with someone already contacted, which a person approved knowing it was one. */
  recordRepeatContact(identityKey: string, channel: string, content: string): void {
    const first = this.#firstContact(identityKey);
    if (!first) throw new Error(`cannot record a repeat contact for ${identityKey}: no first contact is on record`);
    this.#db.prepare('INSERT INTO contact_repeats (identity_key, at, channel, content) VALUES (?,?,?,?)')
      .run(first.key, new Date().toISOString(), channel, content);
  }

  #firstContact(identityKey: string): { key: string; at: string } | null {
    const row = this.#db.prepare('SELECT contacted_at FROM episodic WHERE identity_key = ?')
      .get(identityKey) as { contacted_at: string | null } | undefined;
    return row?.contacted_at ? { key: identityKey, at: row.contacted_at } : null;
  }

  /**
   * The key a person is known by, from the identity the page gave for them.
   *
   * A heading-derived identity used to be `host/heading:name` and now carries
   * its page's path. Someone contacted under the older spelling keeps that
   * key, so they do not read as never contacted.
   */
  personKey(identity: string): string {
    const key = Memory.identityKey('person', identity);
    const older = identity.replace(/^([^/]+)\/.*\/(heading:.*)$/, '$1/$2');
    if (older === identity || this.#firstContact(key)) return key;
    const olderKey = Memory.identityKey('person', older);
    return this.#firstContact(olderKey) ? olderKey : key;
  }

  /** Record an actual outbound contact. Refuses to overwrite an earlier one. */
  recordContact(identityKey: string, channel: string, content: string): void {
    const row = this.#db.prepare('SELECT contacted_at FROM episodic WHERE identity_key = ?')
      .get(identityKey) as { contacted_at: string | null } | undefined;
    if (!row) throw new Error(`cannot record contact for unknown identity ${identityKey}`);
    if (row.contacted_at) {
      throw new Error(
        `${identityKey} was already contacted at ${row.contacted_at}; refusing to record a second contact`,
      );
    }
    this.#db.prepare(
      'UPDATE episodic SET contacted_at = ?, contact_channel = ?, contact_content = ? WHERE identity_key = ?',
    ).run(new Date().toISOString(), channel, content, identityKey);
  }

  // ------------------------------------------------------------- documents

  /**
   * Where retained copies of imported files live: beside the database they
   * belong to. For the real app that is the application-support directory;
   * for a database somewhere else (a test, a scratch copy) the files follow
   * it there instead of accumulating in the user's own state directory.
   *
   * An IN-MEMORY database has no file to sit beside, so its copies get a
   * throwaway directory, removed when the process exits (document-files.ts).
   * Otherwise every test using `:memory:` would write real files into the
   * place the product keeps its own data, and a run that leaves artifacts
   * there is not isolated, however in-memory its tables are.
   */
  #documentsDir(): string {
    if (this.#documentsDirOverride) return this.#documentsDirOverride;
    const beside = this.#besideDatabase('documents');
    if (beside) {
      this.#documentsDirOverride = beside;
    } else {
      this.#documentsDirOverride = mkdtempSync(join(tmpdir(), 'browser-agent-ephemeral-'));
      ephemeralDirs.add(this.#documentsDirOverride);
    }
    return this.#documentsDirOverride;
  }

  /** A document already imported from exactly these bytes, if one is still on file, held or not. */
  documentWithSha(sha: string): { id: string; title: string; characters: number; held: string | null } | null {
    const row = this.#db.prepare('SELECT id, title, bytes, held_why FROM documents WHERE file_sha256 = ? ORDER BY added_at DESC LIMIT 1')
      .get(sha) as { id: string; title: string; bytes: number | null; held_why: string | null } | undefined;
    return row ? { id: row.id, title: row.title, characters: row.bytes ?? 0, held: row.held_why } : null;
  }

  /**
   * Import a document, optionally keeping its bytes.
   *
   * `bytes` is what makes a document attachable later. It is copied into a
   * directory the app owns rather than remembered as a path, for two reasons:
   * a file imported through the chat UI arrives as bytes over HTTP and has no
   * path at all, and a path on the user's disk can be edited, moved or
   * replaced after import — so the file an upload attached would no longer be
   * the file whose text was indexed and shown to them.
   */
  addDocument(doc: {
    title: string; text: string; sourcePath?: string; mime?: string; bytes?: Uint8Array;
    /** The outside agent that imported it; left out when the owner did. */
    importedBy?: string | null;
    /** Why it waits for the owner's OK before anything reads it. */
    held?: string | null;
    /** What it is; anything but a file is text alone and never keeps bytes, so it can never be attached. */
    kind?: DocumentKind;
  }): string {
    const id = randomUUID();
    const kind = doc.kind ?? 'file';

    let filePath: string | null = null;
    let sha: string | null = null;
    if (doc.bytes?.length && kind === 'file') {
      // One directory per document, so the copy can keep the NAME the user
      // gave it without two imports colliding. The name matters: it is sent
      // with the file, and a resume arriving as "3f8a…c1.pdf" is not what
      // someone meant to submit.
      const dir = join(this.#documentsDir(), id);
      mkdirSync(dir, { recursive: true });
      filePath = join(dir, safeFilename(doc.title, doc.mime));
      writeFileSync(filePath, doc.bytes, { mode: 0o600 });
      sha = createHash('sha256').update(doc.bytes).digest('hex');
    }

    this.#db.prepare(
      'INSERT INTO documents (id, title, source_path, file_path, file_sha256, mime, added_at, bytes, imported_by, held_why, trusted, kind, ignored_lines) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, doc.title, doc.sourcePath ?? null, filePath, sha, doc.mime ?? null,
          new Date().toISOString(), doc.text.length, doc.importedBy?.slice(0, 120) ?? null, doc.held ?? null, doc.importedBy ? 0 : 1, kind, readerText(doc.text).ignored);
    this.#index(id, doc.text);
    return id;
  }

  /** The documents kept from one source, such as `site:linkedin`, newest first. */
  documentsFrom(sourcePath: string): string[] {
    return (this.#db.prepare('SELECT id FROM documents WHERE source_path = ? ORDER BY added_at DESC').all(sourcePath) as Array<{ id: string }>)
      .map((r) => r.id);
  }

  /** The outside agent that imported a document, or null when the owner did. */
  documentImportedBy(id: string): string | null {
    const row = this.#db.prepare('SELECT imported_by FROM documents WHERE id = ?').get(id) as { imported_by: string | null } | undefined;
    return row?.imported_by ?? null;
  }

  /** The owner gave Fanfold this document themselves, whoever imported it first, so it waits for nothing. */
  ownDocument(id: string): void {
    this.#db.prepare('UPDATE documents SET imported_by = NULL, held_why = NULL, trusted = 1 WHERE id = ?').run(id);
  }

  /**
   * The owner says a document is theirs, so what it says about them may answer
   * applications. Saying so also allows one still waiting. False if there is no such document.
   */
  trustDocument(id: string): boolean {
    return Number(this.#db.prepare('UPDATE documents SET trusted = 1, held_why = NULL WHERE id = ?').run(id).changes) > 0;
  }

  /** How many lines of a document read as orders to a reader, and were kept from every reader of its facts. */
  noteIgnoredLines(id: string, n: number): void {
    this.#db.prepare('UPDATE documents SET ignored_lines = ? WHERE id = ?').run(n, id);
  }

  /** Whether the owner imported this document or said it is theirs. */
  documentTrusted(id: string): boolean {
    const row = this.#db.prepare('SELECT trusted, held_why FROM documents WHERE id = ?').get(id) as { trusted: number; held_why: string | null } | undefined;
    return !!row && Number(row.trusted) === 1 && row.held_why === null;
  }

  /**
   * A document's whole text, read again from the kept file the way it was
   * first read, so a quote can be checked against it: the stored chunks
   * overlap, and the first ones are not the whole of it. Pasted text has no
   * file, so it is put back together from its chunks. Null for a document
   * that waits for the owner's OK or has no text.
   */
  async documentText(id: string, opts: { includeHeld?: boolean } = {}): Promise<string | null> {
    const row = this.#db.prepare('SELECT file_path, mime, held_why FROM documents WHERE id = ?').get(id) as
      { file_path: string | null; mime: string | null; held_why: string | null } | undefined;
    // Only the check of whose a waiting document is reads it before the owner allows it.
    if (!row || (row.held_why !== null && !opts.includeHeld)) return null;
    const cached = this.#texts.get(id);
    if (cached !== undefined) return cached || null;
    let text = '';
    if (row.file_path && existsSync(row.file_path)) {
      const extracted = await extractTextOffThread(await readFile(row.file_path), row.mime ?? undefined).catch(() => null);
      if (extracted?.ok) text = extracted.text;
    }
    if (!text.trim()) {
      const chunks = this.#db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY idx').all(id) as Array<{ text: string }>;
      text = unchunk(chunks.map((c) => c.text));
    }
    this.#texts.set(id, text);
    return text || null;
  }

  /** A document waiting for the owner's OK: its title and why. */
  documentHeld(id: string): { title: string; why: string } | null {
    const row = this.#db.prepare('SELECT title, held_why FROM documents WHERE id = ? AND held_why IS NOT NULL').get(id) as
      { title: string; held_why: string } | undefined;
    return row ? { title: row.title, why: row.held_why } : null;
  }

  /** Why a document still waits for the owner's OK, said again once the reason changed. False if it no longer waits. */
  holdDocument(id: string, why: string): boolean {
    return Number(this.#db.prepare('UPDATE documents SET held_why = ? WHERE id = ? AND held_why IS NOT NULL').run(why, id).changes) > 0;
  }

  /** The owner's OK for a held document, which makes it theirs: attaching it does not ask again. False if none was waiting. */
  releaseDocument(id: string): boolean {
    return Number(this.#db.prepare('UPDATE documents SET held_why = NULL, imported_by = NULL WHERE id = ? AND held_why IS NOT NULL').run(id).changes) > 0;
  }

  /** Text for a document kept without any, once it can be read. False if it already has text. */
  fillDocumentText(id: string, text: string): boolean {
    const changed = Number(this.#db.prepare(
      'UPDATE documents SET bytes = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM chunks WHERE document_id = ?)',
    ).run(text.length, id, id).changes);
    if (changed) {
      this.#texts.delete(id);
      this.#index(id, text);
    }
    return changed > 0;
  }

  #index(id: string, text: string): void {
    const chunks = chunkText(text);
    const insertChunk = this.#db.prepare(
      'INSERT INTO chunks (id, document_id, idx, text, token_estimate) VALUES (?,?,?,?,?)',
    );
    const insertPosting = this.#db.prepare(
      'INSERT INTO postings (term, chunk_id, tf) VALUES (?,?,?) ON CONFLICT(term, chunk_id) DO UPDATE SET tf = tf + excluded.tf',
    );
    chunks.forEach((chunk, idx) => {
      const chunkId = `${id}:${idx}`;
      insertChunk.run(chunkId, id, idx, chunk, Math.ceil(chunk.length / 4));
      for (const [term, tf] of termFrequencies(chunk)) insertPosting.run(term, chunkId, tf);
    });
  }

  /**
   * Search the user's documents.
   *
   * `minTerms` is the guard against leakage, and it counts distinct query
   * terms rather than thresholding the score. BM25 scores are relative to the
   * corpus — the same relevance scores differently with one document than
   * with fifty — so an absolute floor would quietly stop retrieving anything
   * as the library grows. Requiring several query terms to actually be
   * present means an unrelated task retrieves nothing, which is correct.
   * Only whole words count toward it: "post" finding "PostgreSQL" helps a
   * search, and is no evidence that a task is about the document.
   * A document waiting for the owner's OK is never searched.
   */
  searchDocuments(
    query: string,
    limit = 5,
    options: { minScore?: number; minTerms?: number } = {},
  ): Array<{ chunkId: string; documentId: string; title: string; text: string; score: number; matchedTerms: number }> {
    const minScore = options.minScore ?? 0;
    const minTerms = options.minTerms ?? 0;
    const terms = tokenize(query);
    if (!terms.length) return [];

    const unique = [...new Set(terms)];
    const placeholders = unique.map(() => '?').join(',');
    const exact = this.#db.prepare(
      `SELECT term, chunk_id, tf FROM postings WHERE term IN (${placeholders}) AND ${NOT_HELD}`,
    ).all(...unique) as Array<{ term: string; chunk_id: string; tf: number }>;
    // A word also finds the longer words it begins: "sponsor" finds "sponsorship".
    // Counted as the word asked for, so ranking stays about the query.
    const prefix = this.#db.prepare(`SELECT term, chunk_id, tf FROM postings WHERE term > ? AND term < ? AND ${NOT_HELD} LIMIT 400`);
    const longer = unique.filter((t) => t.length >= 4).flatMap((t) =>
      (prefix.all(t, `${t}\uffff`) as Array<{ term: string; chunk_id: string; tf: number }>).map((r) => ({ ...r, term: t })));
    const merged = new Map<string, { term: string; chunk_id: string; tf: number }>();
    for (const r of [...exact, ...longer]) {
      const key = `${r.term}\u0000${r.chunk_id}`;
      const had = merged.get(key);
      merged.set(key, had ? { ...had, tf: had.tf + r.tf } : r);
    }
    const rows = [...merged.values()];
    const whole = new Map<string, Set<string>>();
    for (const r of exact) whole.set(r.chunk_id, (whole.get(r.chunk_id) ?? new Set()).add(r.term));

    const postings = new Map<string, Array<{ id: string; tf: number }>>();
    const termsPerChunk = new Map<string, Set<string>>();
    for (const r of rows) {
      const list = postings.get(r.term) ?? [];
      list.push({ id: r.chunk_id, tf: r.tf });
      postings.set(r.term, list);
      const set = termsPerChunk.get(r.chunk_id) ?? new Set<string>();
      set.add(r.term);
      termsPerChunk.set(r.chunk_id, set);
    }

    const lenRows = this.#db.prepare('SELECT id, token_estimate FROM chunks').all() as Array<{ id: string; token_estimate: number }>;
    const lengths = new Map(lenRows.map((r) => [r.id, r.token_estimate]));
    const avg = lenRows.reduce((s, r) => s + r.token_estimate, 0) / (lenRows.length || 1);

    const ranked: ScoredDoc[] = bm25(terms, { postings, lengths, totalDocs: lenRows.length, avgLength: avg }, limit * 3);
    const eligible = ranked
      .filter((r) => r.score >= minScore && (whole.get(r.id)?.size ?? 0) >= minTerms)
      .slice(0, limit);
    if (!eligible.length) return [];

    const idPlaceholders = eligible.map(() => '?').join(',');
    const chunkRows = this.#db.prepare(`
      SELECT c.id, c.document_id, c.text, d.title
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (${idPlaceholders})
    `).all(...eligible.map((r) => r.id)) as Array<{ id: string; document_id: string; text: string; title: string }>;

    const byId = new Map(chunkRows.map((r) => [r.id, r]));
    return eligible
      .map((r) => {
        const row = byId.get(r.id);
        return row
          ? {
              chunkId: row.id, documentId: row.document_id, title: row.title,
              text: row.text, score: r.score, matchedTerms: termsPerChunk.get(r.id)?.size ?? 0,
            }
          : null;
      })
      .filter(Boolean) as Array<{ chunkId: string; documentId: string; title: string; text: string; score: number; matchedTerms: number }>;
  }

  /**
   * Documents the query names by TITLE — "my resume", "the cover letter".
   *
   * The BM25 guard asks that several of the query's words appear in a chunk,
   * which is right for incidental overlap and wrong for the commonest request
   * of all: "which of these should I apply to, given my resume?" shares no
   * content word with a resume, whose text says "TypeScript" and "Postgres"
   * rather than "resume". Naming a document is the strongest signal a person
   * can give that they want it used, so a title match brings in that
   * document's opening chunks regardless of overlap. Only a real word of the
   * title counts — not the extension, not a one-letter fragment.
   */
  documentsNamedIn(query: string, chunksPerDocument = 2): Array<{ chunkId: string; documentId: string; title: string; text: string }> {
    const words = new Set(tokenize(query));
    if (!words.size) return [];
    const out: Array<{ chunkId: string; documentId: string; title: string; text: string }> = [];
    for (const doc of this.listDocuments()) {
      const titleWords = tokenize(doc.title.replace(/\.[a-z0-9]{1,5}$/i, '')).filter((w) => w.length > 2);
      if (!titleWords.some((w) => words.has(w))) continue;
      const rows = this.#db.prepare(
        'SELECT id, text FROM chunks WHERE document_id = ? ORDER BY idx LIMIT ?',
      ).all(doc.id, chunksPerDocument) as Array<{ id: string; text: string }>;
      for (const r of rows) out.push({ chunkId: r.id, documentId: doc.id, title: doc.title, text: r.text });
    }
    return out;
  }

  /** The start of a document's text: enough to see whose it is. Nothing for one waiting for the owner's OK. */
  documentOpening(id: string, chunks = 2): string {
    const rows = this.#db.prepare(
      'SELECT c.text FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.document_id = ? AND d.held_why IS NULL ORDER BY c.idx LIMIT ?',
    ).all(id, chunks) as Array<{ text: string }>;
    return rows.map((r) => r.text).join('\n');
  }

  /**
   * `bytes` is how much text was read; `fileBytes` the kept file's own size, when a file is kept.
   * Documents waiting for the owner's OK are left out unless `includeHeld`, and then come first.
   */
  listDocuments(opts: { includeHeld?: boolean } = {}): Array<{
    id: string; title: string; addedAt: string; bytes: number; chunks: number; fileBytes: number | null; importedBy: string | null; held: string | null;
    /** The owner imported it or said it is theirs: what it says about them may answer applications. */
    trusted: boolean;
    kind: DocumentKind;
    /** Lines that read as orders to a reader, which no reader of its facts was given. */
    ignoredLines: number;
  }> {
    const rows = this.#db.prepare(`
      SELECT d.id, d.title, d.added_at AS addedAt, d.bytes, d.file_path AS filePath, d.imported_by AS importedBy, d.held_why AS held,
             d.trusted, d.kind, COALESCE(d.ignored_lines, 0) AS ignoredLines, (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunks
      FROM documents d ${opts.includeHeld ? '' : 'WHERE d.held_why IS NULL'} ORDER BY d.held_why IS NULL, d.added_at DESC
    `).all() as Array<{
      id: string; title: string; addedAt: string; bytes: number; chunks: number; filePath: string | null; importedBy: string | null; held: string | null; trusted: number;
      kind: DocumentKind; ignoredLines: number;
    }>;
    return rows.map(({ filePath, trusted, ...d }) => ({
      ...d, fileBytes: filePath ? sizeOf(filePath) : null, trusted: Number(trusted) === 1 && d.held === null,
    }));
  }

  /**
   * A document's original file, if it is still where it was imported from.
   *
   * The only way a path reaches an upload. A model names a document id; this
   * turns it into a path, and anything that is not an imported document has
   * no path to give — so no prompt, page, or reasoning step can talk the
   * agent into attaching an arbitrary file.
   */
  uploadableDocument(id: string): { id: string; title: string; path: string } | null {
    const row = this.#db.prepare(
      'SELECT id, title, file_path FROM documents WHERE id = ? AND held_why IS NULL',
    ).get(id) as { id: string; title: string; file_path: string | null } | undefined;
    // Deliberately NOT source_path. That is provenance; this is the copy the
    // app made and still owns. A document imported before the app kept its
    // own copy has no artifact and is not attachable — which is true, rather
    // than uploading whatever now sits at the path it came from.
    if (!row?.file_path) return null;
    if (!existsSync(row.file_path)) return null;
    return { id: row.id, title: row.title, path: row.file_path };
  }

  /** Imported documents whose original file is still on disk. */
  uploadableDocuments(): Array<{ id: string; title: string; path: string }> {
    return this.listDocuments()
      .map((d) => this.uploadableDocument(d.id))
      .filter(Boolean) as Array<{ id: string; title: string; path: string }>;
  }

  deleteDocument(id: string): void {
    // The retained copy goes with the row. Leaving a user's resume on disk
    // after they deleted it is not something to be casual about.
    const row = this.#db.prepare('SELECT file_path FROM documents WHERE id = ?').get(id) as
      { file_path: string | null } | undefined;
    // The whole per-document directory, not just the file inside it.
    if (row?.file_path) rmSync(dirname(row.file_path), { recursive: true, force: true });

    const chunks = this.#db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(id) as Array<{ id: string }>;
    for (const c of chunks) this.#db.prepare('DELETE FROM postings WHERE chunk_id = ?').run(c.id);
    this.#db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
    this.#db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    this.#texts.delete(id);
  }
}

/**
 * Chunks back into one text. Each chunk starts with the end of the one
 * before it, so that stretch is kept once; a short coincidence is not taken
 * for it.
 */
export function unchunk(chunks: string[]): string {
  let text = chunks[0] ?? '';
  for (const next of chunks.slice(1)) {
    let shared = 0;
    for (let k = Math.min(text.length, next.length, 400); k >= 8; k--) {
      if (text.endsWith(next.slice(0, k))) { shared = k; break; }
    }
    text += shared ? next.slice(shared) : `\n\n${next}`;
  }
  return text;
}

/** Postings of documents not waiting for the owner's OK. */
const NOT_HELD = 'chunk_id NOT IN (SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.held_why IS NOT NULL)';

/**
 * Content identity for a lesson.
 *
 * Normalised so trivial rewording does not read as a new conclusion: the
 * reflector is a language model and will phrase the same observation
 * differently across passes.
 */
export function lessonFingerprint(domain: string, taskType: string, trigger: string, lesson: string): string {
  const normalise = (t: string): string =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(JSON.stringify([domain.toLowerCase(), taskType.toLowerCase(), normalise(trigger), normalise(lesson)]))
    .digest('hex')
    .slice(0, 32);
}

function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    id: String(row.id),
    domain: String(row.domain),
    intent: String(row.intent),
    params: JSON.parse(String(row.params)) as string[],
    steps: JSON.parse(String(row.steps)) as SkillStep[],
    status: String(row.status) as SkillStatus,
    version: Number(row.version),
    runs: Number(row.runs),
    successes: Number(row.successes),
    consecutiveFailures: Number(row.consecutive_failures),
    p50Ms: row.p50_ms === null ? null : Number(row.p50_ms),
    lastOkAt: row.last_ok_at === null ? null : String(row.last_ok_at),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

function rowToLesson(row: Record<string, unknown>): Lesson {
  return {
    id: String(row.id),
    domain: String(row.domain),
    taskType: String(row.task_type),
    trigger: String(row.trigger),
    lesson: String(row.lesson),
    confidence: Number(row.confidence),
    uses: Number(row.uses),
    helped: Number(row.helped),
    status: (row.status ? String(row.status) : 'proposed') as LessonStatus,
    gateVerdict: row.gate_verdict === null || row.gate_verdict === undefined ? null : String(row.gate_verdict),
    shadowRuns: Number(row.shadow_runs ?? 0),
    shadowSuccesses: Number(row.shadow_successes ?? 0),
  };
}
