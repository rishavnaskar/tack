/**
 * Closes what Fanfold left open.
 *
 * One janitor per browser connection. It sweeps when the browser connects,
 * when an owner ends, every minute while connected, and at shutdown:
 *  - a ledger tab whose owner has ended and that is not kept is closed;
 *  - a ledger row whose tab no longer exists is dropped;
 *  - in Fanfold's own browser (dedicated, sandbox) a page nobody owns is
 *    closed, because nothing in that browser is the user's;
 *  - in the user's Chrome (extension) a page nobody owns is never touched.
 * Once the ledger holds nothing of this browser's and nothing has used it for
 * the idle window, `onIdle` lets the browser go.
 */
import type { CdpClient } from '../cdp/client.ts';
import type { Logger } from '../lib/log.ts';
import { ownerKey, sameOwner, type OwnedTab, type Owner, type TabLedger, type TabMode, type TabRef } from './tab-ledger.ts';

/**
 * How often it sweeps, how long a browser stays once it has nothing of
 * Fanfold's open and nothing uses it, and how new an unowned tab may be before
 * it counts. Shortened in tests.
 */
export const janitorTiming = { sweepMs: 60_000, idleMs: 10_000, graceMs: 5_000 };

interface TargetInfo { targetId: string; type: string; url?: string; openerId?: string; subtype?: string }

interface SweepReport { closed: string[]; dropped: string[] }

interface JanitorOptions {
  client: CdpClient;
  ledger: TabLedger;
  mode: TabMode;
  log?: Logger;
  /** Nothing of this browser's is in the ledger and nothing used it for the idle window. */
  onIdle?(): void | Promise<void>;
  /** Something is using the browser right now, which keeps it from being idle. */
  busy?(): boolean;
  /** A browser that is one owner's alone (a sandbox): only that owner's rows are this browser's. */
  only?: Owner;
  /** A browser someone else started (attached over a port): a page Fanfold does not own there is never closed. */
  foreign?: boolean;
}

const janitors = new WeakMap<object, Janitor>();
const BLANK = /^about:blank$|^chrome:\/\/newtab/;

/** The janitor looking after this browser connection, if any. Tabs are claimed through it. */
export function janitorOf(client: object): Janitor | null {
  return janitors.get(client) ?? null;
}

export class Janitor {
  readonly #opts: JanitorOptions;
  readonly #seen = new Map<string, number>();
  readonly #offs: Array<() => void> = [];
  #creating = 0;
  #lastUse = Date.now();
  #interval: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #soon: NodeJS.Timeout | null = null;
  #sweeping: Promise<SweepReport> | null = null;
  /** Pages already there when the browser connected: left by an earlier session (or restored by Chrome), never Fanfold's work now. */
  #before: Set<string> | null = null;
  #again = false;
  #stopped = false;
  #idled = false;

  constructor(opts: JanitorOptions) {
    this.#opts = opts;
  }

