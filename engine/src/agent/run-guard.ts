/**
 * The safety nets MCP sessions get (policy/site-guard.ts and
 * observe/display-wake.ts), for Fanfold's own runs: the chat, workers,
 * sub-agents, agent_run and submissions approved in Review.
 *
 * Every page a run opens takes a slot in its site's pace, the same pace and
 * pause table every MCP session in this process uses. A site that answers
 * 429 (or 503 with Retry-After) is paused for all of them and ends the run;
 * so does a site that is already paused, and a Chrome that stopped drawing
 * because the display slept. An action under way is settled first: the run
 * stops at the start of the next step, before the model is asked anything.
 */
import type { BrowserRuntime, ObserveOptions } from '../observe/runtime.ts';
import type { ActionResult, Observation } from '../types.ts';
import type { SitePolicies } from '../jobs/site-policies.ts';
import type { Logger } from '../lib/log.ts';
import { beforeAction, beforeNavigation, landedPaused, pushbackIn, SitePausedError, type GuardContext } from '../policy/site-guard.ts';
import { PaceRefusal, sitePace, type SitePace } from '../policy/site-pace.ts';
import { whenText } from '../policy/pushback.ts';
import { DisplayAsleepError, displayKeeper, ensureDrawing, type DisplayKeeper } from '../observe/display-wake.ts';

export type HaltReason = 'site_paused' | 'display_asleep';

/** Ends a run, with what to tell the person. */
export class RunHalt extends Error {
  readonly reason: HaltReason;
  constructor(message: string, reason: HaltReason) {
    super(message);
    this.reason = reason;
  }
}

export interface RunGuardOptions {
  sites?: Pick<SitePolicies, 'forUrl' | 'downgrade'>;
  log?: Pick<Logger, 'warn'>;
  /** Shared with every MCP session unless a test gives its own. */
  pace?: SitePace;
  keeper?: DisplayKeeper;
  drawing?: { attempts?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> };
}

const RAW = Symbol('unguarded page');

function asleep(woke: boolean): string {
  return woke
    ? 'Stopped: Chrome stopped drawing pages because this Mac\'s screen went to sleep. Fanfold turned the screen back on, but the page still wouldn\'t draw. Nothing else was done. Wake the screen (or restart Fanfold), then try again.'
    : 'Stopped: Chrome stopped drawing pages because this Mac\'s screen went to sleep, and Fanfold couldn\'t turn the screen back on. Nothing else was done. Wake the screen (or restart Fanfold), then try again.';
}

function paused(site: string, status: number, when: string): string {
  return status === 429
    ? `Stopped: ${site} replied with HTTP 429 (too many requests), so Fanfold paused ${site} for every task until ${when}. Nothing else was done. Try again after that time.`
    : `Stopped: ${site} asked Fanfold to slow down (HTTP ${status}), so Fanfold won't open pages on ${site} for any task until ${when}. Nothing else was done. Try again after that time.`;
}

/** A navigation refused before anything reached the page: provably no effect. */
const refused = (err: Error): ActionResult => ({ ok: false, failure: 'NOT_ACTIONABLE', detail: err.message, navigated: false, ms: 0 });

export class RunGuard {
  readonly #opts: RunGuardOptions;
  #halt: RunHalt | null = null;
  #stepAt = Date.now();
  /** Where the run last looked, which is the page its next action lands on. */
  #url: string | undefined;
  /** Responses already looked at, so one 429 pauses its site once. */
  readonly #seen = new WeakSet<object>();
  /** Halts for a page that landed on a site already paused, which the browser then leaves. */
  readonly #landed = new WeakSet<RunHalt>();

  constructor(opts: RunGuardOptions = {}) {
    this.#opts = opts;
  }

