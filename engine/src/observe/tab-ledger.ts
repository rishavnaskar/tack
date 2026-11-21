/**
 * Which tabs Fanfold opened, and for what.
 *
 * Every tab or window Fanfold creates belongs to a piece of work: the main
 * page, an MCP session, a run, an import, a sandbox. A tab is closed when that
 * work ends, unless its page waits on the user (keep_until). Tabs a page opens
 * belong to whoever owns the page that opened them. A tab the user lent is
 * never written here, so nothing here can close it.
 *
 * The rows live in the app's database so a restart can tell its own leftovers
 * from the user's tabs. Whether an owner is still alive lives in memory: after
 * a restart, nothing from before is.
 */
import type { DatabaseSync } from 'node:sqlite';

type OwnerKind ='main' | 'session' | 'run' | 'import' | 'sandbox';

export interface Owner { kind: OwnerKind; id: string }

/** The main page's owner. There is one per app. */
export const MAIN: Owner = { kind: 'main', id: 'main' };

/**
 * How long whoever works in "main" (an agent's connection, a task of the
 * app's own) keeps it after its last call. Shortened in tests.
 */
export const mainHold = { idleMs: 5 * 60_000 };

/** Which browser a tab is in: Fanfold's own, the user's through the extension, or a sandbox. */
export type TabMode = 'dedicated' | 'extension' | 'sandbox';

export interface TabRef {
  targetId: string;
  mode: TabMode;
  chromeTabId?: number | null;
  windowId?: number | null;
  url?: string | null;
}

export interface OwnedTab {
  targetId: string;
  mode: TabMode;
  chromeTabId: number | null;
  windowId: number | null;
  owner: Owner;
  openerTargetId: string | null;
  openedAt: string;
  url: string | null;
  keepUntil: string | null;
  keepWhy: string | null;
}

/** Decides, at each sweep, whether a kept tab still waits on the user, and what ends it when it does not. */
interface KeepRule {
  waits(): boolean;
  /** Ends the work the tab was kept for. Without one, the tab is simply no longer kept. */
  expire?(): void | Promise<void>;
}

