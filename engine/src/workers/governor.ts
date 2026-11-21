/**
 * Rate governance.
 *
 * Two distinct jobs, and conflating them is a mistake worth avoiding
 * explicitly:
 *
 *  1. Respecting a service's documented limits and not hammering it. That is
 *     politeness and load management, and it is what this file does.
 *
 *  2. Looking human so a platform's behavioural detection does not notice.
 *     That is circumvention of a safeguard, it is out of scope, and no knob
 *     here is for it. The jitter in schedule.ts spreads load across users;
 *     it is not a disguise, and it must not be tuned as one.
 *
 * Counters persist across runs and restarts. A governor that resets when the
 * process restarts is not a governor — the limit it enforces is whatever the
 * crash rate happens to be.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
-- status:
--   reserved  - claimed before the action; counts against the cap while in flight
--   committed - the action happened
--   unknown   - the action may have happened; counts, because assuming it did
--               not is how someone gets messaged twice
-- A released reservation is deleted, not marked, so it stops counting.
CREATE TABLE IF NOT EXISTS rate_events (
  id        TEXT PRIMARY KEY,
  platform  TEXT NOT NULL,
  action    TEXT NOT NULL,
  at        TEXT NOT NULL,
  run_id    TEXT,
  status    TEXT NOT NULL DEFAULT 'committed'
);
CREATE INDEX IF NOT EXISTS rate_lookup ON rate_events(platform, action, at);

-- Outbound actions still awaiting a response. A large pile of unanswered
-- requests is itself the signal a platform reacts to, so it is a governed
-- quantity rather than a statistic.
CREATE TABLE IF NOT EXISTS pending_outbound (
  id         TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  identity   TEXT NOT NULL,
  action     TEXT NOT NULL,
  sent_at    TEXT NOT NULL,
  resolved_at TEXT,
  outcome    TEXT
);
CREATE INDEX IF NOT EXISTS pending_lookup ON pending_outbound(platform, resolved_at);
`;

const DAY_MS = 86_400_000;

export interface RateLimit {
  platform: string;
  action: string;
  perDay?: number;
  perWeek?: number;
  /** Cap on outbound actions still awaiting any response. */
  maxPending?: number;
  /** Minimum spacing between two of these actions, in seconds. */
  minIntervalSeconds?: number;
}

export type RateVerdict =
  | { allowed: true; remainingToday?: number }
  | { allowed: false; why: string; retryAfter?: Date };

export class RateGovernor {
  #db: DatabaseSync;
  #limits = new Map<string, RateLimit>();

  constructor(db: DatabaseSync, limits: RateLimit[] = []) {
    this.#db = db;
    this.#migrate();
    this.#db.exec(SCHEMA);
    for (const l of limits) this.#limits.set(key(l.platform, l.action), l);
  }