  get #pace(): SitePace {
    return this.#opts.pace ?? sitePace;
  }

  get #ctx(): GuardContext {
    return { app: { sites: this.#opts.sites }, log: this.#opts.log };
  }

  /** The page as the run uses it: every navigation, in it or in tabs it opens, paced and watched. */
  wrap(given: BrowserRuntime): BrowserRuntime {
    const page = ((given as unknown as Record<symbol, unknown>)[RAW] as BrowserRuntime | undefined) ?? given;
    return new Proxy(page, {
      get: (target, prop) => {
        if (prop === RAW) return target;
        if (prop === 'goto') return (url: string, timeoutMs?: number) => this.#goto(target, url, timeoutMs);
        if (prop === 'act') {
          return async (...args: Parameters<BrowserRuntime['act']>): Promise<ActionResult> => {
            const [request] = args;
            try {
              await (request.kind === 'goto' && request.url ? this.#before(request.url) : this.#before(this.#url, true));
            } catch (err) {
              if (err instanceof RunHalt || err instanceof PaceRefusal) return refused(err);
              throw err;
            }
            const since = Date.now();
            const result = await target.act(...args);
            await this.#leaveIfPaused(target, this.#after(target, since));
            return result;
          };
        }
        if (prop === 'openTab' && target.openTab) {
          return async (...args: Parameters<NonNullable<BrowserRuntime['openTab']>>) => {
            const tab = await target.openTab!(...args);
            return { page: this.wrap(tab.page), close: () => tab.close() };
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * The start of a step: end the run if a site pushed back since the last
   * one, or Chrome has stopped drawing and cannot be brought back; otherwise
   * observe.
   */
  async observe(page: BrowserRuntime, options?: ObserveOptions): Promise<Observation> {
    this.#after(page, this.#stepAt);
    this.#stepAt = Date.now();
    this.check();
    try {
      await ensureDrawing(page, this.#opts.keeper ?? displayKeeper, this.#opts.drawing);
    } catch (err) {
      if (!(err instanceof DisplayAsleepError)) throw err;
      throw (this.#halt = new RunHalt(asleep(err.woke), 'display_asleep'));
    }
    const seen = await page.observe(options);
    this.#url = seen.url;
    return seen;
  }

  /** Throw what ended the run, if something has. */
  check(): void {
    if (this.#halt) throw this.#halt;
  }

  /** What ended the run, if something has. */
  halted(): string | null {
    return this.#halt?.message ?? null;
  }

  async #goto(page: BrowserRuntime, url: string, timeoutMs?: number): Promise<void> {
    await this.#before(url);
    const since = Date.now();
    let failed: unknown = null;
    await page.goto(url, timeoutMs).catch((err: unknown) => { failed = err; });
    const halt = this.#after(page, since);
    await this.#leaveIfPaused(page, halt);
    if (halt) throw halt;
    if (failed) throw failed;
  }

  /** Pages on a site that is paused are not stayed on, whoever got the browser there. */
  async #leaveIfPaused(page: BrowserRuntime, halt: RunHalt | null): Promise<void> {
    if (halt && this.#landed.has(halt)) await page.goto('about:blank').catch(() => {});
  }

  async #before(url: string | undefined, acting = false): Promise<void> {
    try {
      if (acting) await beforeAction(this.#ctx, url, this.#pace);
      else if (url) await beforeNavigation(this.#ctx, url, this.#pace);
    } catch (err) {
      if (!(err instanceof SitePausedError)) throw err;
      throw this.#halted(paused(err.site.label, err.pause.status, whenText(err.pause.until, Date.now())));
    }
  }

  /** The halt this page's latest response caused: the site pushed back, or the page is on a site already paused. */
  #after(page: BrowserRuntime, since: number): RunHalt | null {
    const seen = page.documentResponse?.(since) ?? null;
    const response = seen && !this.#seen.has(seen) ? seen : null;
    if (response) this.#seen.add(response);
    const hit = pushbackIn(this.#ctx, response, this.#pace);
    if (hit) return this.#halted(paused(hit.site.label, hit.pushback.status, whenText(hit.pushback.until, hit.now)));
    const held = landedPaused(this.#ctx, response, this.#pace);
    if (!held) return null;
    const halt = this.#halted(paused(held.site.label, held.pause.status, whenText(held.pause.until, Date.now())));
    this.#landed.add(halt);
    return halt;
  }

  /** The first halt is the run's; a later one is still thrown where it happened. */
  #halted(message: string): RunHalt {
    const halt = new RunHalt(message, 'site_paused');
    this.#halt ??= halt;
    return halt;
  }
}

/** The run's page held to the same pace and pauses, for a navigation made before the run itself starts. */
export function guardRun(page: BrowserRuntime, opts: RunGuardOptions = {}): BrowserRuntime {
  return new RunGuard(opts).wrap(page);
}
