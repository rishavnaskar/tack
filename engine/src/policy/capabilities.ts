/**
 * Scoped, revocable capability grants.
 *
 * A single boolean covering every external action in a run is not a grant
 * anyone can reason about: it cannot say which worker, which site, which kind
 * of action, to whom, how many times, or until when — and it cannot be taken
 * back without editing the run.
 *
 * Autonomous workers genuinely need to act without a person watching. What
 * makes that safe is not trusting the agent more; it is making the permission
 * narrow enough to be worth giving, bounded enough that a mistake is finite,
 * and revocable the moment it looks wrong.
 *
 * Every grant is: one worker (or any), one set of sites, one set of
 * sensitivity classes, optionally specific action kinds and recipients, with
 * a use budget and an expiry. Consumption is recorded, so a grant that is
 * being spent faster than expected is visible rather than inferred.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Sensitivity } from '../types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capabilities (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  worker_id     TEXT,                 -- NULL = any caller
  domains       TEXT NOT NULL,        -- JSON string[]
  sensitivities TEXT NOT NULL,        -- JSON Sensitivity[]
  action_kinds  TEXT,                 -- JSON string[] or NULL = any
  recipients    TEXT,                 -- JSON string[] or NULL = any
  max_uses      INTEGER,              -- NULL = unlimited
  used_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS capabilities_live ON capabilities(revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS capability_uses (
  id            TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  at            TEXT NOT NULL,
  run_id        TEXT,
  url           TEXT,
  action        TEXT,
  sensitivity   TEXT,
  recipient     TEXT
);
CREATE INDEX IF NOT EXISTS capability_uses_lookup ON capability_uses(capability_id, at);
`;

export interface GrantSpec {
  label: string;
  /** Restrict to one worker. Omit for any caller, which is broader. */
  workerId?: string | null;
  /** Exact hostnames, or a leading dot for a suffix match: ".example.com". */
  domains: string[];
  sensitivities: Sensitivity[];
  /** Narrow to particular action kinds, e.g. ["click"]. */
  actionKinds?: string[] | null;
  /** Narrow to specific recipients or identities. */
  recipients?: string[] | null;
  maxUses?: number | null;
  expiresAt?: string | null;
}

export interface Capability extends GrantSpec {
  id: string;
  usedCount: number;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface CapabilityQuery {
  workerId?: string | null;
  url: string;
  sensitivity: Sensitivity;
  actionKind: string;
  recipient?: string | null;
  now?: Date;
}

export type CapabilityCheck =
  | { granted: true; capability: Capability }
  | { granted: false; reason: string };

export class Capabilities {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  grant(spec: GrantSpec): Capability {
    if (!spec.domains.length) throw new Error('a grant must name at least one domain');
    if (!spec.sensitivities.length) throw new Error('a grant must name at least one sensitivity');

    // An unbounded grant to do something unrecoverable is not a grant, it is
    // an abdication. Bound it or do not make it.
    if (spec.sensitivities.includes('IRREVERSIBLE') && (spec.maxUses ?? null) === null) {
      throw new Error('a grant covering IRREVERSIBLE actions must set maxUses');
    }

    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO capabilities (id, label, worker_id, domains, sensitivities, action_kinds,
                                recipients, max_uses, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, spec.label, spec.workerId ?? null,
      JSON.stringify(spec.domains), JSON.stringify(spec.sensitivities),
      spec.actionKinds ? JSON.stringify(spec.actionKinds) : null,
      spec.recipients ? JSON.stringify(spec.recipients) : null,
      spec.maxUses ?? null, spec.expiresAt ?? null, new Date().toISOString(),
    );
    return this.get(id)!;
  }

  get(id: string): Capability | null {
    const row = this.#db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toCapability(row) : null;
  }

  revoke(id: string, reason = 'revoked by the user'): void {
    this.#db.prepare('UPDATE capabilities SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), reason, id);
  }

  list(includeInactive = false): Capability[] {
    const rows = this.#db.prepare('SELECT * FROM capabilities ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    const all = rows.map(toCapability);
    return includeInactive ? all : all.filter((c) => isLive(c, new Date()));
  }

