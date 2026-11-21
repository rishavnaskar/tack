/**
 * A BrowserRuntime that survives losing its browser.
 *
 * Browsers die: the user quits the window, the OS updates Chrome, a renderer
 * crashes, the machine sleeps. A long run should not be destroyed by that
 * when the profile — and therefore every signed-in session — is still on disk.
 *
 * The important restraint is WHAT gets retried.
 *
 *   - Reads (observe, screenshot) and navigation are safe to redo, so after
 *     reconnecting we re-navigate to the last known URL and retry once.
 *
 *   - Actions are NOT retried. When a click fails because the transport died,
 *     we do not know whether it landed — the click may have been delivered
 *     and the page may have acted on it. Retrying would be a guess, and for
 *     anything that leaves the machine it is the guess that sends a message
 *     twice. So the session is recovered, the action is reported as failed,
 *     and the effect journal (store/db.ts) is what decides whether it is safe to
 *     try again.
 */

import type { BrowserRuntime, ObserveOptions, PageJobData, Tab } from './runtime.ts';
import type { FrameState } from './frames.ts';
import type { DocumentResponse } from './requests.ts';
import type { Owner } from './tab-ledger.ts';
import type { IndicatorState } from './indicator.ts';
import type { Observation, ActionRequest, ActionResult } from '../types.ts';
import { currentRun } from '../lib/run-scope.ts';
import { isTransportLoss as messageIsTransportLoss } from '../cdp/loss.ts';

interface ResilientOptions {
  /** Creates a fresh runtime. Called again after a loss. */
  create: () => Promise<BrowserRuntime>;
  /** How many times to rebuild the browser before giving up. */
  maxReconnects?: number;
  onReconnect?: (attempt: number, reason: string) => void;
  /** Called as each use begins, with the run it is made from, if any. */
  onUse?: (runId: string | null) => void;
}

export class ResilientRuntime implements BrowserRuntime {
  #inner: BrowserRuntime | null = null;
  #opts: ResilientOptions;
  #lastUrl: string | null = null;
  #reconnects = 0;
  /** A start or restart under way. Parallel sessions lose the same browser together, and one restart serves them all. */
  #pending: Promise<BrowserRuntime> | null = null;
  /** The page last put back after a restart, and whether anything worked on it since. */
  #restored: { url: string; used: boolean } | null = null;
  #busy = 0;

  constructor(opts: ResilientOptions) {
    this.#opts = opts;
  }

  /** Something is being done with this browser right now. */
  get busy(): boolean {
    return this.#busy > 0;
  }

  /** Whether a page is open behind this runtime now, rather than one to be made on next use. */
  get open(): boolean {
    return this.#inner !== null;
  }

  get owner(): Owner | null {
    return this.#inner?.owner ?? null;
  }

  /**
   * Let the page go without counting it as lost: nothing uses it, and the
   * next use opens a new one, blank, in whatever browser is there then.
   * Returns the page let go, for the caller to close; null when one is being
   * made or something is using it.
   */
  suspend(): BrowserRuntime | null {
    if (this.#pending || this.#busy) return null;
    const inner = this.#inner;
    this.#inner = null;
    this.#lastUrl = null;
    this.#restored = null;
    return inner;
  }

  async indicate(state: IndicatorState | null): Promise<void> {
    await this.#inner?.indicate?.(state);
  }

  /** Every use goes through here, so "busy" is true of the browser as a whole. */
  async #use<T>(work: () => Promise<T>): Promise<T> {
    this.#busy++;
    try {
      this.#opts.onUse?.(currentRun());
    } catch { /* a listener's failure is its own */ }
    try {
      return await work();
    } finally {
      this.#busy--;
    }
  }

