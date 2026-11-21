/**
 * The server half of RFC 6455, for the one peer that has to dial in.
 *
 * Everything else here connects outward: a pipe to a Chrome we launched, or
 * Node's WebSocket client to a debugging port. A Chrome extension cannot be
 * dialled; its service worker can only open a WebSocket to us. So this is the
 * smallest server that a browser's WebSocket client will talk to: the
 * upgrade, masked client frames, fragmentation, ping/pong and close.
 *
 * Text frames only, no extensions, no subprotocols. Not offering
 * permessage-deflate is what lets every frame be read without inflating it.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Matches the pipe transport: a full-page observation is a few megabytes. */
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** A peer that never completes the close handshake is dropped after this. */
const CLOSE_GRACE_MS = 2_000;

export interface WsAcceptOptions {
  /** Largest reassembled message accepted; a larger one closes with 1009. */
  maxMessageBytes?: number;
}

export class WsHandshakeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WsHandshakeError';
    this.status = status;
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required', 503: 'Service Unavailable',
};

/** Answer an upgrade we will not accept, then hang up. */
export function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  // A reset from a peer that has already gone must not become an unhandled
  // 'error' on a socket nobody is listening to any more.
  socket.on('error', () => {});
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    (status === 426 ? 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' : '') +
    `\r\n${body}`,
  );
}