  /**
   * Is this action covered by a live grant?
   *
   * Read-only: matching does not consume. The caller records a use with
   * `consume` after the action actually happens, so a grant is not spent by
   * an action that was then blocked for some other reason.
   */
  check(q: CapabilityQuery): CapabilityCheck {
    const now = q.now ?? new Date();
    let host: string;
    try {
      host = new URL(q.url).hostname;
    } catch {
      return { granted: false, reason: `cannot determine the site from ${q.url}` };
    }

    const candidates = this.list(true).filter((c) => isLive(c, now));
    for (const c of candidates) {
      if (c.workerId != null && c.workerId !== q.workerId) continue;
      if (!c.domains.some((d) => matchesDomain(host, d))) continue;
      if (!c.sensitivities.includes(q.sensitivity)) continue;
      if (c.actionKinds && !c.actionKinds.includes(q.actionKind)) continue;
      if (c.recipients) {
        if (!q.recipient) continue;
        if (!c.recipients.some((r) => r.toLowerCase() === q.recipient!.toLowerCase())) continue;
      }
      return { granted: true, capability: c };
    }
    return { granted: false, reason: 'no live grant covers this action' };
  }

  /**
   * Claim one use of a grant, atomically.
   *
   * The budget check and the increment are a single conditional UPDATE, so
   * two concurrent runs cannot both spend the last use of a one-use grant.
   * Checked and counted separately, two parallel runs sharing `maxUses: 1`
   * both click Send and the counter still reads one.
   *
   * Claiming is not the same as using. The use is recorded on settle.
   */
  reserve(q: CapabilityQuery): { ok: true; capability: Capability } | { ok: false; reason: string } {
    const match = this.check(q);
    if (!match.granted) return { ok: false, reason: match.reason };

    const now = (q.now ?? new Date()).toISOString();
    const claimed = this.#db.prepare(`
      UPDATE capabilities SET used_count = used_count + 1
      WHERE id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_uses IS NULL OR used_count < max_uses)
    `).run(match.capability.id, now);

    if (Number(claimed.changes) === 0) {
      // Between matching and claiming, someone else took the last use.
      return { ok: false, reason: `the grant "${match.capability.label}" was spent by another run` };
    }
    return { ok: true, capability: this.get(match.capability.id)! };
  }

  /**
   * Close a claim.
   *
   * `released` gives the use back — only for an action that provably did not
   * happen. `unknown` keeps it spent: a grant whose effect we cannot confirm
   * has to be treated as used, or an uncertain send silently refunds itself
   * and the next run sends again.
   */
  settle(
    id: string,
    outcome: 'committed' | 'released' | 'unknown',
    use: { runId?: string; url: string; action: string; sensitivity: Sensitivity; recipient?: string | null },
  ): void {
    if (outcome === 'released') {
      this.#db.prepare('UPDATE capabilities SET used_count = MAX(used_count - 1, 0) WHERE id = ?').run(id);
      return;
    }
    this.#db.prepare(`
      INSERT INTO capability_uses (id, capability_id, at, run_id, url, action, sensitivity, recipient)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(randomUUID(), id, new Date().toISOString(), use.runId ?? null, use.url,
           outcome === 'unknown' ? `${use.action} (outcome unknown)` : use.action,
           use.sensitivity, use.recipient ?? null);
  }

  /** Record a completed use directly. Prefer reserve/settle around one. */
  consume(id: string, use: { runId?: string; url: string; action: string; sensitivity: Sensitivity; recipient?: string | null }): void {
    const cap = this.get(id);
    if (!cap) throw new Error(`no such capability: ${id}`);
    if (!isLive(cap, new Date())) throw new Error(`capability ${id} is no longer live`);
    this.#db.prepare('UPDATE capabilities SET used_count = used_count + 1 WHERE id = ?').run(id);
    this.settle(id, 'committed', use);
  }

  uses(id: string, limit = 50): Array<Record<string, unknown>> {
    return this.#db.prepare(
      'SELECT * FROM capability_uses WHERE capability_id = ? ORDER BY at DESC LIMIT ?',
    ).all(id, limit) as Array<Record<string, unknown>>;
  }
}

function isLive(c: Capability, now: Date): boolean {
  if (c.revokedAt) return false;
  if (c.expiresAt && new Date(c.expiresAt) <= now) return false;
  if (c.maxUses !== null && c.maxUses !== undefined && c.usedCount >= c.maxUses) return false;
  return true;
}

/** Exact hostname, or a leading dot for "this domain and its subdomains". */
function matchesDomain(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

function toCapability(row: Record<string, unknown>): Capability {
  return {
    id: String(row.id),
    label: String(row.label),
    workerId: row.worker_id === null ? null : String(row.worker_id),
    domains: JSON.parse(String(row.domains)) as string[],
    sensitivities: JSON.parse(String(row.sensitivities)) as Sensitivity[],
    actionKinds: row.action_kinds === null ? null : (JSON.parse(String(row.action_kinds)) as string[]),
    recipients: row.recipients === null ? null : (JSON.parse(String(row.recipients)) as string[]),
    maxUses: row.max_uses === null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    revokedReason: row.revoked_reason === null ? null : String(row.revoked_reason),
  };
}
