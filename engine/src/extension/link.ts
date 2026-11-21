/**
 * One authenticated extension connection: liveness, the bridge's own control
 * messages, and the transport currently riding on it.
 */

import type { WsConnection } from '../cdp/ws-server.ts';
import type { RawMessage } from '../cdp/transport.ts';
import { ExtensionTransport } from './transport.ts';

const RELEASE_WAIT_MS = 2_000;
/** More tabs than this in one report is not an extension telling the truth about its tabs. */
const MAX_REPORTED = 500;

/** A tab the extension opened for Fanfold (or that one of those opened), as it reports them on connecting. */
export interface CreatedTab {
  targetId: string;
  url: string;
  windowId: number | null;
  openerId: string | null;
}

/** What the person asked from the extension's popup. */
export type StopRequest = { targetId: string } | { all: true };

export interface LinkOptions {
  now: () => number;
  /**
   * Chrome puts a service worker to sleep after 30s without an event, and
   * traffic on its WebSocket counts as one. A ping well inside that keeps
   * the extension reachable while nothing is being automated.
   */
  pingIntervalMs: number;
  onStateChange: () => void;
  /** The user pressed Disconnect in the extension. */
  onUnpair: () => void;
  onGone: (link: ExtensionLink, reason: string) => void;
  /** The extension said which tabs it opened for Fanfold, before answering anything. */
  onCreated?: (tabs: CreatedTab[]) => void;
  /** The person pressed Stop in the extension's popup. */
  onStop?: (request: StopRequest) => void;
}

const TARGET = /^tab-\d{1,12}$/;

function createdTabs(value: unknown): CreatedTab[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_REPORTED).flatMap((t: Record<string, unknown>) => {
    if (!t || typeof t !== 'object' || typeof t.targetId !== 'string' || !TARGET.test(t.targetId)) return [];
    return [{
      targetId: t.targetId,
      url: typeof t.url === 'string' ? t.url.slice(0, 4096) : '',
      windowId: Number.isInteger(t.windowId) ? t.windowId as number : null,
      openerId: typeof t.openerId === 'string' && TARGET.test(t.openerId) ? t.openerId : null,
    }];
  });
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 64) : null;
}

export class ExtensionLink {
  readonly extensionVersion: string | null;
  readonly chromeVersion: string | null;
  paused: boolean;
  #ws: WsConnection;
  #opts: LinkOptions;
  #lastSeen: number;
  #pingTimer: NodeJS.Timeout;
  #transport: ExtensionTransport | null = null;
  #releases = new Map<number, () => void>();
  #releaseRef = 0;
  #gone = false;
  /** Whether the user let the extension read local files, which attaching a file needs; null until it says. */
  fileAccess: boolean | null = null;

  constructor(ws: WsConnection, hello: RawMessage, opts: LinkOptions) {
    this.#ws = ws;
    this.#opts = opts;
    this.extensionVersion = label(hello.extensionVersion);
    this.chromeVersion = label(hello.chrome);
    this.paused = hello.paused === true;
    this.#lastSeen = opts.now();
    this.#pingTimer = setInterval(() => {
      if (opts.now() - this.#lastSeen > opts.pingIntervalMs * 3) return this.drop('timeout', 4002);
      this.post({ bridge: 'ping' });
    }, opts.pingIntervalMs);
    this.#pingTimer.unref?.();
    ws.onMessage((raw) => this.#onMessage(raw));
    ws.onClose(() => this.drop('closed', 1000));
  }

  /** Best effort: a control message to a socket that is closing is simply not sent. */
  post(message: RawMessage): void {
    if (!this.#ws.isOpen) return;
    try {
      this.#ws.send(JSON.stringify(message));
    } catch {
      /* closing underneath us; onClose does the bookkeeping */
    }
  }

  /**
   * A transport for a new CdpClient. There is one browser on the other end,
   * so there is one live transport: a newer one closes the last, which has
   * the extension let go of the old client's tabs first.
   */
  newTransport(epoch: number): ExtensionTransport {
    this.#transport?.close();
    this.#transport = new ExtensionTransport({
      post: (message) => {
        if (this.#gone || !this.#ws.isOpen) throw new Error('transport closed: the extension disconnected');
        this.#ws.send(JSON.stringify(message));
      },
      release: (closeTabs) => this.#release(closeTabs),
    }, epoch);
    return this.#transport;
  }

  drop(reason: string, code: number): void {
    if (this.#gone) return;
    this.#gone = true;
    clearInterval(this.#pingTimer);
    this.post({ bridge: 'bye', reason });
    this.#ws.close(code, reason);
    for (const done of [...this.#releases.values()]) done();
    this.#transport?.connectionLost();
    this.#opts.onGone(this, reason);
  }

  #onMessage(raw: string): void {
    let message: RawMessage;
    try {
      message = JSON.parse(raw) as RawMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    this.#lastSeen = this.#opts.now();
    if (typeof message.bridge !== 'string') {
      this.#transport?.deliver(message);
    } else if (message.bridge === 'released' || message.bridge === 'closed') {
      this.#releases.get(Number(message.ref))?.();
    } else if (message.bridge === 'created') {
      this.fileAccess = typeof message.fileAccess === 'boolean' ? message.fileAccess : null;
      this.#opts.onCreated?.(createdTabs(message.tabs));
      this.#opts.onStateChange();
    } else if (message.bridge === 'stop' && typeof message.targetId === 'string' && TARGET.test(message.targetId)) {
      this.#opts.onStop?.({ targetId: message.targetId });
    } else if (message.bridge === 'stopAll') {
      this.#opts.onStop?.({ all: true });
    } else if (message.bridge === 'state') {
      this.paused = message.paused === true;
      this.#opts.onStateChange();
    } else if (message.bridge === 'unpair') {
      this.#opts.onUnpair();
    }
  }

  #release(closeTabs: boolean): Promise<void> {
    return this.#acknowledged({ bridge: 'release', closeTabs });
  }

  /** Close these tabs, which the extension opened; it closes no other tab this way. */
  closeTabs(targetIds: readonly string[]): Promise<void> {
    return this.#acknowledged({ bridge: 'close', targetIds: targetIds.filter((id) => TARGET.test(id)) });
  }

  /** Sent, and resolved when the extension says it is done, or after a short wait. */
  #acknowledged(message: RawMessage): Promise<void> {
    if (this.#gone) return Promise.resolve();
    const ref = ++this.#releaseRef;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#releases.delete(ref);
        resolve();
      };
      // An extension that never acknowledges must not hang a shutdown.
      const timer = setTimeout(done, RELEASE_WAIT_MS);
      timer.unref?.();
      this.#releases.set(ref, done);
      this.post({ ...message, ref });
    });
  }
}