/**
 * Complete the opening handshake on a socket handed over by an http.Server
 * 'upgrade' event. Throws WsHandshakeError for a request that is not a
 * version-13 WebSocket upgrade; the caller decides what to answer.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: WsAcceptOptions = {},
): WsConnection {
  const header = (name: string): string => String(req.headers[name] ?? '');
  if (req.method !== 'GET') throw new WsHandshakeError(400, 'WebSocket upgrade must be a GET');
  if (header('upgrade').toLowerCase() !== 'websocket') throw new WsHandshakeError(400, 'not a WebSocket upgrade');
  if (!/(^|,)\s*upgrade\s*(,|$)/i.test(header('connection'))) {
    throw new WsHandshakeError(400, 'Connection header does not ask for an upgrade');
  }
  if (header('sec-websocket-version') !== '13') throw new WsHandshakeError(426, 'only WebSocket version 13 is supported');
  const key = header('sec-websocket-key');
  if (Buffer.from(key, 'base64').length !== 16) throw new WsHandshakeError(400, 'missing or malformed Sec-WebSocket-Key');

  const accept = createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsConnection(socket, head, opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
}

export class WsConnection {
  #socket: Duplex;
  #max: number;
  /** Unparsed bytes, kept as received: joining on every chunk is quadratic for a large frame. */
  #chunks: Buffer[] = [];
  #have = 0;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #inMessage = false;
  #closeSent = false;
  #closed = false;
  #graceTimer: NodeJS.Timeout | null = null;
  #onMessage: ((text: string) => void) | null = null;
  #onClose: ((code: number, reason: string) => void) | null = null;

  constructor(socket: Duplex, head: Buffer, maxMessageBytes: number) {
    this.#socket = socket;
    this.#max = maxMessageBytes;
    socket.on('data', (chunk: Buffer) => this.#ingest(chunk));
    socket.on('error', () => this.#finish(1006, 'socket error'));
    socket.on('close', () => this.#finish(1006, 'socket closed'));
    socket.on('end', () => this.#finish(1006, 'socket ended'));
    // A client may send its first frame in the same packet as the upgrade.
    // Deferred so the caller, which has not been handed this object yet, can
    // register onMessage before that frame is parsed.
    if (head.length) queueMicrotask(() => this.#ingest(head));
  }

  get isOpen(): boolean {
    return !this.#closed && !this.#closeSent;
  }

  onMessage(fn: (text: string) => void): void {
    this.#onMessage = fn;
  }

  /** Called exactly once. 1006 means the socket went away without a close frame. */
  onClose(fn: (code: number, reason: string) => void): void {
    this.#onClose = fn;
  }

  send(text: string): void {
    if (!this.isOpen) throw new Error('WebSocket is not open');
    this.#write(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed || this.#closeSent) return;
    this.#sendClose(code, reason);
    this.#graceTimer = setTimeout(() => this.#finish(code, reason), CLOSE_GRACE_MS);
    this.#graceTimer.unref?.();
  }

  #write(opcode: number, payload: Buffer): void {
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.#socket.write(header);
    this.#socket.write(payload);
  }

  #sendClose(code: number, reason: string): void {
    if (this.#closeSent) return;
    this.#closeSent = true;
    const text = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    try {
      this.#write(OP_CLOSE, payload);
    } catch {
      /* the socket is already gone; #finish reports it */
    }
  }

  /** A protocol violation: say why, then stop reading. */
  #fail(code: number, reason: string): void {
    this.#sendClose(code, reason);
    this.#finish(code, reason);
  }

  #finish(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#chunks = [];
    this.#fragments = [];
    this.#have = 0;
    this.#socket.end();
    // end() waits for the peer; a peer that is not reading would hold the
    // descriptor open for as long as it liked.
    const destroy = setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS);
    destroy.unref?.();
    this.#socket.once('close', () => clearTimeout(destroy));
    this.#onClose?.(code, reason);
  }

  #ingest(chunk: Buffer): void {
    if (this.#closed) return;
    this.#chunks.push(chunk);
    this.#have += chunk.length;
    while (!this.#closed && this.#readFrame()) { /* one frame per pass */ }
  }

  /** Make the first chunk at least `n` bytes long, without touching the rest. */
  #peek(n: number): Buffer | null {
    if (this.#have < n) return null;
    while (this.#chunks[0].length < n) {
      const merged = Buffer.concat([this.#chunks[0], this.#chunks[1]]);
      this.#chunks.splice(0, 2, merged);
    }
    return this.#chunks[0];
  }

  #take(n: number): Buffer {
    const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks);
    this.#chunks = all.length > n ? [all.subarray(n)] : [];
    this.#have -= n;
    return all.subarray(0, n);
  }

  #readFrame(): boolean {
    const start = this.#peek(2);
    if (!start) return false;
    const fin = (start[0] & 0x80) !== 0;
    const opcode = start[0] & 0x0f;
    if (start[0] & 0x70) return this.#violation(1002, 'reserved bits set without a negotiated extension');
    // RFC 6455 §5.1: a client MUST mask, and a server MUST close on one that does not.
    if (!(start[1] & 0x80)) return this.#violation(1002, 'client frames must be masked');

    let length = start[1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      const ext = this.#peek(4);
      if (!ext) return false;
      length = ext.readUInt16BE(2);
      headerLength = 4;
    } else if (length === 127) {
      const ext = this.#peek(10);
      if (!ext) return false;
      const wide = ext.readBigUInt64BE(2);
      // Refused from the header alone, before a single payload byte is buffered.
      if (wide > BigInt(this.#max)) return this.#violation(1009, 'message too large');
      length = Number(wide);
      headerLength = 10;
    }

    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) return this.#violation(1002, 'malformed control frame');
    if (!control && this.#fragmentBytes + length > this.#max) return this.#violation(1009, 'message too large');

    const total = headerLength + 4 + length;
    if (this.#have < total) return false;
    const frame = this.#take(total);
    const mask = frame.subarray(headerLength, headerLength + 4);
    const payload = Buffer.from(frame.subarray(headerLength + 4));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    switch (opcode) {
      case OP_TEXT:
        if (this.#inMessage) return this.#violation(1002, 'new message before the previous one finished');
        this.#inMessage = true;
        return this.#data(payload, fin);
      case OP_CONTINUATION:
        if (!this.#inMessage) return this.#violation(1002, 'continuation with nothing to continue');
        return this.#data(payload, fin);
      case OP_BINARY:
        return this.#violation(1003, 'binary frames are not supported');
      case OP_PING:
        if (!this.#closeSent) this.#write(OP_PONG, payload);
        return true;
      case OP_PONG:
        // Nothing here sends a ping, and RFC 6455 §5.5.3 lets a pong arrive unasked: ignored.
        return true;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.#sendClose(payload.length >= 2 ? code : 1000, '');
        this.#finish(code, reason);
        return false;
      }
      default:
        return this.#violation(1002, `unknown opcode ${opcode}`);
    }
  }

  #violation(code: number, reason: string): false {
    this.#fail(code, reason);
    return false;
  }

  #data(payload: Buffer, fin: boolean): boolean {
    this.#fragments.push(payload);
    this.#fragmentBytes += payload.length;
    if (!fin) return true;
    const whole = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#inMessage = false;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(whole);
    } catch {
      return this.#violation(1007, 'text frame is not valid UTF-8');
    }
    this.#onMessage?.(text);
    return true;
  }
}