  get mode(): TabMode { return this.#opts.mode; }
  get ledger(): TabLedger { return this.#opts.ledger; }

  /** Watch the browser, sweep what an earlier session left, and keep sweeping. */
  async start(): Promise<SweepReport> {
    const { client, ledger } = this.#opts;
    janitors.set(client, this);
    this.#offs.push(
      client.on('Target.targetCreated', (params) => this.#created(params.targetInfo as TargetInfo)),
      client.on('Target.targetInfoChanged', (params) => this.#changed(params.targetInfo as TargetInfo)),
      client.on('Target.targetDestroyed', (params) => this.#destroyed(String(params.targetId ?? ''))),
      ledger.on((event) => {
        if (event.type === 'ended') this.sweepSoon(`${ownerKey(event.owner)} ended`);
        // A tab opened is the browser in use; one closed is not.
        else if (event.type === 'claimed') this.touch();
        // The idle window starts when the last tab of Fanfold's here goes, however long ago the browser was last used.
        else if (event.type === 'released' && event.owner && !this.#rows().length) this.touch();
      }),
    );
    // The user's Chrome does not offer discovery through the extension; its tabs are reported to noteOpened instead.
    await client.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    this.#interval = setInterval(() => void this.sweep('interval'), janitorTiming.sweepMs);
    this.#interval.unref();
    const report = await this.sweep('connected', { before: true });
    this.#armIdle();
    return report;
  }

  stop(): void {
    this.#stopped = true;
    for (const off of this.#offs.splice(0)) off();
    if (this.#interval) clearInterval(this.#interval);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#soon) clearTimeout(this.#soon);
    this.#interval = this.#idleTimer = this.#soon = null;
    if (janitors.get(this.#opts.client) === this) janitors.delete(this.#opts.client);
  }

  /** The browser was used just now. */
  touch(): void {
    this.#lastUse = Date.now();
    this.#idled = false;
    this.#armIdle();
  }

  /** Claim a tab Fanfold just created for this owner. */
  claim(targetId: string, owner: Owner, url = 'about:blank'): void {
    this.#seen.set(targetId, Date.now());
    this.#opts.ledger.claim({ targetId, mode: this.#opts.mode, url }, owner);
  }

  /** Creating a tab: until it is claimed, the sweep closes no tab nobody owns. */
  async creating<T>(work: () => Promise<T>): Promise<T> {
    this.#creating++;
    try {
      return await work();
    } finally {
      this.#creating--;
    }
  }

  /** A tab was opened from another (the extension reports these): it is its opener's owner's, if that is Fanfold's. */
  noteOpened(target: TabRef, openerTargetId: string | null): Owner | null {
    this.#seen.set(target.targetId, Date.now());
    if (!openerTargetId || this.#opts.ledger.get(target.targetId)) return null;
    return this.#opts.ledger.inherit({ ...target, mode: this.#opts.mode }, openerTargetId);
  }

  /** Sweep shortly, once for a burst of reasons. */
  sweepSoon(reason: string): void {
    if (this.#stopped || this.#soon) return;
    this.#soon = setTimeout(() => {
      this.#soon = null;
      void this.sweep(reason);
    }, 50);
    this.#soon.unref();
  }

  /**
   * One pass. `force` closes kept tabs too, for a shutdown. `before` is the
   * pass on connecting: every page already open then that nobody owns goes at
   * once, with no grace, since none of them can be a tab Fanfold is making.
   * Never throws.
   */
  sweep(reason: string, opts: { force?: boolean; before?: boolean } = {}): Promise<SweepReport> {
    if (this.#sweeping) {
      this.#again = true;
      return this.#sweeping.then(() => this.sweep(reason, opts));
    }
    const run = this.#sweep(reason, opts.force ?? false, opts.before ?? false)
      .catch((err: unknown) => {
        this.#opts.log?.debug('the janitor could not sweep', { component: 'janitor', reason, err });
        return { closed: [], dropped: [] };
      })
      .finally(() => {
        this.#sweeping = null;
        if (this.#again && !this.#stopped) {
          this.#again = false;
          this.sweepSoon('again');
        }
      });
    this.#sweeping = run;
    return run;
  }

  async #sweep(reason: string, force: boolean, before: boolean): Promise<SweepReport> {
    const { client, ledger, mode } = this.#opts;
    const report: SweepReport = { closed: [], dropped: [] };
    if (this.#stopped && !force) return report;
    if (client.closed) return report;
    const { targetInfos } = await client.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page' && !t.subtype);
    const live = new Map(pages.map((t) => [t.targetId, t]));
    if (before) this.#before = new Set(live.keys());
    const now = Date.now();
    for (const t of pages) if (!this.#seen.has(t.targetId)) this.#seen.set(t.targetId, now);
    for (const id of this.#seen.keys()) if (!live.has(id)) this.#seen.delete(id);

    for (const row of this.#rows()) {
      const target = live.get(row.targetId);
      if (!target) {
        ledger.release(row.targetId);
        report.dropped.push(row.targetId);
        continue;
      }
      if (target.url) ledger.noteUrl(row.targetId, target.url);
      if (!force && await this.#stillKept(row.targetId, row.owner, row.keepUntil, now)) continue;
      if (!force && ledger.alive(row.owner)) continue;
      // Asked again just before closing: an owner can come back between the list and here.
      const fresh = ledger.get(row.targetId);
      if (!fresh || (!force && (ledger.alive(fresh.owner) || (fresh.keepUntil && Date.parse(fresh.keepUntil) > now)))) continue;
      await this.#close(row.targetId, report);
    }

    if (mode !== 'extension' && !this.#opts.foreign && !this.#creating) {
      const old = (t: TargetInfo): boolean => this.#before?.has(t.targetId) === true
        || now - (this.#seen.get(t.targetId) ?? now) >= janitorTiming.graceMs;
      const unowned = pages.filter((t) => !ledger.get(t.targetId) && old(t));
      const owned = pages.filter((t) => ledger.get(t.targetId)).length;
      // Closing the last tab closes the last window, which on most systems quits Chrome; the idle close does that properly.
      // The one kept is blank: a page from before (a form with someone's answers in it) is never what stays.
      let spare = owned ? null : (pages.find((t) => !ledger.get(t.targetId) && BLANK.test(t.url ?? '')) ?? null);
      if (!owned && !spare && unowned.length) spare = await this.#blank();
      for (const t of unowned) {
        if (t.targetId === spare?.targetId || ledger.get(t.targetId)) continue;
        await this.#close(t.targetId, report);
      }
    }
    if (report.closed.length || report.dropped.length) {
      this.#opts.log?.debug('the janitor swept', { component: 'janitor', reason, closed: report.closed.length, dropped: report.dropped.length });
    }
    this.#armIdle();
    return report;
  }

  /** This browser's rows. */
  #rows(): OwnedTab[] {
    const { ledger, mode, only } = this.#opts;
    const rows = ledger.all(mode);
    return only ? rows.filter((row) => sameOwner(row.owner, only)) : rows;
  }

  /** Kept, and still waiting by the rule that kept it; a kept tab whose wait is over is let go. */
  async #stillKept(targetId: string, owner: Owner, keepUntil: string | null, now: number): Promise<boolean> {
    if (!keepUntil) return false;
    const { ledger } = this.#opts;
    const rule = ledger.keepRule(owner);
    let waits = Date.parse(keepUntil) > now;
    if (waits && rule) {
      try { waits = rule.waits(); } catch { waits = false; }
    }
    if (waits) return true;
    ledger.unkeep(targetId);
    if (rule?.expire) {
      ledger.unkeepOwner(owner);
      try { await rule.expire(); } catch { /* whatever it could not end, the next sweep closes */ }
    }
    return false;
  }

  /** A blank tab nobody owns, to keep the window while everything else goes. Null if it could not be made. */
  async #blank(): Promise<TargetInfo | null> {
    try {
      const { targetId } = await this.#opts.client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      this.#seen.set(targetId, Date.now());
      return { targetId, type: 'page', url: 'about:blank' };
    } catch {
      return null;
    }
  }

  async #close(targetId: string, report: SweepReport): Promise<void> {
    await this.#opts.client.send('Target.closeTarget', { targetId }).catch(() => {});
    this.#opts.ledger.release(targetId);
    this.#seen.delete(targetId);
    report.closed.push(targetId);
  }

  #created(info: TargetInfo | undefined): void {
    if (!info || info.type !== 'page') return;
    this.#seen.set(info.targetId, Date.now());
    if (info.openerId) this.noteOpened({ targetId: info.targetId, mode: this.#opts.mode, url: info.url }, info.openerId);
  }

  #changed(info: TargetInfo | undefined): void {
    if (!info || info.type !== 'page') return;
    // An opener can be reported after the tab itself.
    if (info.openerId && !this.#opts.ledger.get(info.targetId)) this.noteOpened({ targetId: info.targetId, mode: this.#opts.mode, url: info.url }, info.openerId);
    // Where a tab of Fanfold's is now, for the list of tabs in use: as it goes, not at the next sweep.
    else if (info.url && this.#opts.ledger.get(info.targetId)) this.#opts.ledger.noteUrl(info.targetId, info.url);
  }

  #destroyed(targetId: string): void {
    this.#seen.delete(targetId);
    const row = this.#opts.ledger.get(targetId);
    if (row && row.mode === this.#opts.mode) this.#opts.ledger.release(targetId);
  }

  /** Check for idleness when the idle window would end, if the ledger holds nothing of this browser's. */
  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    if (this.#stopped || this.#idled || !this.#opts.onIdle) return;
    if (this.#rows().length) return;
    const wait = Math.max(0, this.#lastUse + janitorTiming.idleMs - Date.now());
    this.#idleTimer = setTimeout(() => void this.#idle(), wait + 10);
    this.#idleTimer.unref();
  }

  async #idle(): Promise<void> {
    this.#idleTimer = null;
    if (this.#stopped || this.#idled) return;
    if (Date.now() - this.#lastUse < janitorTiming.idleMs || this.#opts.busy?.()) return this.#armIdle();
    await this.sweep('idle');
    if (this.#stopped || this.#rows().length || this.#opts.busy?.()) return;
    if (Date.now() - this.#lastUse < janitorTiming.idleMs) return this.#armIdle();
    this.#idled = true;
    try {
      await this.#opts.onIdle?.();
    } catch (err) {
      this.#opts.log?.warn('could not close an idle browser', { component: 'janitor', err });
    }
  }
}
