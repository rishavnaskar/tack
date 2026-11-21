/**
 * "Fanfold is working here", drawn into every tab Fanfold works in.
 *
 * Drawn through CDP in an isolated world (indicator-page.js), the same way in
 * Fanfold's own Chrome and in the user's, with no new extension permission
 * and no content script. It must never lie and never reach a model:
 *  - Fanfold beats every few seconds; the page removes it when the beats stop,
 *    so a crash, a detach or a cancelled debugging session clears it;
 *  - the serializer skips its tag and it sits outside body in a closed shadow
 *    root; screenshots hide it for the capture; nothing in it takes a click.
 */
import { readFileSync } from 'node:fs';
import { isTransportLoss } from '../cdp/loss.ts';

export type IndicatorState = 'working' | 'waiting' | 'paused';

/** What the pill says. */
export const COPY: Record<IndicatorState, string> = {
  working: 'Fanfold is working here',
  waiting: 'Fanfold is waiting for you',
  paused: 'Fanfold is paused',
};

export const INDICATOR_WORLD = 'fanfold-indicator';

/** How often Fanfold beats. */
const BEAT_MS = 5_000;
/** How long the page waits for a beat before it takes the indicator down. */
const EXPIRE_MS = 15_000;

const PAGE_SOURCE = readFileSync(new URL('./indicator-page.js', import.meta.url), 'utf8');

/** The script that draws it, or beats it when it is already drawn. */
export function indicatorSource(state: IndicatorState, expireMs = EXPIRE_MS): string {
  return `(${PAGE_SOURCE})(${JSON.stringify({ state, texts: COPY, expireMs })})`;
}

/** The beat: one call, which says when the indicator is missing from this document. */
function beatExpression(state: IndicatorState): string {
  return `globalThis.__fanfoldIndicator ? globalThis.__fanfoldIndicator.beat(${JSON.stringify(state)}) : 'missing'`;
}

interface IndicatorPort {
  /** A command to the tab's current session. */
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** An expression in the indicator's world of the tab's top frame. */
  evaluate(expression: string): Promise<unknown>;
}

/** One tab's indicator, following its page across documents and sessions. */
export class Indicator {
  readonly #port: IndicatorPort;
  #state: IndicatorState | null = null;
  #script: string | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(port: IndicatorPort) {
    this.#port = port;
  }

  get state(): IndicatorState | null {
    return this.#state;
  }

  /** Show it in this state, now and on every document the tab loads. */
  async set(state: IndicatorState): Promise<void> {
    const changed = state !== this.#state;
    this.#state = state;
    if (changed || !this.#script) await this.#register();
    await this.#draw();
    this.#beating();
  }

  /** Take it down now, and stop drawing it on new documents. */
  async clear(): Promise<void> {
    this.#state = null;
    this.#stopBeating();
    await this.#unregister();
    await this.#port.evaluate("globalThis.__fanfoldIndicator ? globalThis.__fanfoldIndicator.clear() : 'none'").catch(() => {});
  }

  /** The tab has a new session (another tab, or the same tab attached again): scripts registered on the old one are gone. */
  async reattached(): Promise<void> {
    this.#script = null;
    if (!this.#state) return;
    await this.#register();
    await this.#draw();
    this.#beating();
  }

  /** The tab went away: no beats into nothing until it is attached again. */
  pause(): void {
    this.#stopBeating();
  }

  /** The session is going away without a word to the page: the page's own expiry takes it down. */
  dispose(): void {
    this.#stopBeating();
    this.#state = null;
    this.#script = null;
  }

  /** Run `capture` with the indicator out of the picture. */
  async hidden<T>(capture: () => Promise<T>): Promise<T> {
    if (!this.#state) return capture();
    await this.#port.evaluate('globalThis.__fanfoldIndicator ? globalThis.__fanfoldIndicator.hide(true) : false').catch(() => {});
    try {
      return await capture();
    } finally {
      await this.#port.evaluate('globalThis.__fanfoldIndicator ? globalThis.__fanfoldIndicator.hide(false) : false').catch(() => {});
    }
  }

  async beat(): Promise<void> {
    const state = this.#state;
    if (!state) return;
    const answer = await this.#port.evaluate(beatExpression(state)).catch((err: unknown) => {
      // A browser that is gone has no page to beat into.
      if (isTransportLoss(err)) this.#stopBeating();
      return 'failed';
    });
    if (answer === 'missing') await this.#draw();
  }

  async #register(): Promise<void> {
    await this.#unregister();
    if (!this.#state) return;
    const { identifier } = await this.#port.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', {
      source: indicatorSource(this.#state), worldName: INDICATOR_WORLD,
    }).catch(() => ({ identifier: '' }));
    this.#script = identifier || null;
  }

  async #unregister(): Promise<void> {
    const identifier = this.#script;
    this.#script = null;
    if (identifier) await this.#port.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
  }

  async #draw(): Promise<void> {
    if (this.#state) await this.#port.evaluate(indicatorSource(this.#state)).catch(() => {});
  }

  #beating(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.beat(), BEAT_MS);
    this.#timer.unref();
  }

  #stopBeating(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
