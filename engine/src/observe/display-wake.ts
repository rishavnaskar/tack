/**
 * Keeping a visible Chrome drawing on a Mac whose display wants to sleep.
 *
 * Chrome paces its frames to the display. With the display asleep, a Chrome
 * started while it was on stops drawing (see frames.ts), and the person is
 * usually away with the screen locked exactly when sessions are working.
 * Two things answer it, both macOS's own `caffeinate`:
 *
 *   - while sessions are working, a display-sleep assertion is held, tied to
 *     this process and released after a few idle minutes, so an idle Fanfold
 *     never keeps the display on;
 *   - before a session acts, one frame is asked for, and a page that does not
 *     draw has the display turned on (the screen stays locked) and is asked
 *     again. If it still does not draw, the agent is told so plainly.
 *
 * Nothing happens on other platforms or in a headless browser.
 */
import { spawn } from 'node:child_process';
import type { FrameState } from './frames.ts';

export interface Helper {
  stop(): void;
  /** Whether it could be started at all. */
  started: Promise<boolean>;
  /** Settles when it is gone, for whatever reason. */
  exited: Promise<void>;
}

export interface KeeperDeps {
  platform: NodeJS.Platform;
  run(command: string, args: string[]): Helper;
  /** Calls `fn` after `ms`; the returned function cancels it. Must not keep the process alive. */
  later(fn: () => void, ms: number): () => void;
  now(): number;
}

const CAFFEINATE = '/usr/bin/caffeinate';
/** Agents think between calls; this long without one and the sessions are idle. */
const IDLE_MS = 3 * 60_000;
/** The display is turned on at most this often, whatever pages do. */
export const WAKE_EVERY_MS = 60_000;

function runHelper(command: string, args: string[]): Helper {
  const child = spawn(command, args, { stdio: 'ignore' });
  const started = new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  const exited = new Promise<void>((resolve) => {
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
  child.unref();
  return { stop: () => { child.kill('SIGTERM'); }, started, exited };
}

const realDeps: KeeperDeps = {
  platform: process.platform,
  run: runHelper,
  later: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
  now: () => Date.now(),
};

export class DisplayKeeper {
  readonly #deps: KeeperDeps;
  readonly #idleMs: number;
  #hold: Helper | null = null;
  #cancelIdle: (() => void) | null = null;
  #lastWork = 0;
  #waking: Promise<boolean> | null = null;
  #woke: { at: number; ok: boolean } | null = null;

  constructor(deps: KeeperDeps = realDeps, opts: { idleMs?: number } = {}) {
    this.#deps = deps;
    this.#idleMs = opts.idleMs ?? IDLE_MS;
  }

  get supported(): boolean {
    return this.#deps.platform === 'darwin';
  }

  get holding(): boolean {
    return this.#hold !== null;
  }

  /** Sessions are working: hold the display awake until they have been idle for a while. */
  working(): void {
    if (!this.supported) return;
    this.#lastWork = this.#deps.now();
    if (!this.#hold) {
      let hold: Helper;
      // Holding the display is a help, never a precondition for working.
      try { hold = this.#deps.run(CAFFEINATE, ['-d', '-w', String(process.pid)]); } catch { return; }
      this.#hold = hold;
      void hold.exited.then(() => { if (this.#hold === hold) this.#release(); });
      this.#scheduleIdle(this.#idleMs);
    }
  }

  /**
   * Ask macOS to turn the display on. One request serves every session that
   * found it off, and a request in the last minute serves for this one too:
   * how often the display lights up is not something a page can decide.
   */
  wake(): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false);
    if (this.#woke && this.#deps.now() - this.#woke.at < WAKE_EVERY_MS) return Promise.resolve(this.#woke.ok);
    this.#waking ??= (async () => {
      let ok = false;
      try {
        ok = await this.#deps.run(CAFFEINATE, ['-u', '-t', '2']).started;
      } catch {
        ok = false;
      } finally {
        this.#woke = { at: this.#deps.now(), ok };
        this.#waking = null;
      }
      return ok;
    })();
    return this.#waking;
  }

  release(): void {
    this.#release();
  }

  #scheduleIdle(ms: number): void {
    this.#cancelIdle?.();
    this.#cancelIdle = this.#deps.later(() => {
      const idle = this.#deps.now() - this.#lastWork;
      if (idle >= this.#idleMs) this.#release();
      else this.#scheduleIdle(this.#idleMs - idle);
    }, ms);
  }

  #release(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = null;
    const hold = this.#hold;
    this.#hold = null;
    hold?.stop();
  }
}

export class DisplayAsleepError extends Error {
  /** Whether macOS was asked to turn the display on before giving up. */
  readonly woke: boolean;
  constructor(message: string, woke = false) {
    super(message);
    this.woke = woke;
  }
}

export const WOKE_NOTE = 'Note: the Mac\'s display had gone to sleep, and Chrome stops drawing pages while it is off. '
  + 'Fanfold turned the display on (the screen stays locked) and keeps it on while sessions are working.';

function asleepMessage(woke: boolean): string {
  return 'Chrome has stopped drawing pages: the Mac\'s display is asleep, and a visible Chrome only draws while it is on, '
    + 'so clicks would show nothing and a screenshot would never come back. '
    + (woke ? 'Fanfold asked macOS to turn the display on, and the page still did not draw. ' : 'Fanfold could not ask macOS to turn the display on. ')
    + 'Nothing was done on the page. Stop here and tell the user: waking the screen (or restarting Fanfold) lets the work carry on.';
}

/** How often, and how far apart, a page that stopped drawing is asked again after the display is woken. */
type RedrawOptions = { attempts?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> };

/**
 * Before a session works on its page: hold the display while working, and
 * bring back a page that stopped drawing. Returns a note for the agent, or
 * '' when there is nothing to say; throws DisplayAsleepError when it cannot.
 */
export async function ensureDrawing(
  page: { drawing?(): Promise<FrameState> },
  keeper: DisplayKeeper,
  opts: RedrawOptions = {},
): Promise<string> {
  if (!keeper.supported || !page.drawing) return '';
  const state = await page.drawing();
  if (state === 'headless') return '';
  keeper.working();
  if (state !== 'stalled') return '';
  const woke = await keeper.wake();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  for (let i = 0; i < (opts.attempts ?? 4); i++) {
    await sleep(opts.pauseMs ?? 750);
    if (await page.drawing() === 'drawn') return WOKE_NOTE;
  }
  throw new DisplayAsleepError(asleepMessage(woke), woke);
}

/**
 * ensureDrawing before a page is left for another: a page that stopped
 * drawing is never a reason to stay on it, so it is said, not thrown.
 */
export async function beforeLeaving(
  page: { drawing?(): Promise<FrameState> }, keeper: DisplayKeeper, opts: RedrawOptions = {},
): Promise<string> {
  try {
    return await ensureDrawing(page, keeper, opts);
  } catch (err) {
    if (!(err instanceof DisplayAsleepError)) throw err;
    return `Note: Chrome was not drawing the page this session was on (${err.woke ? 'the display was woken and it still did not draw' : 'the display could not be woken'}). `
      + 'The new page was opened anyway; if it does not draw either, stop and tell the user.';
  }
}

/** The one every session shares. */
export const displayKeeper = new DisplayKeeper();
