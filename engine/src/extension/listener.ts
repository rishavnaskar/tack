/**
 * The socket the extension dials, and everything that is refused before a
 * single message is read.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { acceptWebSocket, refuseUpgrade, WsHandshakeError, type WsConnection } from '../cdp/ws-server.ts';
import type { RawMessage } from '../cdp/transport.ts';

export const DEFAULT_EXTENSION_PORT = 47600;
/** The extension tries this many consecutive ports, starting at the default. */
export const PORT_ATTEMPTS = 5;
const BRIDGE_PATH = '/extension';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
/** Sockets that have upgraded but not yet said who they are. */
const MAX_UNAUTHENTICATED = 4;

export interface ListenerOptions {
  maxMessageBytes?: number;
  helloTimeoutMs?: number;
  /** The first message on a new socket. Nothing else has been read from it. */
  onHello: (ws: WsConnection, origin: string, hello: RawMessage) => void;
}

export function isDefaultPort(port: number): boolean {
  return port >= DEFAULT_EXTENSION_PORT && port < DEFAULT_EXTENSION_PORT + PORT_ATTEMPTS;
}

export class LoopbackListener {
  #opts: ListenerOptions;
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #unauthenticated = new Set<WsConnection>();

  constructor(opts: ListenerOptions) {
    this.#opts = opts;
  }

  /** Bind `base`, or the next few ports after it when it is taken. 0 picks a free one. */
  async start(base: number): Promise<number> {
    const attempts = base === 0 ? 1 : PORT_ATTEMPTS;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.#listen(base === 0 ? 0 : base + i);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error(
      `ports ${base} to ${base + attempts - 1} on 127.0.0.1 are all in use, so the Fanfold extension cannot connect. ` +
      'Free one, or set FANFOLD_EXTENSION_PORT.',
    );
  }

  #listen(port: number): Promise<number> {
    // Anything that is not the extension's upgrade learns nothing from asking.
    const server = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain', connection: 'close' });
      res.end('WebSocket only\n');
    });
    server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // The address is not configurable on purpose: this socket leads to the
      // user's signed-in browser, and nothing off this machine may reach it.
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.#server = server;
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.#unauthenticated) ws.close(1001, 'shutdown');
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close() waits for every open connection, and the extension keeps its
      // end open for as long as it can.
      for (const socket of this.#sockets) socket.destroy();
    });
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = String(req.headers.origin ?? '');
    if ((req.url ?? '').split('?')[0] !== BRIDGE_PATH) return refuseUpgrade(socket, 404, 'not found');
    // A page that rebinds its own hostname to 127.0.0.1 still sends that hostname here.
    if (!LOOPBACK_HOST.test(String(req.headers.host ?? ''))) return refuseUpgrade(socket, 403, 'loopback only');
    // A web page cannot choose its Origin, so no page can get past this line.
    // A local process can, which is what pairing is for.
    if (!EXTENSION_ORIGIN.test(origin)) return refuseUpgrade(socket, 403, 'only the Fanfold extension may connect');
    if (this.#unauthenticated.size >= MAX_UNAUTHENTICATED) return refuseUpgrade(socket, 503, 'busy');
    let ws: WsConnection;
    try {
      ws = acceptWebSocket(req, socket, head, { maxMessageBytes: this.#opts.maxMessageBytes });
    } catch (err) {
      return refuseUpgrade(socket, err instanceof WsHandshakeError ? err.status : 400, (err as Error).message);
    }
    this.#awaitHello(ws, origin);
  }

  #awaitHello(ws: WsConnection, origin: string): void {
    this.#unauthenticated.add(ws);
    const timer = setTimeout(() => ws.close(4408, 'no hello'), this.#opts.helloTimeoutMs ?? 5_000);
    timer.unref?.();
    ws.onClose(() => {
      clearTimeout(timer);
      this.#unauthenticated.delete(ws);
    });
    ws.onMessage((raw) => {
      clearTimeout(timer);
      this.#unauthenticated.delete(ws);
      let hello: RawMessage = {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') hello = parsed as RawMessage;
      } catch {
        /* an empty hello is refused by the caller as a protocol mismatch */
      }
      this.#opts.onHello(ws, origin, hello);
    });
  }
}
