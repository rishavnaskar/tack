/**
 * WebSocket CDP transport — the attach path.
 *
 * The pipe transport is the default because a debugging port is reachable by
 * any local process. This exists for the case where we did not launch the
 * browser ourselves and therefore cannot hold a pipe: an already-running
 * Chrome started with an ephemeral loopback port.
 *
 * Constraints that come with using it, and are enforced here:
 *  - loopback only. A debugging endpoint on a routable interface hands the
 *    profile to the network, and we refuse rather than warn.
 *  - the same CDP domain allow-list applies, since that lives in the client.
 *
 * Node's global WebSocket is used directly; no dependency.
 */

import type { RawMessage } from './transport.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

export class WebSocketTransport {
  #socket: WebSocket;
  #onMessage: ((m: RawMessage) => void) | null = null;
  #onClose: (() => void) | null = null;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (ev) => {
      let parsed: RawMessage;
      try {
        parsed = JSON.parse(String(ev.data)) as RawMessage;
      } catch {
        return;
      }
      this.#onMessage?.(parsed);
    });
    socket.addEventListener('close', () => this.#handleClose());
    socket.addEventListener('error', () => this.#handleClose());
  }

  static async connect(wsUrl: string): Promise<WebSocketTransport> {
    const parsed = new URL(wsUrl);
    if (!LOOPBACK.has(parsed.hostname)) {
      throw new Error(
        `refusing to connect to a CDP endpoint on ${parsed.hostname}: loopback only`,
      );
    }
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not connect to ${wsUrl}`)), { once: true });
    });
    return new WebSocketTransport(socket);
  }

  /** Discover the browser endpoint of a Chrome listening on a loopback port. */
  static async discover(port: number, host = '127.0.0.1'): Promise<string> {
    if (!LOOPBACK.has(host)) throw new Error(`refusing to probe a non-loopback host: ${host}`);
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Chrome at ${host}:${port} returned HTTP ${res.status}`);
    const info = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl in /json/version');
    return info.webSocketDebuggerUrl;
  }

  onMessage(fn: (m: RawMessage) => void): void {
    this.#onMessage = fn;
  }

  onClose(fn: () => void): void {
    this.#onClose = fn;
  }

  send(message: RawMessage): void {
    if (this.#closed) throw new Error('transport closed');
    this.#socket.send(JSON.stringify(message));
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      /* already closing */
    }
    this.#handleClose();
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.();
  }
}