interface Liveness {
  /** Handles (open tabs, a session) still holding the owner. */
  handles: number;
  /** Ways the owner can still be needed without a handle, such as "main" while an agent works in it. */
  checks: Set<() => boolean>;
  stops: Set<() => unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owned_tabs (
  target_id        TEXT PRIMARY KEY,
  mode             TEXT NOT NULL,
  chrome_tab_id    INTEGER,
  window_id        INTEGER,
  owner_kind       TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  opener_target_id TEXT,
  opened_at        TEXT NOT NULL,
  url              TEXT,
  keep_until       TEXT,
  keep_why         TEXT
);
CREATE INDEX IF NOT EXISTS owned_tabs_owner ON owned_tabs (owner_kind, owner_id);
`;

export const ownerKey = (owner: Owner): string => `${owner.kind}:${owner.id}`;

export function sameOwner(a: Owner | null | undefined, b: Owner | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

type Row = Record<string, unknown>;

function toTab(row: Row): OwnedTab {
  return {
    targetId: String(row.target_id),
    mode: String(row.mode) as TabMode,
    chromeTabId: row.chrome_tab_id == null ? null : Number(row.chrome_tab_id),
    windowId: row.window_id == null ? null : Number(row.window_id),
    owner: { kind: String(row.owner_kind) as OwnerKind, id: String(row.owner_id) },
    openerTargetId: row.opener_target_id == null ? null : String(row.opener_target_id),
    openedAt: String(row.opened_at),
    url: row.url == null ? null : String(row.url),
    keepUntil: row.keep_until == null ? null : String(row.keep_until),
    keepWhy: row.keep_why == null ? null : String(row.keep_why),
  };
}

type LedgerEvent =
  | { type: 'ended'; owner: Owner }
  | { type: 'kept' | 'unkept' | 'released'; targetId: string; owner: Owner | null }
  | { type: 'claimed'; targetId: string; owner: Owner };

export class TabLedger {
  readonly #db: DatabaseSync;
  readonly #live = new Map<string, Liveness>();
  /** Owners the user stopped: their pages may not open a tab again. */
  readonly #stopped = new Set<string>();
  readonly #rules = new Map<string, KeepRule>();
  readonly #listeners = new Set<(event: LedgerEvent) => void>();
  /** Set at shutdown: nothing is alive any more, whatever its checks say. */
  #ending = false;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(SCHEMA);
  }

  // ------------------------------------------------------------ the rows

  /** This tab is the owner's. Claiming again moves it, and fills in what the second claim knows. */
  claim(target: TabRef, owner: Owner, openerTargetId: string | null = null): void {
    this.#db.prepare(`
      INSERT INTO owned_tabs (target_id, mode, chrome_tab_id, window_id, owner_kind, owner_id, opener_target_id, opened_at, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        mode = excluded.mode, owner_kind = excluded.owner_kind, owner_id = excluded.owner_id,
        chrome_tab_id = COALESCE(excluded.chrome_tab_id, owned_tabs.chrome_tab_id),
        window_id = COALESCE(excluded.window_id, owned_tabs.window_id),
        opener_target_id = COALESCE(excluded.opener_target_id, owned_tabs.opener_target_id),
        url = COALESCE(excluded.url, owned_tabs.url)
    `).run(
      target.targetId, target.mode, target.chromeTabId ?? null, target.windowId ?? null,
      owner.kind, owner.id, openerTargetId, new Date().toISOString(), target.url ?? null,
    );
    this.#emit({ type: 'claimed', targetId: target.targetId, owner });
  }

  /** A tab opened by an owned tab is that owner's too. Returns the owner, or null when the opener is no tab of Fanfold's. */
  inherit(target: TabRef, openerTargetId: string): Owner | null {
    const opener = this.get(openerTargetId);
    if (!opener) return null;
    this.claim(target, opener.owner, openerTargetId);
    return opener.owner;
  }

  /** Keep this tab open past its owner's end, while its page waits on the user, until `until` at the latest. */
  keep(targetId: string, until: Date | string, why: string): void {
    const at = typeof until === 'string' ? until : until.toISOString();
    const changed = this.#db.prepare('UPDATE owned_tabs SET keep_until = ?, keep_why = ? WHERE target_id = ?').run(at, why, targetId).changes;
    if (changed) this.#emit({ type: 'kept', targetId, owner: this.ownerOf(targetId) });
  }

  unkeep(targetId: string): void {
    const changed = this.#db.prepare('UPDATE owned_tabs SET keep_until = NULL, keep_why = NULL WHERE target_id = ? AND keep_until IS NOT NULL').run(targetId).changes;
    if (changed) this.#emit({ type: 'unkept', targetId, owner: this.ownerOf(targetId) });
  }

  /** The tab is gone, or no longer Fanfold's. */
  release(targetId: string): void {
    const owner = this.ownerOf(targetId);
    const changed = this.#db.prepare('DELETE FROM owned_tabs WHERE target_id = ?').run(targetId).changes;
    if (changed) this.#emit({ type: 'released', targetId, owner });
  }

  get(targetId: string): OwnedTab | null {
    const row = this.#db.prepare('SELECT * FROM owned_tabs WHERE target_id = ?').get(targetId) as Row | undefined;
    return row ? toTab(row) : null;
  }

  /** Which piece of work a tab belongs to: what "stop Fanfold here" ends. */
  ownerOf(targetId: string): Owner | null {
    return this.get(targetId)?.owner ?? null;
  }

  ownedBy(owner: Owner): OwnedTab[] {
    return (this.#db.prepare('SELECT * FROM owned_tabs WHERE owner_kind = ? AND owner_id = ? ORDER BY opened_at')
      .all(owner.kind, owner.id) as Row[]).map(toTab);
  }

  all(mode?: TabMode): OwnedTab[] {
    const rows = mode
      ? this.#db.prepare('SELECT * FROM owned_tabs WHERE mode = ? ORDER BY opened_at').all(mode)
      : this.#db.prepare('SELECT * FROM owned_tabs ORDER BY opened_at').all();
    return (rows as Row[]).map(toTab);
  }

  noteUrl(targetId: string, url: string): void {
    this.#db.prepare('UPDATE owned_tabs SET url = ? WHERE target_id = ? AND (url IS NULL OR url != ?)').run(url, targetId, url);
  }

  /** Keep every tab of this owner, deciding at each sweep by `rule` whether it still waits. */
  keepOwner(owner: Owner, until: Date | string, why: string, rule?: KeepRule): void {
    if (rule) this.#rules.set(ownerKey(owner), rule);
    for (const tab of this.ownedBy(owner)) this.keep(tab.targetId, until, why);
  }

  unkeepOwner(owner: Owner): void {
    this.#rules.delete(ownerKey(owner));
    for (const tab of this.ownedBy(owner)) this.unkeep(tab.targetId);
  }

  /** What decides whether this owner's kept tabs still wait, if anything does. */
  keepRule(owner: Owner): KeepRule | null {
    return this.#rules.get(ownerKey(owner)) ?? null;
  }

  // ------------------------------------------------------------ liveness

  /**
   * The owner is alive until the returned function is called (once per
   * call to begin). `stop` is how the user ends it from outside: closing a
   * session, closing a run's tab.
   */
  begin(owner: Owner, stop?: () => unknown): () => void {
    const live = this.#liveness(owner);
    live.handles++;
    this.#stopped.delete(ownerKey(owner));
    if (stop) live.stops.add(stop);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (stop) live.stops.delete(stop);
      live.handles = Math.max(0, live.handles - 1);
      this.#settle(owner, live);
    };
  }

  /** The owner is alive while `check` says so, as well as while any handle holds it. Returns how to stop asking. */
  hold(owner: Owner, check: () => boolean): () => void {
    const live = this.#liveness(owner);
    live.checks.add(check);
    return () => {
      live.checks.delete(check);
      this.#settle(owner, live);
    };
  }

  /** What else to do when the user stops this owner. Returns how to take it back. */
  onStop(owner: Owner, stop: () => unknown): () => void {
    const live = this.#liveness(owner);
    live.stops.add(stop);
    return () => {
      live.stops.delete(stop);
      this.#prune(owner, live);
    };
  }

  alive(owner: Owner): boolean {
    if (this.#ending || this.#stopped.has(ownerKey(owner))) return false;
    const live = this.#live.get(ownerKey(owner));
    if (!live) return false;
    if (live.handles > 0) return true;
    for (const check of live.checks) {
      try {
        if (check()) return true;
      } catch {
        // A check that cannot be made keeps nothing alive.
      }
    }
    return false;
  }

  /**
   * Ask again of an owner kept alive only by its checks (such as "main" while
   * an agent works there): if none says it is needed and it still has tabs,
   * it has ended, now rather than at the next sweep.
   */
  recheck(owner: Owner): void {
    if (!this.alive(owner) && this.ownedBy(owner).length) this.#emit({ type: 'ended', owner });
  }

  stopped(owner: Owner): boolean {
    return this.#stopped.has(ownerKey(owner));
  }

  /** A stopped owner may work again, such as "main" on the next task. */
  revive(owner: Owner): void {
    this.#stopped.delete(ownerKey(owner));
  }

  /**
   * The user stopped the work this tab belongs to. Its owner's own ways of
   * stopping run (a session closes, a run's tab closes) and its pages may not
   * open another tab. Returns the owner, or null for a tab that is not Fanfold's.
   */
  async stop(targetId: string): Promise<Owner | null> {
    const owner = this.ownerOf(targetId);
    if (owner) await this.stopOwner(owner);
    return owner;
  }

  async stopOwner(owner: Owner): Promise<void> {
    const key = ownerKey(owner);
    this.#stopped.add(key);
    this.#rules.delete(key);
    for (const tab of this.ownedBy(owner)) this.unkeep(tab.targetId);
    const live = this.#live.get(key);
    const stops = live ? [...live.stops] : [];
    // The checks stay: they are how a revived owner ("main" on the next task) is known to be needed again.
    // While it is stopped, alive() says no whatever they say.
    if (live) live.handles = 0;
    for (const stop of stops) {
      try { await stop(); } catch { /* one way of stopping failing leaves the others */ }
    }
    if (live) this.#prune(owner, live);
    this.#emit({ type: 'ended', owner });
  }

  /** At shutdown: every owner has ended, whatever holds it. */
  endAll(): void {
    this.#ending = true;
    for (const key of this.#live.keys()) {
      const [kind, ...id] = key.split(':');
      this.#emit({ type: 'ended', owner: { kind: kind as OwnerKind, id: id.join(':') } });
    }
  }

  /** Forget every row of one browser, which has gone with all its tabs. */
  forget(mode: TabMode): void {
    for (const tab of this.all(mode)) this.release(tab.targetId);
  }

  on(listener: (event: LedgerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #liveness(owner: Owner): Liveness {
    const key = ownerKey(owner);
    let live = this.#live.get(key);
    if (!live) {
      live = { handles: 0, checks: new Set(), stops: new Set() };
      this.#live.set(key, live);
    }
    return live;
  }

  /** Said once an owner is no longer alive; forgotten once nothing refers to it. */
  #settle(owner: Owner, live: Liveness): void {
    if (this.alive(owner)) return;
    this.#prune(owner, live);
    this.#emit({ type: 'ended', owner });
  }

  #prune(owner: Owner, live: Liveness): void {
    if (!live.handles && !live.checks.size && !live.stops.size && this.#live.get(ownerKey(owner)) === live) this.#live.delete(ownerKey(owner));
  }

  #emit(event: LedgerEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* a listener's failure is its own */ }
    }
  }
}
