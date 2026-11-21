/**
 * The loopback bridge the Fanfold extension dials into.
 *
 * In "your Chrome" mode there is no browser for Fanfold to launch and no
 * debugging port to attach to: since M136 Chrome refuses remote debugging on
 * the default profile. What Chrome does allow is an extension the user
 * installed using chrome.debugger on tabs, so the extension connects here and
 * carries CDP for the tabs in its own tab group.
 *
 * Three things stand between a local process and the user's signed-in tabs:
 * the listener binds 127.0.0.1 only, an upgrade must carry a
 * chrome-extension:// Origin (which a web page cannot forge), and the
 * connection must then present a pairing code or the token one was exchanged
 * for (see pairing.ts), which nothing but the user's extension holds.
 */

import type { WsConnection } from '../cdp/ws-server.ts';
import type { RawMessage } from '../cdp/transport.ts';
import type { Logger } from '../lib/log.ts';
import { Pairing, refusal } from './pairing.ts';
import { ExtensionLink, type CreatedTab, type StopRequest } from './link.ts';
import { LoopbackListener, DEFAULT_EXTENSION_PORT, isDefaultPort } from './listener.ts';
import type { ExtensionTransport } from './transport.ts';
import type { KeyValueStore } from './store.ts';

export { DEFAULT_EXTENSION_PORT, PORT_ATTEMPTS } from './listener.ts';
export type { CreatedTab, StopRequest } from './link.ts';
const BRIDGE_PROTOCOL = 1;

export interface ExtensionBridgeOptions {
  /** Where the pairing survives a restart. */
  store: KeyValueStore;
  /** Defaults to FANFOLD_EXTENSION_PORT, then 47600. 0 picks a free port. */
  port?: number;
  /** Host suffixes the extension must refuse, from the site catalog. */
  denyHosts?: readonly string[];
  /** Fanfold's own origins ("http://127.0.0.1:4318"), which the extension must never work in. */
  ownOrigins?: readonly string[];
  maxMessageBytes?: number;
  logger?: Logger;
  now?: () => number;
  pingIntervalMs?: number;
  helloTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BridgeStatus {
  listening: boolean;
  port: number | null;
  paired: boolean;
  connected: boolean;
  extensionVersion: string | null;
  chromeVersion: string | null;
  /** The user dismissed Chrome's debugging bar; the extension refuses tabs until they resume it. */
  paused: boolean;
  /** When the pairing code on offer expires, or null when none is. */
  pairingExpiresAt: string | null;
  /** Whether Chrome lets the extension hand a page a file ("Allow access to file URLs"); null when not known. */
  fileAccess: boolean | null;
}

/** One tab Fanfold is using in the user's Chrome, as the extension's popup lists it. */
export interface TabInUse {
  targetId: string;
  url: string;
  /** What it is for: 'main', 'session', 'run' or 'import'. */
  owner: string;
  /** Kept open because something in it waits on the user. */
  waiting: boolean;
}

interface Waiter {
  resolve: (t: ExtensionTransport) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ExtensionBridge {
  #opts: ExtensionBridgeOptions;
  #pairing: Pairing;
  #now: () => number;
  #log: Logger | undefined;
  #listener: LoopbackListener;
  #port: number | null = null;
  #link: ExtensionLink | null = null;
  #denyHosts: string[];
  #ownOrigins: string[];
  #inUse: TabInUse[] = [];
  #createdListeners = new Set<(tabs: CreatedTab[]) => void>();
  #stopListeners = new Set<(request: StopRequest) => void>();
  #listeners = new Set<(status: BridgeStatus) => void>();
  #waiters = new Set<Waiter>();
  #epoch = 0;

  constructor(opts: ExtensionBridgeOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#pairing = new Pairing(opts.store, this.#now);
    this.#log = opts.logger?.child({ component: 'extension-bridge' });
    this.#denyHosts = [...(opts.denyHosts ?? [])];
    this.#ownOrigins = [...(opts.ownOrigins ?? [])];
    this.#listener = new LoopbackListener({
      maxMessageBytes: opts.maxMessageBytes,
      helloTimeoutMs: opts.helloTimeoutMs,
      onHello: (ws, origin, hello) => this.#onHello(ws, origin, hello),
    });
  }

