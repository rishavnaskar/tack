/**
 * Credits ledger.
 *
 * Append-only. Balance is derived by summing entries, never stored as a
 * mutable number — a stored balance and a history that disagree is a dispute
 * you cannot settle, and it is always the history that is right.
 *
 * Money moves in two steps. A run RESERVES an estimate before it starts and
 * SETTLES the actual afterwards, releasing the difference. The reason is
 * ordering: by the time real usage exists it has already been incurred, so a
 * check performed then is a report, not a limit. The reservation is what
 * makes "you are out of credits" happen before the spending rather than after.
 *
 * Every entry records which price book produced it and which rate period it
 * fell in, because model prices change and an entry that cannot say what it
 * was priced against cannot be audited or re-billed.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { effectiveCost, PRICE_BOOK_VERSION, type UsageEvent } from '../model/pricebook.ts';
import { isPeakPricing } from '../workers/schedule.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  id            TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  at            TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- grant | reserve | release | charge | refund
  credits       REAL NOT NULL,   -- signed: positive adds, negative removes
  reservation_id TEXT,
  run_id        TEXT,
  meter         TEXT,            -- model_tokens | browser_minutes | connector_action | outcome
  detail        TEXT,
  price_book_version TEXT,
  rate_period   TEXT,            -- peak | off_peak
  usd_cost      REAL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account, at);
CREATE INDEX IF NOT EXISTS ledger_reservation ON ledger(reservation_id);

CREATE TABLE IF NOT EXISTS reservations (
  id            TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  run_id        TEXT,
  credits       REAL NOT NULL,
  status        TEXT NOT NULL,   -- open | settled | cancelled
  opened_at     TEXT NOT NULL,
  settled_at    TEXT
);
`;

export type LedgerKind = 'grant' | 'reserve' | 'release' | 'charge' | 'refund';
export type Meter = 'model_tokens' | 'browser_minutes' | 'connector_action' | 'outcome';

export interface Pricing {
  /** Credits per USD of underlying model cost, i.e. the markup. */
  creditsPerUsd: number;
  /** Credits per minute of browser time. */
  creditsPerBrowserMinute: number;
  /** Credits per connector call. */
  creditsPerConnectorAction: number;
  /**
   * Flat credits for a completed outcome, when a task is priced per result.
   *
   * Pricing an outcome rather than a token is what makes skill replay pay
   * twice: the user pays the same for the same result, and replay removes
   * almost all of the cost of producing it.
   */
  creditsPerOutcome?: Record<string, number>;
}

export const DEFAULT_PRICING: Pricing = {
  creditsPerUsd: 2000,          // 1 credit ≈ $0.0005 of model spend
  creditsPerBrowserMinute: 2,
  creditsPerConnectorAction: 1,
};

export class InsufficientCredits extends Error {
  readonly balance: number;
  readonly required: number;
  constructor(balance: number, required: number) {
    super(`insufficient credits: ${balance.toFixed(2)} available, ${required.toFixed(2)} required`);
    this.name = 'InsufficientCredits';
    this.balance = balance;
    this.required = required;
  }
}

export class Ledger {
  #db: DatabaseSync;
  #pricing: Pricing;

  constructor(db: DatabaseSync, pricing: Pricing = DEFAULT_PRICING) {
    this.#db = db;
    this.#db.exec(SCHEMA);
    this.#pricing = pricing;
  }

