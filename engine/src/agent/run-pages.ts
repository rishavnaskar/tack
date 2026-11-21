/**
 * Which page each run is working on, and the pages kept open after a run.
 *
 * Each run works on a page of its own. An approval answered later has to be
 * carried out on the page that asked for it, and a form the agent filled has
 * to still be there when the person comes to press Submit.
 *
 * A kept page is kept in the tab ledger (observe/tab-ledger.ts) the same way a
 * session's window is: until what it waits on is over or the limit passes,
 * then the janitor lets it go. There is no second way of keeping a tab.
 */
import type { BrowserRuntime, Tab } from '../observe/runtime.ts';
import { sameOwner, type Owner, type TabLedger } from '../observe/tab-ledger.ts';

/** Pages kept open for a person to come back to. The oldest goes when this many are held. */
const MAX_PARKED = 8;

/** How long a page is kept for a person who does not come back to it. */
export const parkedPages = { limitMs: 12 * 60 * 60_000 };

/** Why a kept page is kept, as the ledger records it. */
const COPY = {
  parked: 'Something on this page is waiting for you, so Fanfold keeps it open until you’re done.',
};

/** The web page a kept page was last seen on, or null for a blank one. */
function formAt(page: BrowserRuntime): string | null {
  const url = page.lastObservation?.url ?? '';
  return /^https?:/.test(url) ? url : null;
}

export interface RunPagesOptions {
  ledger?: TabLedger;
  /**
   * Whether what the run left on its page still waits on the user. `key` is
   * what the page was kept for (an application), when it was kept for one.
   * Without it, a kept page waits until released or the limit.
   */
  waits?(runId: string, key: string | null): boolean;
}

interface Parked {
  tab: Tab;
  key: string | null;
  owner: Owner | null;
  until: number;
}

export class RunPages {
  readonly #pages = new Map<string, BrowserRuntime>();
  readonly #parked = new Map<string, Parked>();
  readonly #opts: RunPagesOptions;

  constructor(opts: RunPagesOptions = {}) {
    this.#opts = opts;
  }

  /** Tie a run to its page. Returns how to untie it. */
  bind(runId: string, page: BrowserRuntime): () => void {
    this.#pages.set(runId, page);
    return () => { this.#pages.delete(runId); };
  }

  /**
   * The run's own page, or null once it has none. There is no stand-in: an
   * approval pressed on another window could send that window's form.
   */
  pageFor(runId: string): BrowserRuntime | null {
    return this.#pages.get(runId) ?? null;
  }

  /**
   * Keep a run's page open after the run has ended, because a person still
   * has to come back to it: an approval to answer, a question, or a filled
   * form that is theirs to submit. One page per `key`: a page kept for the
   * same key before this one goes. Bounded, so abandoned pages do not pile up.
   */
  park(runId: string, tab: Tab, opts: { key?: string } = {}): void {
    const key = opts.key ?? null;
    // The same form kept for another key (the same job recorded twice) is this one, older: it goes too.
    const form = formAt(tab.page);
    for (const [id, held] of [...this.#parked]) {
      if (id !== runId && (key === null || held.key !== key) && !(form && key !== null && formAt(held.tab.page) === form)) continue;
      if (held.tab === tab || held.tab.page === tab.page) this.#unpark(id);
      else void this.release(id);
    }
    const owner = tab.owner ?? tab.page.owner ?? null;
    this.#pages.set(runId, tab.page);
    this.#parked.set(runId, { tab, key, owner, until: Date.now() + parkedPages.limitMs });
    this.#keep(owner);
    void tab.page.indicate?.('waiting').catch(() => {});
    while (this.#parked.size > MAX_PARKED) {
      void this.release(this.#parked.keys().next().value as string);
    }
  }

  parked(): string[] {
    return [...this.#parked.keys()];
  }

  /** The page kept under `key`, or null. */
  pageForKey(key: string): BrowserRuntime | null {
    for (const held of this.#parked.values()) if (held.key === key) return held.tab.page;
    return null;
  }

  /** Hand the page kept under `key` to a run that continues on it: no longer kept, and not closed. Null when none is. */
  take(key: string): Tab | null {
    const runId = [...this.#parked].find(([, held]) => held.key === key)?.[0];
    if (runId === undefined) return null;
    const held = this.#unpark(runId)!;
    this.#pages.delete(runId);
    void held.tab.page.indicate?.('working').catch(() => {});
    return held.tab;
  }

  async release(runId: string): Promise<void> {
    const held = this.#unpark(runId);
    this.#pages.delete(runId);
    await held?.tab.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.parked().map((runId) => this.release(runId)));
  }

  #waits(runId: string): boolean {
    const held = this.#parked.get(runId);
    return !!held && (this.#opts.waits?.(runId, held.key) ?? true);
  }

  /**
   * The ledger keeps by owner, and several kept pages can share one (the
   * sub-agents of one run): the owner's tabs are kept while any of its kept
   * pages waits, and all of them go together.
   */
  #keep(owner: Owner | null): void {
    const { ledger } = this.#opts;
    if (!ledger || !owner) return;
    const runs = (): string[] => [...this.#parked].filter(([, held]) => sameOwner(held.owner, owner)).map(([id]) => id);
    const held = runs();
    if (!held.length) return;
    const until = Math.max(...held.map((id) => this.#parked.get(id)!.until));
    ledger.keepOwner(owner, new Date(until), COPY.parked, {
      waits: () => runs().some((id) => this.#waits(id)),
      expire: async () => { await Promise.all(runs().map((id) => this.release(id))); },
    });
  }

  #unpark(runId: string): Parked | null {
    const held = this.#parked.get(runId) ?? null;
    if (!held) return null;
    this.#parked.delete(runId);
    if (held.owner) {
      this.#opts.ledger?.unkeepOwner(held.owner);
      this.#keep(held.owner);
    }
    return held;
  }
}
