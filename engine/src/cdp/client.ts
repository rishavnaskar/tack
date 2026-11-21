/**
 * Minimal raw-CDP client: request/response correlation, flat sessions, events.
 *
 * Deliberately not a Playwright wrapper. The one thing it adds beyond plumbing
 * is a DOMAIN ALLOW-LIST: CDP is not a browser-automation API, it is the whole
 * browser's control surface, and several domains (Storage, Browser, Security,
 * Fetch) let a caller read credentials or disable protections. Everything we
 * need lives in a small set of domains, so we enumerate them and refuse the
 * rest at the client boundary — before a bug or an injected instruction can
 * reach them. See CONVERGENCE.md §2.4.
 */

import type { RawMessage } from './transport.ts';
import { loggerFromEnv, type Logger } from '../lib/log.ts';

/**
 * What the client needs from whatever carries CDP: the pipe to a Chrome we
 * launched, a debugging port, or the extension bridge into the user's own
 * Chrome. The allow-list below applies to all of them alike.
 */
export interface Transport {
  send(message: RawMessage): void;
  onMessage(fn: (m: RawMessage) => void): void;
  onClose(fn: () => void): void;
  onError?(fn: (err: Error) => void): void;
  close(): void;
}

/** Domains this agent is permitted to speak. Additions need a security review. */
export const ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  'Target',     // attach to tabs
  'Page',       // navigate, lifecycle, script-on-new-document
  'Runtime',    // evaluate the serializer
  'DOM',        // node resolution for precise input
  'Input',      // synthesized mouse/keyboard
  'Emulation',  // viewport, device metrics
  'Log',        // console/log surfacing for diagnostics
]);

/**
 * Individually permitted methods from domains that are NOT allowed wholesale.
 *
 * Downloads need `Browser.setDownloadBehavior`, and nothing else from that
 * domain. Admitting all of `Browser` to get it would also admit
 * `Browser.grantPermissions` — camera, microphone, geolocation, clipboard —
 * which is a much larger thing to hand an agent than a download directory.
 * So the exception is the method, not the domain.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'Browser.setDownloadBehavior',
  // Read-only: which Chrome this is. Diagnostics from another machine are
  // worth much less without it, and the binary's --version is not reliably
  // reachable from a script.
  'Browser.getVersion',
  // Only to be told which requests a page has in flight, so a snapshot waits
  // for the content a click asked for. Cookies, bodies and interception stay out.
  'Network.enable',
  // Only to keep agents' pages off Fanfold's own address: requests to it are held and failed at once.
  // Continuing, fulfilling or reading an intercepted request stays out.
  'Fetch.enable',
  'Fetch.disable',
  'Fetch.failRequest',
]);

export interface CdpClientOptions {
  /** Override the allow-list. Use only in tests. */
  allowedDomains?: ReadonlySet<string>;
  /** Override the single-method exceptions. Use only in tests. */
  allowedMethods?: ReadonlySet<string>;
  /** Per-command timeout, ms. */
  timeoutMs?: number;
  /** Where an event handler that threw is told of; the log by default. */
  onHandlerError?: (event: string, err: Error) => void;
}

/** The log, made the first time a handler fails: most clients never need it. */
let log: Logger | null = null;

/** A handler that threw is written down, so a bug in one is not invisible for ever. */
function logHandlerError(event: string, err: Error): void {
  log ??= loggerFromEnv();
  log.warn('a browser event handler failed', { component: 'cdp', event, err });
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method} failed (${code}): ${message}`);
    this.name = 'CdpError';
    this.code = code;
  }
}

export class CdpClient {
  #transport: Transport;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, Set<CdpEventHandler>>();
  #allowed: ReadonlySet<string>;
  #allowedMethods: ReadonlySet<string>;
  #timeoutMs: number;
  #closed = false;
  #onHandlerError: (event: string, err: Error) => void;

  constructor(transport: Transport, opts: CdpClientOptions = {}) {
    this.#transport = transport;
    this.#allowed = opts.allowedDomains ?? ALLOWED_DOMAINS;
    // Narrowed along with the domains when a test overrides them: a test that
    // pins the allow-list should not silently keep the exceptions.
    this.#allowedMethods = opts.allowedMethods
      ?? (opts.allowedDomains ? new Set<string>() : ALLOWED_METHODS);
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#onHandlerError = opts.onHandlerError ?? logHandlerError;
    transport.onMessage((m) => this.#dispatch(m));
    transport.onClose(() => this.#teardown());
    transport.onError?.((err) => this.#onHandlerError('transport', err));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Surfaced rather than swallowed: see #dispatch. */
  onHandlerError(fn: (event: string, err: Error) => void): void {
    this.#onHandlerError = fn;
  }

  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const domain = method.slice(0, method.indexOf('.'));
    if (!this.#allowed.has(domain) && !this.#allowedMethods.has(method)) {
      throw new Error(
        `CDP domain "${domain}" is not in the allow-list (method ${method}). ` +
          `Permitted domains: ${[...this.#allowed].join(', ')}. ` +
          `Permitted single methods: ${[...this.#allowedMethods].join(', ') || '(none)'}`,
      );
    }
    if (this.#closed) throw new Error('CDP client closed');

    const id = this.#nextId++;
    const message: RawMessage = sessionId ? { id, method, params, sessionId } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout after ${this.#timeoutMs}ms: ${method}`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer, method });
      try {
        this.#transport.send(message);
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  on(event: string, handler: CdpEventHandler): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /**
   * Resolve on the next occurrence of `event`, or reject on timeout.
   *
   * `sessionId` is not optional in practice: a browser with several tabs
   * emits the same events from all of them, so an unscoped wait can be
   * satisfied by a load in a completely different tab. Pass the session you
   * actually care about.
   */
  once(event: string, opts: { sessionId?: string; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      timer.unref?.();
      const off = this.on(event, (params, sessionId) => {
        if (opts.sessionId !== undefined && sessionId !== opts.sessionId) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    this.#transport.close();
  }

  #dispatch(m: RawMessage): void {
    const id = m.id as number | undefined;
    if (typeof id === 'number') {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const error = m.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(new CdpError(pending.method, error.code ?? -1, error.message ?? 'unknown'));
      } else {
        pending.resolve((m.result as Record<string, unknown>) ?? {});
      }
      return;
    }
    const method = m.method as string | undefined;
    if (!method) return;
    const handlers = this.#handlers.get(method);
    if (!handlers?.size) return;
    const params = (m.params as Record<string, unknown>) ?? {};
    const sessionId = m.sessionId as string | undefined;
    for (const h of [...handlers]) {
      try {
        h(params, sessionId);
      } catch (err) {
        // A handler throwing must not stall the protocol pump — but silently
        // discarding it means a bug in an event handler is invisible forever.
        try { this.#onHandlerError(method, err as Error); } catch { /* the reporter failing stops nothing */ }
      }
    }
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`CDP connection closed before ${p.method} completed`));
    }
    this.#pending.clear();
  }
}
