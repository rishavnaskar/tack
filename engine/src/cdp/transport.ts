/**
 * CDP pipe transport.
 *
 * We speak CDP over an anonymous pipe (Chrome's `--remote-debugging-pipe`)
 * rather than a loopback TCP port. A debugging port is reachable by any local
 * process and grants full control of the browser profile, including cookies;
 * a pipe is inherited only by us. This is the transport decision from
 * CONVERGENCE.md §2.4 and is the reason we launch Chrome as a child rather
 * than attaching to a running one.
 *
 * Wire format: NUL-delimited JSON, fd 3 = browser reads, fd 4 = browser writes.
 */

import type { Writable, Readable } from 'node:stream';

export type RawMessage = Record<string, unknown>;

/**
 * Largest single CDP frame we will buffer.
 *
 * A full-page DOMSnapshot on a heavy site is legitimately a few megabytes, so
 * the cap has to clear that. What it must not do is let a malformed or
 * compromised child grow our memory without bound by never sending the
 * terminating NUL.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class PipeTransport {
  #write: Writable;
  #read: Readable;
  #pending: Buffer = Buffer.alloc(0);
  #closed = false;
  #onMessage: ((m: RawMessage) => void) | null = null;
  #onClose: (() => void) | null = null;
  #onError: ((err: Error) => void) | null = null;

  constructor(write: Writable, read: Readable) {
    this.#write = write;
    this.#read = read;

    this.#read.on('data', (chunk: Buffer) => this.#ingest(chunk));
    this.#read.on('close', () => this.#handleClose());
    this.#read.on('end', () => this.#handleClose());
    this.#read.on('error', () => this.#handleClose());
    this.#write.on('error', () => this.#handleClose());
  }

  onMessage(fn: (m: RawMessage) => void): void {
    this.#onMessage = fn;
  }

  onClose(fn: () => void): void {
    this.#onClose = fn;
  }

  /** Protocol-level problems that are not a clean close. */
  onError(fn: (err: Error) => void): void {
    this.#onError = fn;
  }

  send(message: RawMessage): void {
    if (this.#closed) throw new Error('transport closed');
    this.#write.write(JSON.stringify(message));
    this.#write.write('\0');
  }

  close(): void {
    this.#handleClose();
  }

  #ingest(chunk: Buffer): void {
    const buf = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const end = buf.indexOf(0, start);
      if (end === -1) break;
      const slice = buf.subarray(start, end);
      start = end + 1;
      if (slice.length === 0) continue;
      let parsed: RawMessage;
      try {
        parsed = JSON.parse(slice.toString('utf8')) as RawMessage;
      } catch {
        // A malformed frame is a protocol bug, not a page concern. Drop it
        // rather than tearing down a live browser session.
        continue;
      }
      this.#onMessage?.(parsed);
    }
    const remainder = start === 0 ? buf : buf.subarray(start);
    if (remainder.length > MAX_FRAME_BYTES) {
      // Unbounded growth with no terminator means the other end is not
      // speaking the protocol. Tearing the connection down is the only safe
      // response; continuing would be an out-of-memory crash later.
      this.#onError?.(new Error(
        `CDP frame exceeded ${MAX_FRAME_BYTES} bytes with no terminator; closing the connection`,
      ));
      this.#handleClose();
      return;
    }
    this.#pending = remainder;
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = Buffer.alloc(0);
    this.#write.destroy();
    this.#read.destroy();
    this.#onClose?.();
  }
}