  /** Bring a pre-reservation database forward; old rows are completed actions. */
  #migrate(): void {
    const cols = this.#db.prepare("PRAGMA table_info('rate_events')").all() as Array<{ name: string }>;
    if (!cols.length) return;
    if (!cols.some((c) => c.name === 'status')) {
      this.#db.exec("ALTER TABLE rate_events ADD COLUMN status TEXT NOT NULL DEFAULT 'committed'");
    }
  }

  setLimit(limit: RateLimit): void {
    this.#limits.set(key(limit.platform, limit.action), limit);
  }

  /**
   * Ask whether an action would be permitted, without claiming capacity.
   *
   * Useful for reporting and for deciding whether to bother. It is NOT safe
   * as the gate before an action: two concurrent runs can both pass a check
   * and both act. Use `reserve` for that.
   */
  check(platform: string, action: string, now = new Date()): RateVerdict {
    const limit = this.#limitFor(platform, action);
    if (!limit) return { allowed: true };
    return this.#evaluate(limit, limit.platform, action, now);
  }

  /**
   * The limit covering a host: its own, or the nearest parent domain's.
   *
   * A cap is set for a site ("greenhouse.io") and an action happens on a
   * page ("boards.greenhouse.io"). Matching only the exact host would never
   * apply a cap on a site that serves from a subdomain.
   */
  #limitFor(platform: string, action: string): RateLimit | undefined {
    for (let host = platform; host; host = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '') {
      const limit = this.#limits.get(key(host, action));
      if (limit) return limit;
    }
    return undefined;
  }

  #evaluate(limit: RateLimit, platform: string, action: string, now: Date): RateVerdict {
    if (limit.minIntervalSeconds) {
      const last = this.#lastAt(platform, action);
      if (last) {
        const elapsed = (now.getTime() - last.getTime()) / 1000;
        if (elapsed < limit.minIntervalSeconds) {
          return {
            allowed: false,
            why: `minimum interval of ${limit.minIntervalSeconds}s between ${action} on ${platform}`,
            retryAfter: new Date(last.getTime() + limit.minIntervalSeconds * 1000),
          };
        }
      }
    }

    if (limit.perDay !== undefined) {
      const used = this.countSince(platform, action, new Date(now.getTime() - DAY_MS));
      if (used >= limit.perDay) {
        return { allowed: false, why: `daily cap reached: ${used}/${limit.perDay} ${action} on ${platform}` };
      }
    }

    if (limit.perWeek !== undefined) {
      const used = this.countSince(platform, action, new Date(now.getTime() - 7 * DAY_MS));
      if (used >= limit.perWeek) {
        return { allowed: false, why: `weekly cap reached: ${used}/${limit.perWeek} ${action} on ${platform}` };
      }
    }

    if (limit.maxPending !== undefined) {
      const pending = this.countPending(platform);
      if (pending >= limit.maxPending) {
        return {
          allowed: false,
          why:
            `${pending} outbound ${platform} actions are still unanswered (cap ${limit.maxPending}). ` +
            'Adding to a stale pile is the pattern that gets accounts restricted.',
        };
      }
    }

    const remainingToday = limit.perDay === undefined
      ? undefined
      : limit.perDay - this.countSince(platform, action, new Date(now.getTime() - DAY_MS));
    return { allowed: true, remainingToday };
  }

  /**
   * Claim capacity for one action, atomically.
   *
   * The check and the claim happen inside one immediate transaction, so two
   * concurrent runs cannot both pass a cap of one. This is the difference
   * between a limit and a statistic: checked and claimed apart, two parallel
   * runs sharing `perDay: 1` both send.
   *
   * A reservation counts against the cap while it is in flight, and is
   * released only if the action provably did not happen.
   */
  reserve(platform: string, action: string, runId?: string, now = new Date()):
    { ok: true; id: string | null; remainingToday?: number } | { ok: false; why: string } {
    const limit = this.#limitFor(platform, action);
    if (!limit) return { ok: true, id: null };
    // Counted under the limit's own domain, so every subdomain draws on one cap.
    platform = limit.platform;

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const verdict = this.#evaluate(limit, platform, action, now);
      if (!verdict.allowed) {
        this.#db.exec('ROLLBACK');
        return { ok: false, why: verdict.why };
      }
      const id = randomUUID();
      this.#db.prepare(
        'INSERT INTO rate_events (id, platform, action, at, run_id, status) VALUES (?,?,?,?,?,?)',
      ).run(id, platform, action, now.toISOString(), runId ?? null, 'reserved');
      this.#db.exec('COMMIT');
      return { ok: true, id, remainingToday: verdict.remainingToday };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Close a reservation.
   *
   * `released` deletes it, so it stops counting — use only when the action
   * provably did not reach the page. `unknown` keeps it counted: if we cannot
   * tell whether a message went out, treating it as not sent is how someone
   * gets messaged twice.
   */
  settle(id: string | null, outcome: 'committed' | 'released' | 'unknown'): void {
    if (!id) return;
    if (outcome === 'released') {
      this.#db.prepare('DELETE FROM rate_events WHERE id = ? AND status = ?').run(id, 'reserved');
      return;
    }
    this.#db.prepare('UPDATE rate_events SET status = ? WHERE id = ?').run(outcome, id);
  }

  /** Record a completed action directly. Prefer reserve/settle around one. */
  record(platform: string, action: string, runId?: string, at = new Date()): void {
    this.#db.prepare('INSERT INTO rate_events (id, platform, action, at, run_id, status) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), platform, action, at.toISOString(), runId ?? null, 'committed');
  }

  /** Counts in-flight reservations too: capacity is claimed, not just spent. */
  countSince(platform: string, action: string, since: Date): number {
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM rate_events WHERE platform = ? AND action = ? AND at >= ? AND status IN ('reserved','committed','unknown')",
    ).get(platform, action, since.toISOString()) as { n: number };
    return row.n;
  }

  addPending(id: string, platform: string, identity: string, action: string, at = new Date()): void {
    this.#db.prepare(
      'INSERT OR IGNORE INTO pending_outbound (id, platform, identity, action, sent_at) VALUES (?,?,?,?,?)',
    ).run(id, platform, identity, action, at.toISOString());
  }

  resolvePending(id: string, outcome: string, at = new Date()): void {
    this.#db.prepare('UPDATE pending_outbound SET resolved_at = ?, outcome = ? WHERE id = ?')
      .run(at.toISOString(), outcome, id);
  }

  countPending(platform: string): number {
    const row = this.#db.prepare(
      'SELECT COUNT(*) AS n FROM pending_outbound WHERE platform = ? AND resolved_at IS NULL',
    ).get(platform) as { n: number };
    return row.n;
  }

  /**
   * Ratio of outbound actions to ordinary activity over a window.
   *
   * Tracked because a profile that only ever reaches out, and never does
   * anything else, is not a normal user of the service — and treating a
   * platform that way is worth noticing regardless of whether it is detected.
   * Reported, not used to compute a disguise.
   */
  outreachRatio(platform: string, windowDays = 7, now = new Date()): { outreach: number; ordinary: number; ratio: number } {
    const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
    const rows = this.#db.prepare(
      "SELECT action, COUNT(*) AS n FROM rate_events WHERE platform = ? AND at >= ? AND status != 'reserved' GROUP BY action",
    ).all(platform, since) as Array<{ action: string; n: number }>;

    let outreach = 0;
    let ordinary = 0;
    for (const r of rows) {
      if (/^(invite|message|comment|post|react|apply|outbound|unclassified_write)$/.test(r.action)) outreach += r.n;
      else ordinary += r.n;
    }
    return { outreach, ordinary, ratio: ordinary === 0 ? (outreach === 0 ? 0 : Infinity) : outreach / ordinary };
  }

  #lastAt(platform: string, action: string): Date | null {
    const row = this.#db.prepare(
      "SELECT at FROM rate_events WHERE platform = ? AND action = ? AND status IN ('reserved','committed','unknown') ORDER BY at DESC LIMIT 1",
    ).get(platform, action) as { at: string } | undefined;
    return row ? new Date(row.at) : null;
  }
}

function key(platform: string, action: string): string {
  return `${platform}::${action}`;
}
