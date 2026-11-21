/**
 * Whether Chrome is still drawing a page.
 *
 * On a Mac, a visible Chrome that was started with the display on stops
 * producing frames when the display goes to sleep: timers keep running and
 * the page still says it is visible, but requestAnimationFrame never fires,
 * so a dialog a site opens in a frame callback never appears and a
 * screenshot waits forever. One animation frame, asked for with a short
 * deadline, tells the difference cheaply.
 */

export type FrameState = 'drawn' | 'stalled' | 'hidden' | 'headless' | 'unknown';

const FRAME_DEADLINE_MS = 600;

export function frameProbe(deadlineMs = FRAME_DEADLINE_MS): string {
  return `(() => /HeadlessChrome/.test(navigator.userAgent) ? 'headless'
    : document.visibilityState !== 'visible' ? 'hidden'
    : new Promise((resolve) => { requestAnimationFrame(() => resolve('drawn')); setTimeout(() => resolve('stalled'), ${deadlineMs}); }))()`;
}

const STATES = new Set<FrameState>(['drawn', 'stalled', 'hidden', 'headless']);

/** A page that cannot answer at all is not judged here: that is a different failure, reported where it happens. */
export async function frameState(
  evaluate: (expression: string) => Promise<unknown>, deadlineMs = FRAME_DEADLINE_MS, graceMs = 2_000,
): Promise<FrameState> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<FrameState>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), deadlineMs + graceMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([evaluate(frameProbe(deadlineMs)).catch(() => 'unknown'), late]);
    return STATES.has(answer as FrameState) ? answer as FrameState : 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/**
 * Where the probe runs: a world of Fanfold's own in the page's main frame,
 * evaluated with no user gesture. A page's scripts cannot replace what it
 * calls (requestAnimationFrame, the user agent, visibility), so a page cannot
 * answer for it, and it hands the page no user activation either. Made once
 * per document; `key` changes when the document does.
 */
export class ProbeWorld {
  readonly #send: Send;
  readonly #name: string;
  #world: { key: string; id: number } | null = null;

  /** `name` picks the world; the indicator (indicator.ts) draws in one of its own. */
  constructor(send: Send, name = 'fanfold-probe') {
    this.#send = send;
    this.#name = name;
  }

  async evaluate(expression: string, frameId: string | null, key: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      // One document is one key, so its world is looked up once, not on every call.
      if (this.#world?.key !== key) {
        const frame = frameId ?? (await this.#send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')).frameTree.frame.id;
        const made = await this.#send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frame, worldName: this.#name, grantUniveralAccess: false });
        this.#world = { key, id: made.executionContextId };
      }
      try {
        const res = await this.#send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
          expression, contextId: this.#world.id, returnByValue: true, awaitPromise: true, userGesture: false,
        });
        if (res.exceptionDetails) throw new Error(`the frame probe failed: ${res.exceptionDetails.text}`);
        return res.result.value;
      } catch (err) {
        // A world that went with its document is made again, once.
        if (attempt > 0 || !/context/i.test((err as Error).message)) throw err;
        this.#world = null;
      }
    }
  }
}