  /**
   * Opening a tab changes nothing on any page, so it is safe to repeat: a
   * browser found gone (after a switch between Fanfold's window and the
   * person's Chrome, say) is replaced and the tab opened in the new one.
   * A tab already open is not followed into the new browser.
   */
  async openTab(opts?: { window?: boolean; owner?: Owner }): Promise<Tab> {
    return await this.#use(() => this.#withRecovery(async (inner) => {
      if (!inner.openTab) throw new Error('this browser cannot open a second tab');
      return await inner.openTab(opts);
    }));
  }

  /** Without recovery: a browser that is gone has no tabs left to close. */
  async closeOpened(): Promise<number> {
    return this.#inner?.closeOpened ? await this.#inner.closeOpened() : 0;
  }

  /** Without recovery: a browser that is gone has no tab to leave, and its next page is new anyway. */
  async leaveTab(keep: { until: Date; why: string }): Promise<boolean> {
    const inner = this.#inner;
    if (!inner?.leaveTab) return false;
    const left = await this.#use(() => inner.leaveTab!(keep));
    // A restart puts back the new tab's page, not the one left for the person.
    if (left) this.#lastUrl = null;
    return left;
  }

  get lastObservation(): Observation | null {
    return this.#inner?.lastObservation ?? null;
  }

  get loadId(): string | undefined {
    return this.#inner?.loadId;
  }

  get reconnectCount(): number {
    return this.#reconnects;
  }

  /** The page's own, while there is one: see Page.lostTab. */
  get lostTab(): unknown {
    return (this.#inner as { lostTab?: unknown } | null)?.lostTab ?? null;
  }

  async #runtime(): Promise<BrowserRuntime> {
    if (this.#inner) return this.#inner;
    // Two first calls arriving together must not launch two browsers on one profile.
    this.#pending ??= this.#opts.create()
      .then((inner) => (this.#inner = inner))
      .finally(() => { this.#pending = null; });
    return await this.#pending;
  }

  /** Restart after `failed` was lost, unless another caller already has. */
  #reconnect(reason: string, failed: BrowserRuntime | null): Promise<BrowserRuntime> {
    if (this.#pending) return this.#pending;
    if (failed && this.#inner && this.#inner !== failed) return Promise.resolve(this.#inner);
    this.#inner = null;
    this.#pending = this.#rebuild(reason).finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #rebuild(reason: string): Promise<BrowserRuntime> {
    const max = this.#opts.maxReconnects ?? 3;
    if (this.#reconnects >= max) {
      throw new Error(`browser lost ${this.#reconnects} times (${reason}); giving up`);
    }
    this.#reconnects++;
    this.#opts.onReconnect?.(this.#reconnects, reason);
    const inner = await this.#opts.create();
    this.#inner = inner;
    // A page lost again before anything worked on it since it was put back is
    // what lost it (a page the extension refuses, one that crashes the tab):
    // going back would only lose the browser again, so the restart stops at a
    // blank page.
    if (this.#lastUrl && this.#restored?.url === this.#lastUrl && !this.#restored.used) {
      this.#lastUrl = null;
    }
    if (this.#lastUrl) {
      this.#restored = { url: this.#lastUrl, used: false };
      try {
        await inner.goto(this.#lastUrl);
      } catch (err) {
        /*
         * The replacement can die too, including from external termination
         * after a perfectly good handshake. That counts as one more loss
         * against the same budget, and the loop tries again, rather than
         * escaping as a raw "CDP client closed" from a runtime whose whole
         * job is to absorb exactly that.
         */
        if (!isTransportLoss(err)) throw err;
        this.#inner = null;
        return this.#rebuild(`the replacement browser was lost while restoring ${this.#lastUrl}: ${(err as Error).message}`);
      }
    }
    return inner;
  }

  /**
   * Run a SAFE-TO-REPEAT operation, rebuilding the browser as often as the
   * budget allows. Reads and navigation only — see the note on act().
   */
  async #withRecovery<T>(op: (runtime: BrowserRuntime) => Promise<T>): Promise<T> {
    for (;;) {
      const runtime = await this.#runtime();
      try {
        const result = await op(runtime);
        if (this.#restored) this.#restored.used = true;
        return result;
      } catch (err) {
        if (!isTransportLoss(err)) throw err;
        // Throws once the budget is spent, which ends the loop.
        await this.#reconnect((err as Error).message, runtime);
      }
    }
  }

  async goto(url: string, timeoutMs?: number): Promise<void> {
    await this.#use(() => this.#withRecovery((r) => r.goto(url, timeoutMs)));
    this.#lastUrl = url;
  }

  async observe(options?: ObserveOptions): Promise<Observation> {
    const obs = await this.#use(() => this.#withRecovery((r) => r.observe(options)));
    this.#lastUrl = obs.url;
    return obs;
  }

  /**
   * Perform an action. Never retried across a reconnect.
   *
   * On transport loss the browser is rebuilt so the run can continue, and the
   * action comes back as a typed failure. Whether it actually happened is a
   * question for the effect journal, not for a retry loop.
   */
  async act(request: ActionRequest): Promise<ActionResult> {
    return this.#use(() => this.#act(request));
  }

  async #act(request: ActionRequest): Promise<ActionResult> {
    /*
     * A navigation is safe to repeat, so it is repeated.
     *
     * `goto` names a URL and carries no effect that could happen twice:
     * arriving at a page once and arriving twice are the same thing. Every
     * other action carries a ref and may already have landed, which is why
     * none of them are retried.
     *
     * A goto CHOSEN BY THE MODEL arrives here, as act({kind:'goto'}), not
     * through goto(). Without the recovery, a browser lost at the moment of
     * the first navigation gives TRANSPORT_LOST, the model chooses the same
     * goto again, and the same thing happens: identical failures and a run
     * abandoned where one quiet retry would have carried it.
     */
    if (request.kind === 'goto' && request.url) {
      const url = request.url;
      const started = Date.now();
      try {
        await this.#withRecovery((r) => r.goto(url));
        this.#lastUrl = url;
        return { ok: true, navigated: true, ms: Date.now() - started };
      } catch (err) {
        // A transport loss here means the relaunch budget is spent; say so as the loss it is.
        return {
          ok: false, failure: isTransportLoss(err) ? 'TRANSPORT_LOST' : 'CDP_ERROR', detail: (err as Error).message,
          navigated: false, ms: Date.now() - started,
        };
      }
    }

    let runtime: BrowserRuntime;
    try {
      runtime = await this.#runtime();
    } catch (err) {
      return { ok: false, failure: 'CDP_ERROR', detail: (err as Error).message, navigated: false, ms: 0 };
    }

    let result: ActionResult;
    try {
      result = await runtime.act(request);
    } catch (err) {
      if (!isTransportLoss(err)) throw err;
      return this.#afterLostAction((err as Error).message, runtime);
    }

    // A transport loss can arrive as a RESULT rather than a throw — Page.act
    // catches its own errors and returns a typed failure. Reconnecting only
    // on a thrown one would leave a browser that died during an action
    // unrebuilt, and every action after it failing for a reason nothing was
    // watching for.
    if (result.failure === 'TRANSPORT_LOST') {
      return this.#afterLostAction(result.detail ?? 'the transport closed during the action', runtime);
    }
    if (this.#restored) this.#restored.used = true;
    return result;
  }

  /**
   * Rebuild the browser after an action was lost, and report the outcome as
   * unknown.
   *
   * The action is never retried. When the transport dies mid-action we do not
   * know whether it landed, and retrying is a guess that, for anything
   * leaving the machine, sends the message twice. The session is recovered so
   * the run can continue; whether the effect happened is a question for the
   * effect journal.
   */
  async #afterLostAction(reason: string, failed: BrowserRuntime): Promise<ActionResult> {
    let relaunchFailed = '';
    try {
      await this.#reconnect(reason, failed);
    } catch (fatal) {
      // Still TRANSPORT_LOST. Failing to relaunch does not change what
      // happened to the action — reporting CDP_ERROR here would throw away
      // the original cause and tell the caller a different story about it.
      relaunchFailed = ` The browser could not be restarted either: ${(fatal as Error).message}.`;
    }
    return {
      ok: false,
      failure: 'TRANSPORT_LOST',
      detail: relaunchFailed
        ? `${reason}.${relaunchFailed} Whether the action took effect is unknown.`
        : `${reason}. The browser has been restarted; whether the action took effect is unknown, ` +
          'so re-observe before deciding.',
      navigated: true,
      ms: 0,
    };
  }

  async screenshot(): Promise<Buffer> {
    return this.#use(() => this.#withRecovery((r) => r.screenshot()));
  }

  /** Without recovery: a browser that is gone draws nothing, and the next call rebuilds it. */
  async drawing(): Promise<FrameState> {
    return this.#inner?.drawing ? await this.#inner.drawing() : 'unknown';
  }

  documentResponse(since?: number): DocumentResponse | null {
    return this.#inner?.documentResponse?.(since) ?? null;
  }

  async jobPosting(): Promise<PageJobData> {
    return this.#use(() => this.#withRecovery(async (r) => r.jobPosting ? r.jobPosting() : { ld: [], heading: null, siteName: null, title: '' }));
  }
}

function isTransportLoss(err: unknown): boolean {
  // A precondition error ("browser not started") is included here only
  // because it means this wrapper has nothing to talk to yet, which a rebuild
  // does fix. It is not treated as browser loss anywhere else.
  const message = (err as Error)?.message ?? '';
  return messageIsTransportLoss(message) || /not started/i.test(message);
}
