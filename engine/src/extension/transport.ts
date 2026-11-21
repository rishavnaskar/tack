/**
 * The object a CdpClient sits on when the browser is the user's own Chrome.
 *
 * One of these is one client's use of the extension, not the socket itself.
 * The socket outlives it: closing a client detaches Fanfold from the user's
 * tabs but leaves the extension connected, so the next run does not wait out
 * a reconnect.
 */

import type { RawMessage } from '../cdp/transport.ts';
import type { Transport } from '../cdp/client.ts';

/**
 * Request ids are namespaced per transport. Every CdpClient counts from 1,
 * and a reply the extension was still producing for the previous client
 * would otherwise settle an unrelated request of the next one.
 */
const ID_SPACE = 2 ** 32;

export interface TransportLink {
  /** Throws once the socket to the extension is gone. */
  post(message: RawMessage): void;
  /** Ask the extension to let go of every tab; resolves when it has, or gives up waiting. */
  release(closeTabs: boolean): Promise<void>;
}

export class ExtensionTransport implements Transport {
  #link: TransportLink;
  #epoch: number;
  #closed = false;
  #onMessage: ((m: RawMessage) => void) | null = null;
  #onClose: (() => void) | null = null;

  constructor(link: TransportLink, epoch: number) {
    this.#link = link;
    this.#epoch = epoch;
  }

  get closed(): boolean {
    return this.#closed;
  }

  onMessage(fn: (m: RawMessage) => void): void {
    this.#onMessage = fn;
  }

  onClose(fn: () => void): void {
    this.#onClose = fn;
  }

  send(message: RawMessage): void {
    if (this.#closed) throw new Error('transport closed');
    const id = message.id;
    this.#link.post(typeof id === 'number' ? { ...message, id: this.#epoch * ID_SPACE + id } : message);
  }

  /** From the bridge: something the extension sent that is not bridge control. */
  deliver(message: RawMessage): void {
    if (this.#closed) return;
    const id = message.id;
    if (typeof id !== 'number') {
      this.#onMessage?.(message);
      return;
    }
    if (Math.floor(id / ID_SPACE) !== this.#epoch) return;
    this.#onMessage?.({ ...message, id: id % ID_SPACE });
  }

  /**
   * Detach from every tab and finish. `closeTabs` also closes the tabs
   * Fanfold opened itself; tabs the user put in the group are never closed.
   */
  async release(opts: { closeTabs?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#link.release(opts.closeTabs ?? false);
    } catch {
      /* the extension is already gone, which detaches everything by itself */
    }
    this.#onClose?.();
  }

  /**
   * Leaving debugger sessions attached behind a closed client would keep
   * Chrome's "is being debugged" bar up over tabs nothing is driving, so a
   * plain close lets go of them too. It does not wait for the extension:
   * the client's pending requests should fail now, not in two seconds.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void Promise.resolve().then(() => this.#link.release(false)).catch(() => {});
    this.#onClose?.();
  }

  /** From the bridge: the socket went away underneath this transport. */
  connectionLost(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.();
  }
}