  /** Start listening. Resolves with the port actually bound. */
  async start(): Promise<number> {
    if (this.#port !== null) return this.#port;
    const fromEnv = Number((this.#opts.env ?? process.env).FANFOLD_EXTENSION_PORT);
    const configured = Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536 ? fromEnv : DEFAULT_EXTENSION_PORT;
    this.#port = await this.#listener.start(this.#opts.port ?? configured);
    this.#log?.info('listening for the extension', { port: this.#port });
    this.#changed();
    return this.#port;
  }

  /** Hang up and stop listening. The pairing is kept. */
  async stop(): Promise<void> {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('the extension bridge was stopped'));
    }
    this.#waiters.clear();
    this.#link?.drop('shutdown', 1001);
    await this.#listener.stop();
    this.#port = null;
    this.#changed();
  }

  /**
   * A one-time code for the user to type into the extension. When the bridge
   * is not on a port the extension tries by itself, the port rides along
   * after an "@" so there is still only one thing to copy.
   */
  beginPairing(): { code: string; expiresAt: string } {
    if (this.#port === null) throw new Error('the extension bridge is not listening');
    const { code, expiresAt } = this.#pairing.begin();
    this.#changed();
    return { code: isDefaultPort(this.#port) ? code : `${code}@${this.#port}`, expiresAt };
  }

  cancelPairing(): void {
    this.#pairing.cancel();
    this.#changed();
  }

  /** Forget the paired extension and hang up on it. It has to be paired again to return. */
  unpair(): void {
    this.#pairing.unpair();
    this.#link?.drop('unpaired', 4001);
    this.#log?.info('extension unpaired');
    this.#changed();
  }

  /** Replace the deny-list, and tell a connected extension straight away. */
  setDenyHosts(hosts: readonly string[]): void {
    this.#denyHosts = [...hosts];
    this.#link?.post({ bridge: 'policy', denyHosts: this.#denyHosts, ownOrigins: this.#ownOrigins });
  }

  /** Fanfold's own pages moved (its server started on another port): the extension keeps out of them too. */
  setOwnOrigins(origins: readonly string[]): void {
    this.#ownOrigins = [...origins];
    this.#link?.post({ bridge: 'policy', denyHosts: this.#denyHosts, ownOrigins: this.#ownOrigins });
  }

  /** The tabs Fanfold is using in the user's Chrome: the extension shows them in its popup and counts them on its badge. */
  publishInUse(tabs: readonly TabInUse[]): void {
    this.#inUse = [...tabs];
    this.#link?.post({ bridge: 'inUse', tabs: this.#inUse });
  }

  /** Close tabs the extension opened for Fanfold. It refuses to close any other tab this way. */
  async closeTabs(targetIds: readonly string[]): Promise<void> {
    if (targetIds.length) await this.#link?.closeTabs(targetIds);
  }

  /** Called with the tabs the extension opened for Fanfold, each time it connects. */
  onCreated(fn: (tabs: CreatedTab[]) => void): () => void {
    this.#createdListeners.add(fn);
    return () => this.#createdListeners.delete(fn);
  }

  /** Called when the person presses Stop in the extension's popup. */
  onStop(fn: (request: StopRequest) => void): () => void {
    this.#stopListeners.add(fn);
    return () => this.#stopListeners.delete(fn);
  }

  status(): BridgeStatus {
    return {
      listening: this.#port !== null,
      port: this.#port,
      paired: this.#pairing.paired,
      connected: this.#link !== null,
      extensionVersion: this.#link?.extensionVersion ?? null,
      chromeVersion: this.#link?.chromeVersion ?? null,
      paused: this.#link?.paused ?? false,
      pairingExpiresAt: this.#pairing.pendingExpiresAt,
      fileAccess: this.#link?.fileAccess ?? null,
    };
  }

  /** Called with the new status whenever any field of it may have changed. */
  onChange(fn: (status: BridgeStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** A transport for a new CdpClient, or null while no extension is connected. */
  transport(): ExtensionTransport | null {
    return this.#link?.newTransport(++this.#epoch) ?? null;
  }

  /** As transport(), but waits for the extension to connect. */
  async waitForConnection(timeoutMs = 15_000): Promise<ExtensionTransport> {
    const ready = this.transport();
    if (ready) return ready;
    if (this.#port === null) throw new Error('the extension bridge is not listening');
    if (!this.#pairing.paired && !this.#pairing.pendingExpiresAt) {
      throw new Error('The Fanfold extension is not paired with this app yet. Pair it from Fanfold, then try again.');
    }
    return new Promise<ExtensionTransport>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(
            `The Fanfold extension did not connect within ${Math.round(timeoutMs / 1000)}s. ` +
            'Chrome may be closed, or the extension disabled.',
          ));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  /**
   * Nothing is routed anywhere until both ends have proven who they are:
   * Fanfold answers the hello with a proof the extension checks, and only
   * then does the extension send its own. See pairing.ts.
   */
  #onHello(ws: WsConnection, origin: string, hello: RawMessage): void {
    const refuse = (reason: string, message: string): void => {
      this.#log?.warn('extension refused', { reason });
      // A burnt or expired code changes what status() reports.
      this.#changed();
      if (!ws.isOpen) return;
      ws.send(JSON.stringify({ bridge: 'refused', reason, message }));
      ws.close(4401, reason);
    };
    const challenge = hello.bridge === 'hello' && hello.protocol === BRIDGE_PROTOCOL && this.#port !== null
      ? this.#pairing.challenge(hello, this.#port)
      : refusal('protocol');
    if (!challenge.ok) return refuse(challenge.reason, challenge.message);

    const timer = setTimeout(() => ws.close(4408, 'no auth'), this.#opts.helloTimeoutMs ?? 5_000);
    timer.unref?.();
    ws.onClose(() => clearTimeout(timer));
    ws.onMessage((raw) => {
      clearTimeout(timer);
      let auth: RawMessage = {};
      try {
        auth = JSON.parse(raw) as RawMessage;
      } catch {
        /* judged below as a wrong answer */
      }
      const outcome = challenge.answer(auth ?? {}, origin);
      if (!outcome.ok) return refuse(outcome.reason, outcome.message);
      this.#adopt(ws, hello, outcome.token);
    });
    ws.send(JSON.stringify(challenge.message));
  }

  #adopt(ws: WsConnection, hello: RawMessage, issuedToken: string | undefined): void {
    // Only now, with the newcomer proven, is the existing connection given
    // up: an unauthenticated socket must not be able to knock the real
    // extension off.
    this.#link?.drop('replaced', 4000);
    const link = new ExtensionLink(ws, hello, {
      now: this.#now,
      pingIntervalMs: this.#opts.pingIntervalMs ?? 20_000,
      onStateChange: () => this.#changed(),
      onUnpair: () => this.unpair(),
      onGone: (gone, reason) => {
        if (this.#link === gone) this.#link = null;
        this.#log?.info('extension disconnected', { reason });
        this.#changed();
      },
      onCreated: (tabs) => this.#tell(this.#createdListeners, tabs),
      onStop: (request) => this.#tell(this.#stopListeners, request),
    });
    this.#link = link;
    if (issuedToken) link.post({ bridge: 'paired', token: issuedToken });
    link.post({ bridge: 'ready', protocol: BRIDGE_PROTOCOL, denyHosts: this.#denyHosts, ownOrigins: this.#ownOrigins });
    if (this.#inUse.length) link.post({ bridge: 'inUse', tabs: this.#inUse });
    this.#log?.info('extension connected', { extensionVersion: link.extensionVersion, chrome: link.chromeVersion });

    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const [i, waiter] of waiters.entries()) {
      clearTimeout(waiter.timer);
      // One live transport per connection: only the last waiter can have it.
      if (i < waiters.length - 1) waiter.reject(new Error('transport closed: another caller took the extension connection'));
      else waiter.resolve(link.newTransport(++this.#epoch));
    }
    this.#changed();
  }

  #tell<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const fn of [...listeners]) {
      try {
        fn(value);
      } catch (err) {
        this.#log?.warn('a bridge listener threw', { err });
      }
    }
  }

  #changed(): void {
    const status = this.status();
    for (const fn of [...this.#listeners]) {
      try {
        fn(status);
      } catch (err) {
        // One broken subscriber must not stop the others hearing about it.
        this.#log?.warn('a bridge status listener threw', { err });
      }
    }
  }
}