  /** Sum of every entry. The only definition of a balance there is. */
  balance(account: string): number {
    const row = this.#db.prepare(
      'SELECT COALESCE(SUM(credits), 0) AS total FROM ledger WHERE account = ?',
    ).get(account) as { total: number };
    return round(row.total);
  }

  /** Balance minus credits held by open reservations. */
  available(account: string): number {
    return this.balance(account);
  }

  grant(account: string, credits: number, detail = 'purchase'): void {
    if (credits <= 0) throw new Error('a grant must be positive');
    this.#append({ account, kind: 'grant', credits, detail });
  }

  /**
   * Hold credits for work about to be done.
   *
   * Throws rather than allowing an overdraft: a run that cannot be paid for
   * should not start, and finding out afterwards is not a limit.
   */
  reserve(account: string, credits: number, runId?: string): string {
    if (credits <= 0) throw new Error('a reservation must be positive');
    const balance = this.balance(account);
    if (balance < credits) throw new InsufficientCredits(balance, credits);

    const id = randomUUID();
    this.#db.prepare(
      'INSERT INTO reservations (id, account, run_id, credits, status, opened_at) VALUES (?,?,?,?,?,?)',
    ).run(id, account, runId ?? null, credits, 'open', new Date().toISOString());
    this.#append({ account, kind: 'reserve', credits: -credits, reservationId: id, runId });
    return id;
  }

  /**
   * Close a reservation against what was actually used.
   *
   * Overspend beyond the reservation is charged, not refused: the work is
   * already done and refusing to record it would make the ledger a worse
   * record than the truth. The place to stop an expensive run is the circuit
   * breaker in `wouldExceed`, before the spending.
   */
  settle(reservationId: string, actualCredits: number, detail = ''): { charged: number; released: number } {
    const res = this.#db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId) as
      { id: string; account: string; run_id: string | null; credits: number; status: string } | undefined;
    if (!res) throw new Error(`no such reservation: ${reservationId}`);
    if (res.status !== 'open') throw new Error(`reservation ${reservationId} is already ${res.status}`);

    const charged = round(Math.max(0, actualCredits));
    const released = round(res.credits - charged);

    this.#db.prepare("UPDATE reservations SET status = 'settled', settled_at = ? WHERE id = ?")
      .run(new Date().toISOString(), reservationId);

    // Put the whole hold back, then charge what was used. Two entries rather
    // than one net entry, so the history shows what was held and what was
    // spent instead of only the difference.
    this.#append({ account: res.account, kind: 'release', credits: res.credits, reservationId, runId: res.run_id ?? undefined });
    if (charged > 0) {
      this.#append({
        account: res.account, kind: 'charge', credits: -charged,
        reservationId, runId: res.run_id ?? undefined, detail,
      });
    }
    return { charged, released };
  }

  cancel(reservationId: string): void {
    const res = this.#db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId) as
      { account: string; credits: number; status: string; run_id: string | null } | undefined;
    if (!res || res.status !== 'open') return;
    this.#db.prepare("UPDATE reservations SET status = 'cancelled', settled_at = ? WHERE id = ?")
      .run(new Date().toISOString(), reservationId);
    this.#append({ account: res.account, kind: 'release', credits: res.credits, reservationId, runId: res.run_id ?? undefined });
  }

  /** Record model usage as credits. Called per completion. */
  chargeUsage(account: string, event: UsageEvent, runId?: string): number {
    const usd = effectiveCost(event);
    const credits = round(usd * this.#pricing.creditsPerUsd);
    this.#append({
      account, kind: 'charge', credits: -credits, runId,
      meter: 'model_tokens',
      detail: `${event.modelId} ${event.promptTokens}+${event.completionTokens} tok`,
      priceBookVersion: event.priceBookVersion,
      ratePeriod: isPeakPricing(new Date(event.at)) ? 'peak' : 'off_peak',
      usdCost: usd,
    });
    return credits;
  }

  chargeBrowserMinutes(account: string, minutes: number, runId?: string): number {
    const credits = round(minutes * this.#pricing.creditsPerBrowserMinute);
    this.#append({ account, kind: 'charge', credits: -credits, runId, meter: 'browser_minutes',
      detail: `${minutes.toFixed(2)} min` });
    return credits;
  }

  chargeOutcome(account: string, outcome: string, runId?: string): number {
    const credits = this.#pricing.creditsPerOutcome?.[outcome];
    if (credits === undefined) return 0;
    this.#append({ account, kind: 'charge', credits: -credits, runId, meter: 'outcome', detail: outcome });
    return credits;
  }

  refund(account: string, credits: number, detail: string, runId?: string): void {
    this.#append({ account, kind: 'refund', credits: Math.abs(credits), runId, detail });
  }

  /**
   * Circuit breaker. Ask before continuing an expensive loop.
   *
   * Cost containment has to live where the spending happens; by the time a
   * bill exists it is too late to decline it.
   */
  wouldExceed(account: string, projectedCredits: number): boolean {
    return this.balance(account) < projectedCredits;
  }

  history(account: string, limit = 100): Array<Record<string, unknown>> {
    return this.#db.prepare(
      'SELECT * FROM ledger WHERE account = ? ORDER BY at DESC, rowid DESC LIMIT ?',
    ).all(account, limit) as Array<Record<string, unknown>>;
  }

  openReservations(account: string): Array<Record<string, unknown>> {
    return this.#db.prepare(
      "SELECT * FROM reservations WHERE account = ? AND status = 'open'",
    ).all(account) as Array<Record<string, unknown>>;
  }

  /** Per-meter totals, for showing a user where their credits went. */
  breakdown(account: string, since?: Date): Array<{ meter: string; credits: number; usd: number }> {
    const rows = this.#db.prepare(`
      SELECT meter, COALESCE(SUM(-credits), 0) AS credits, COALESCE(SUM(usd_cost), 0) AS usd
      FROM ledger
      WHERE account = ? AND kind = 'charge' AND meter IS NOT NULL AND at >= ?
      GROUP BY meter ORDER BY credits DESC
    `).all(account, since?.toISOString() ?? '1970-01-01') as Array<{ meter: string; credits: number; usd: number }>;
    return rows.map((r) => ({ meter: r.meter, credits: round(r.credits), usd: r.usd }));
  }

  #append(e: {
    account: string; kind: LedgerKind; credits: number; reservationId?: string; runId?: string;
    meter?: Meter; detail?: string; priceBookVersion?: string; ratePeriod?: string; usdCost?: number;
  }): void {
    this.#db.prepare(`
      INSERT INTO ledger (id, account, at, kind, credits, reservation_id, run_id, meter, detail,
                          price_book_version, rate_period, usd_cost)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      randomUUID(), e.account, new Date().toISOString(), e.kind, round(e.credits),
      e.reservationId ?? null, e.runId ?? null, e.meter ?? null, e.detail ?? null,
      e.priceBookVersion ?? PRICE_BOOK_VERSION, e.ratePeriod ?? null, e.usdCost ?? null,
    );
  }
}

/** Credits are money. Rounding at write time keeps the sum exact. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
